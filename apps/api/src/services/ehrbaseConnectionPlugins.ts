import axios from 'axios';
import { decodeJwt } from 'jose';
import { getActiveEhrbaseConnection, getConfig, type EhrbaseAuthPluginId, type EhrbaseConnection } from './configService';
import { logIntegrationCall } from './integrationCallLogService';

export interface EhrbaseRequestConfig {
  ehrbaseUrl: string;
  headers: Record<string, string>;
  auth?: { username: string; password: string };
  connection: EhrbaseConnection;
}

export interface HipLoginIdentity {
  issuer: string;
  subject: string;
  displayName?: string;
  email?: string;
  roles?: string[];
}

export interface EhrbaseConnectionAuthPlugin {
  id: EhrbaseAuthPluginId;
  displayName: string;
  createRequestConfig(connection: EhrbaseConnection): Promise<Pick<EhrbaseRequestConfig, 'headers' | 'auth'>>;
  authenticateLogin?(connection: EhrbaseConnection, credentials: { username: string; password: string }): Promise<HipLoginIdentity>;
  /** Only the hip-keycloak plugin implements this - see FhirPatientCreationResult's doc comment for why Patient creation is FHIR-native for a HIP connection instead of EHRbase's plain /ehr endpoint. */
  createFhirPatient?(connection: EhrbaseConnection, values: Record<string, unknown>): Promise<FhirPatientCreationResult>;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function cleanUrl(value: string): string {
  const url = value.trim().replace(/\/$/, '');
  if (!url) throw new Error('EHRbase URL is not configured');
  return url;
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  // A form runtime value for a coded/free-text field (e.g. Person's "Land",
  // a CodedWithOther/allowFreeText DV_CODED_TEXT) can arrive as a plain
  // string OR a {value|text|code} object depending on the widget - accept
  // either rather than silently dropping the field.
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return text(record.value) ?? text(record.text) ?? text(record.code);
  }
  return undefined;
}

// FHIR-required "male"/"female"/"other"/"unknown" vs. whatever a free-text
// German admin-gender field actually contains - best-effort only (Person
// (Basis) doesn't constrain this field to a fixed value set, so this can't
// be exhaustive; an already-FHIR-valid value passes through unchanged).
const GENDER_MAP: Record<string, string> = {
  männlich: 'male', mann: 'male', male: 'male', m: 'male',
  weiblich: 'female', frau: 'female', female: 'female', w: 'female', f: 'female',
  divers: 'other', other: 'other', o: 'other',
  unbekannt: 'unknown', unknown: 'unknown',
};

function normalizeGender(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return GENDER_MAP[value.trim().toLowerCase()] || value;
}

const INSURANCE_TYPE_SYSTEMS: Record<string, string> = {
  PKV: 'http://fhir.de/sid/pkv/kvid-10',
  GKV: 'http://fhir.de/sid/gkv/kvid-10',
};

export interface IsikPatientBuildResult { firstName: string; resource: Record<string, unknown>; }

/**
 * Maps a Person Form's submitted values (via connection.fhirPatientMapping's
 * generic field-name dictionary - so this works for whatever Person Form
 * Section is actually configured, not a hardcoded shape) into a working
 * ISiKPatient FHIR resource. Pure/no I/O - createFhirPatient below does the
 * actual network call. Field shapes (name._family/address._line ISO-21090
 * extensions, identifier.type coding) match a real accepted example from
 * the HIP FHIR connector, confirmed against apps/api/tests/hip-fhir-patient.test.js.
 */
export function buildIsikPatientResource(connection: EhrbaseConnection, values: Record<string, unknown>): IsikPatientBuildResult {
  const mapping = connection.fhirPatientMapping || {};
  const get = (key: string): string | undefined => {
    const fieldName = mapping[key];
    return fieldName ? text(values[fieldName]) : undefined;
  };

  const firstName = get('firstName') || '';
  const lastName = get('lastName');
  const insuranceNumber = get('insuranceNumber');
  const insuranceType = get('insuranceType');
  const gender = normalizeGender(get('gender'));
  const birthDate = get('birthDate');
  const street = get('street');
  const houseNumber = get('houseNumber');
  const city = get('city');
  const postalCode = get('postalCode');
  const country = get('country');

  const identifier: Record<string, unknown>[] = [];
  if (insuranceNumber) {
    const typeCode = insuranceType ? insuranceType.toUpperCase() : 'GKV';
    identifier.push({
      type: { coding: [{ system: 'http://fhir.de/CodeSystem/identifier-type-de-basis', code: typeCode }] },
      system: INSURANCE_TYPE_SYSTEMS[typeCode] || INSURANCE_TYPE_SYSTEMS.GKV,
      value: insuranceNumber,
    });
  }

  const name: Record<string, unknown> = { use: 'official' };
  if (lastName) {
    name.family = lastName;
    name._family = { extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/humanname-own-name', valueString: lastName }] };
  }
  if (firstName) name.given = [firstName];

  const address: Record<string, unknown> = {};
  const addressLine = [street, houseNumber].filter(Boolean).join(' ');
  if (addressLine) {
    address.type = 'both';
    address.line = [addressLine];
    const lineExtensions: Record<string, unknown>[] = [];
    if (street) lineExtensions.push({ url: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-streetName', valueString: street });
    if (houseNumber) lineExtensions.push({ url: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-houseNumber', valueString: houseNumber });
    if (lineExtensions.length) address._line = [{ extension: lineExtensions }];
  }
  if (city) address.city = city;
  if (postalCode) address.postalCode = postalCode;
  if (country) address.country = country;

  const resource: Record<string, unknown> = {
    resourceType: 'Patient',
    ...(connection.fhirPatientProfile ? { meta: { profile: [connection.fhirPatientProfile] } } : {}),
    ...(identifier.length ? { identifier } : {}),
    active: true,
    name: [name],
    ...(gender ? { gender } : {}),
    ...(birthDate ? { birthDate } : {}),
    ...(Object.keys(address).length ? { address: [address] } : {}),
  };

  return { firstName, resource };
}

/** The openEHR EHR id the FHIR connector auto-links to a created Patient -
 * confirmed live against the sandbox connector: a second `identifier` entry
 * with this exact system URI, distinct from the resource's own clinical
 * identifiers. */
const EHR_LINK_IDENTIFIER_SYSTEM = 'ehrbase://love.is.in.the.ehr';

export interface FhirPatientCreationResult {
  fhirPatientId: string;
  /** The linked openEHR EHR id, if the connector returned one (see EHR_LINK_IDENTIFIER_SYSTEM) - undefined if not present, never fabricated. */
  ehrId?: string;
  resource: Record<string, unknown>;
}

async function requestHipToken(connection: EhrbaseConnection, credentials?: { username: string; password: string }): Promise<{ token: string; expiresIn: number }> {
  const baseUrl = connection.keycloakBaseUrl?.trim().replace(/\/$/, '');
  if (!baseUrl || !connection.keycloakRealm || !connection.keycloakClientId) {
    throw new Error(`HIP / Keycloak configuration for EHRbase connection '${connection.name}' is incomplete`);
  }
  const grantType = connection.keycloakGrantType || 'password';
  const username = credentials?.username || connection.username;
  const password = credentials?.password || connection.password;
  if (grantType === 'password' && (!username || !password)) {
    throw new Error(`Credentials for EHRbase connection '${connection.name}' are not configured`);
  }
  const payload = new URLSearchParams({ grant_type: grantType, client_id: connection.keycloakClientId });
  if (grantType === 'password') {
    payload.set('username', username!);
    payload.set('password', password!);
  }
  try {
    const response = await axios.post(
      `${baseUrl}/auth/realms/${encodeURIComponent(connection.keycloakRealm)}/protocol/openid-connect/token`,
      payload.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10_000 },
    );
    const token = response.data?.access_token;
    if (typeof token !== 'string' || !token) throw new Error('Keycloak response did not contain an access token');
    return { token, expiresIn: Number(response.data?.expires_in || 300) };
  } catch (error: any) {
    const detail = error?.response?.data?.error_description || error?.message || 'Unknown error';
    throw new Error(`Failed to obtain HIP / Keycloak token: ${detail}`);
  }
}

/** Pure, unit-testable core of the HIP admin decision: which Keycloak realm/
 * client roles a decoded token carries. Split out of `authenticateLogin` so
 * it can be tested without a real Keycloak token endpoint. */
export function extractKeycloakRoles(claims: Record<string, unknown>, clientId: string | undefined): { realmRoles: string[]; clientRoles: string[] } {
  const realmRoles = Array.isArray((claims.realm_access as any)?.roles) ? (claims.realm_access as any).roles as string[] : [];
  const clientRoles = clientId && Array.isArray((claims.resource_access as any)?.[clientId]?.roles)
    ? (claims.resource_access as any)[clientId].roles as string[] : [];
  return { realmRoles, clientRoles };
}

/** Pure, unit-testable core of the HIP admin decision: whether a login should
 * be granted ADMIN, given the token's own roles and the Forms-side allowlist
 * (`FORMS_HIP_ADMIN_EMAILS`). Forms has no way to define "Forms admin" inside
 * EHRbase/Keycloak, so the allowlist exists as an explicit override alongside
 * best-effort detection of a role literally named like "admin" on the token. */
export function determineHipAdminAccess(input: { realmRoles: string[]; clientRoles: string[]; email?: string; subject: string; username: string; allowlist: string[] }): { isAdmin: boolean; tokenGrantsAdmin: boolean; allowlistGrantsAdmin: boolean } {
  const tokenGrantsAdmin = [...input.realmRoles, ...input.clientRoles].some((role) => /admin/i.test(role));
  const allowlistGrantsAdmin = input.allowlist.length > 0 && [input.email, input.subject, input.username]
    .some((value) => typeof value === 'string' && input.allowlist.includes(value.toLowerCase()));
  return { isAdmin: tokenGrantsAdmin || allowlistGrantsAdmin, tokenGrantsAdmin, allowlistGrantsAdmin };
}

const nonePlugin: EhrbaseConnectionAuthPlugin = { id: 'none', displayName: 'Keine Authentisierung', async createRequestConfig() { return { headers: {} }; } };
const basicPlugin: EhrbaseConnectionAuthPlugin = {
  id: 'basic', displayName: 'HTTP Basic Auth',
  async createRequestConfig(connection) {
    if (!connection.username || !connection.password) throw new Error(`Credentials for EHRbase connection '${connection.name}' are not configured`);
    return { headers: {}, auth: { username: connection.username, password: connection.password } };
  },
};

/** Shared by createRequestConfig and createFhirPatient - the FHIR CDR
 * connector accepts the same bearer token as EHRbase (same Keycloak
 * realm/client, confirmed live), so both just need the token itself, not
 * the EHRbase-shaped `{headers: {Accept, Content-Type: application/json}}`
 * envelope createRequestConfig returns. */
async function getHipBearerToken(connection: EhrbaseConnection): Promise<string> {
  const cached = tokenCache.get(connection.id);
  if (cached && Date.now() < cached.expiresAt - 10_000) return cached.token;
  const result = await requestHipToken(connection);
  tokenCache.set(connection.id, { token: result.token, expiresAt: Date.now() + result.expiresIn * 1000 });
  return result.token;
}

function describeFhirError(error: any): string {
  const issues = error?.response?.data?.issue;
  const diagnostics = Array.isArray(issues)
    ? issues.map((issue: any) => issue.diagnostics || issue.details?.text || issue.code).filter(Boolean).join('; ')
    : undefined;
  const status = error?.response?.status;
  return [status ? `HTTP ${status}` : undefined, diagnostics || error?.message].filter(Boolean).join(': ');
}

const hipKeycloakPlugin: EhrbaseConnectionAuthPlugin = {
  id: 'hip-keycloak', displayName: 'HIP / Keycloak OAuth2',
  async createRequestConfig(connection) {
    const token = await getHipBearerToken(connection);
    return { headers: { Authorization: `Bearer ${token}` } };
  },
  async createFhirPatient(connection, values) {
    if (!connection.fhirBaseUrl) throw new Error(`FHIR base URL for connection '${connection.name}' is not configured`);
    const token = await getHipBearerToken(connection);
    const { resource } = buildIsikPatientResource(connection, values);
    const baseUrl = connection.fhirBaseUrl.trim().replace(/\/$/, '');
    const url = `${baseUrl}/fhir/R4/Patient`;
    try {
      const response = await axios.post(url, resource, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/fhir+json' },
      });
      const data = response.data as Record<string, unknown>;
      const identifiers = Array.isArray(data.identifier) ? data.identifier as Array<Record<string, unknown>> : [];
      const ehrLink = identifiers.find((entry) => entry.system === EHR_LINK_IDENTIFIER_SYSTEM);
      const ehrId = typeof ehrLink?.value === 'string' ? ehrLink.value : undefined;
      logIntegrationCall({
        protocol: 'fhir', resourceType: 'Patient', operation: 'create', method: 'POST', url,
        requestBody: resource, responseBody: data, statusCode: response.status, success: true,
        ...(ehrId ? { ehrId } : {}), fhirPatientId: String(data.id),
      });
      return { fhirPatientId: String(data.id), ...(ehrId ? { ehrId } : {}), resource: data };
    } catch (error: any) {
      logIntegrationCall({
        protocol: 'fhir', resourceType: 'Patient', operation: 'create', method: 'POST', url,
        requestBody: resource, responseBody: error?.response?.data, statusCode: error?.response?.status,
        success: false, errorMessage: describeFhirError(error),
      });
      throw new Error(`Failed to create FHIR Patient on '${connection.name}': ${describeFhirError(error)}`);
    }
  },
  async authenticateLogin(connection, credentials) {
    // The Keycloak token endpoint is the authentication authority. The token is
    // used only to establish a Forms session and is never sent to the browser.
    const result = await requestHipToken(connection, credentials);
    let claims: Record<string, unknown> = {};
    try { claims = decodeJwt(result.token); } catch { /* opaque tokens still prove a successful Keycloak login */ }
    const baseUrl = connection.keycloakBaseUrl!.trim().replace(/\/$/, '');
    const subject = typeof claims.sub === 'string' && claims.sub ? claims.sub : credentials.username;
    const email = typeof claims.email === 'string' ? claims.email : undefined;

    const { realmRoles, clientRoles } = extractKeycloakRoles(claims, connection.keycloakClientId);
    const allowlist = getConfig().hipAdminIdentities || [];
    const access = determineHipAdminAccess({ realmRoles, clientRoles, email, subject, username: credentials.username, allowlist });

    // Logged every HIP login so the actual token shape (which realm/client
    // roles, if any, Keycloak is sending for this user) is visible in the API
    // logs - use this to see what's available before tightening the rule above.
    console.info('[AUTH][HIP] Keycloak login', { subject, email, realmRoles, clientRoles, ...access });

    return {
      issuer: `hip-keycloak:${baseUrl}/realms/${connection.keycloakRealm}`,
      subject,
      ...(typeof claims.name === 'string' ? { displayName: claims.name } : typeof claims.preferred_username === 'string' ? { displayName: claims.preferred_username } : { displayName: credentials.username }),
      ...(email ? { email } : {}),
      roles: access.isAdmin ? ['ADMIN'] : ['USER'],
    };
  },
};

/** Authentication mechanisms are isolated here. Adding one does not alter EHRbase callers. */
export const ehrbaseConnectionAuthPlugins: Record<EhrbaseAuthPluginId, EhrbaseConnectionAuthPlugin> = { none: nonePlugin, basic: basicPlugin, 'hip-keycloak': hipKeycloakPlugin };

export async function authenticateActiveHipLogin(username: string, password: string): Promise<HipLoginIdentity> {
  const connection = getActiveEhrbaseConnection();
  const plugin = ehrbaseConnectionAuthPlugins[connection.authPlugin];
  if (connection.authPlugin !== 'hip-keycloak' || !plugin?.authenticateLogin) throw new Error('The active system connection does not use HIP / Keycloak login');
  return plugin.authenticateLogin(connection, { username, password });
}

export async function getEhrbaseRequestConfig(connection = getActiveEhrbaseConnection()): Promise<EhrbaseRequestConfig> {
  const plugin = ehrbaseConnectionAuthPlugins[connection.authPlugin];
  if (!plugin) throw new Error(`Unknown EHRbase authentication plugin '${connection.authPlugin}'`);
  const authConfig = await plugin.createRequestConfig(connection);
  return { ehrbaseUrl: cleanUrl(connection.url), headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authConfig.headers }, ...(authConfig.auth ? { auth: authConfig.auth } : {}), connection };
}

export async function getActiveEhrbaseBearerToken(): Promise<string> {
  const config = await getEhrbaseRequestConfig();
  const header = config.headers.Authorization;
  if (!header?.startsWith('Bearer ')) throw new Error('The active EHRbase connection does not use bearer authentication');
  return header.slice('Bearer '.length);
}

/** A ready-to-send `Authorization` header value for the active EHRbase
 * connection, covering both bearer (HIP/Keycloak) and Basic Auth plugins, or
 * `undefined` for the `none` plugin. For handing a pre-resolved header to
 * plugin action handlers that need to call EHRbase themselves, so they don't
 * need their own copy of the connection-plugin/credential logic. */
export async function resolveActiveEhrbaseAuthorizationHeader(): Promise<string | undefined> {
  const config = await getEhrbaseRequestConfig();
  if (config.headers.Authorization) return config.headers.Authorization;
  if (config.auth) return `Basic ${Buffer.from(`${config.auth.username}:${config.auth.password}`).toString('base64')}`;
  return undefined;
}
