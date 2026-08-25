import axios from 'axios';
import { decodeJwt } from 'jose';
import { getActiveEhrbaseConnection, getConfig, type EhrbaseAuthPluginId, type EhrbaseConnection } from './configService';

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
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function cleanUrl(value: string): string {
  const url = value.trim().replace(/\/$/, '');
  if (!url) throw new Error('EHRbase URL is not configured');
  return url;
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

const hipKeycloakPlugin: EhrbaseConnectionAuthPlugin = {
  id: 'hip-keycloak', displayName: 'HIP / Keycloak OAuth2',
  async createRequestConfig(connection) {
    const cached = tokenCache.get(connection.id);
    if (cached && Date.now() < cached.expiresAt - 10_000) return { headers: { Authorization: `Bearer ${cached.token}` } };
    const result = await requestHipToken(connection);
    tokenCache.set(connection.id, { token: result.token, expiresAt: Date.now() + result.expiresIn * 1000 });
    return { headers: { Authorization: `Bearer ${result.token}` } };
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
