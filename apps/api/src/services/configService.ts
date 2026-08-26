import fs from 'fs';
import path from 'path';

/** `disabled-development-only` is intentionally explicit and is rejected in production. */
export type UserAuthMode = 'local' | 'hip' | 'disabled-development-only';
export type EhrbaseAuthPluginId = 'none' | 'basic' | 'hip-keycloak';

/** A separately selectable openEHR endpoint. Secrets are persisted server-side
 * and are masked before this model is returned through the settings API. */
export interface EhrbaseConnection {
    id: string;
    name: string;
    url: string;
    authPlugin: EhrbaseAuthPluginId;
    username?: string;
    password?: string;
    keycloakBaseUrl?: string;
    keycloakRealm?: string;
    keycloakClientId?: string;
    keycloakGrantType?: string;
    subjectNamespace?: string;
    defaultEhrId?: string;
}

export interface AppConfig {
    ehrbaseUrl?: string;
    ehrbaseUser?: string;
    ehrbasePass?: string;
    ehrbaseSubjectNamespace?: string;
    ehrbaseConnections?: EhrbaseConnection[];
    activeEhrbaseConnectionId?: string;
    authMode?: 'basic' | 'keycloak';
    keycloakApi?: string;
    keycloakTenantName?: string;
    keycloakClientId?: string;
    pluginSettings?: Record<string, Record<string, unknown>>;
    keycloakGrantType?: string;
    mappingServiceApi?: string;
    pluginPackages?: string[];
    userAuthMode?: UserAuthMode;
    sessionLifetimeMinutes?: number;
    bootstrapAdminUsername?: string;
    bootstrapAdminPassword?: string;
    bootstrapAdminDisplayName?: string;
    bootstrapAdminEmail?: string;
    /** Emails/subjects that are always granted ADMIN on HIP / Keycloak login,
     * regardless of what the Keycloak token's own role claims say. Forms has
     * no way to define "Forms admin" inside EHRbase/Keycloak, so this is the
     * explicit override for that gap. Comma-separated, case-insensitive. */
    hipAdminIdentities?: string[];
    localUsername?: string;
    localPassword?: string;
    defaultEhrId?: string;
    sessionCookieSecure?: boolean;
    patientRegistryAql?: string;
    patientRegistryPersonTemplateId?: string;
    scriptAiBaseUrl?: string;
    scriptAiApiKey?: string;
    scriptAiModel?: string;
    /** Whether a Composition's grouped save must land as one real openEHR
     * CONTRIBUTION, or may fall back to a best-effort sequential per-form
     * save when the active provider doesn't support Contribution. This is
     * the org-wide default; an individual Composition's own
     * `requireAtomicCommit` setting (in its canonical_json extension)
     * overrides it. Defaults to `true` (never silently non-atomic) -
     * matches the behavior every Composition already had before this
     * setting existed. */
    requireAtomicCommitByDefault?: boolean;
    /** Org-wide fallback for a form's own `settings.runtime.autosaveEnabled`/
     * `autosaveDebounceMs` - see LiveForm.tsx's debounced draft autosave.
     * Defaults preserve the behavior every form already had before these
     * settings existed (autosave on, 2500ms after the last edit). */
    autosaveEnabledByDefault?: boolean;
    autosaveDebounceMsDefault?: number;
}

/** Comma-separated env value -> lowercase, trimmed, de-blanked list. Shared
 * shape for every "list of admin identities" env var (currently just
 * FORMS_HIP_ADMIN_EMAILS); pure so it's unit-testable on its own. */
export function parseAdminAllowlist(value: string | undefined): string[] {
  return (value || '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function getCandidateConfigFiles(): string[] {
  const candidates: string[] = [];
  if (process.env.DATA_DIR) {
    candidates.push(path.join(process.env.DATA_DIR, 'config.json'));
  }
  candidates.push(path.resolve(__dirname, '..', '..', '..', 'data', 'config.json'));
  candidates.push(path.resolve(__dirname, '..', '..', 'data', 'config.json'));
  candidates.push(path.resolve(process.cwd(), 'data', 'config.json'));
  candidates.push(path.resolve(process.cwd(), '..', 'data', 'config.json'));
  candidates.push(path.resolve(process.cwd(), '.data', 'config.json'));
  return Array.from(new Set(candidates));
}

function getSaveConfigFile(): string {
  const candidates = getCandidateConfigFiles();
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  return candidates[0];
}

let persistedConfig: AppConfig = {};

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeConnection(value: unknown): EhrbaseConnection | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const id = stringValue(raw.id);
  const url = stringValue(raw.url);
  if (!id || !url) return undefined;
  const plugin = raw.authPlugin === 'basic' || raw.authPlugin === 'hip-keycloak' || raw.authPlugin === 'none'
    ? raw.authPlugin : 'none';
  return {
    id,
    name: stringValue(raw.name) || id,
    url,
    authPlugin: plugin,
    ...(stringValue(raw.username) ? { username: stringValue(raw.username) } : {}),
    ...(stringValue(raw.password) ? { password: stringValue(raw.password) } : {}),
    ...(stringValue(raw.keycloakBaseUrl) ? { keycloakBaseUrl: stringValue(raw.keycloakBaseUrl) } : {}),
    ...(stringValue(raw.keycloakRealm) ? { keycloakRealm: stringValue(raw.keycloakRealm) } : {}),
    ...(stringValue(raw.keycloakClientId) ? { keycloakClientId: stringValue(raw.keycloakClientId) } : {}),
    ...(stringValue(raw.keycloakGrantType) ? { keycloakGrantType: stringValue(raw.keycloakGrantType) } : {}),
    ...(stringValue(raw.subjectNamespace) ? { subjectNamespace: stringValue(raw.subjectNamespace) } : {}),
    ...(stringValue(raw.defaultEhrId) ? { defaultEhrId: stringValue(raw.defaultEhrId) } : {}),
  };
}

function legacyConnection(): EhrbaseConnection {
  const url = persistedConfig.ehrbaseUrl || process.env.EHRBASE_URL || 'http://localhost:8080/ehrbase/rest/openehr/v1';
  const authPlugin: EhrbaseAuthPluginId = (persistedConfig.authMode || process.env.AUTH_MODE) === 'keycloak'
    ? 'hip-keycloak'
    : (persistedConfig.ehrbasePass || process.env.EHRBASE_PASS ? 'basic' : 'none');
  return {
    id: 'legacy-current',
    name: 'Aktuelles System',
    url,
    authPlugin,
    username: persistedConfig.ehrbaseUser || process.env.EHRBASE_USER,
    password: persistedConfig.ehrbasePass || process.env.EHRBASE_PASS,
    keycloakBaseUrl: persistedConfig.keycloakApi || process.env.KEYCLOAK_API,
    keycloakRealm: persistedConfig.keycloakTenantName || process.env.KEYCLOAK_TENANT_NAME,
    keycloakClientId: persistedConfig.keycloakClientId || process.env.KEYCLOAK_CLIENT_ID,
    keycloakGrantType: persistedConfig.keycloakGrantType || process.env.KEYCLOAK_GRANT_TYPE || 'password',
    subjectNamespace: persistedConfig.ehrbaseSubjectNamespace || process.env.EHRBASE_SUBJECT_NAMESPACE || 'default',
    defaultEhrId: persistedConfig.defaultEhrId || process.env.DEFAULT_EHR_ID || process.env.EHRBASE_DEFAULT_EHR_ID,
  };
}

/** Returns saved connections, while presenting a legacy installation as one
 * HIP/Basic/no-auth connection until it is first saved from the new settings UI. */
export function getEhrbaseConnections(): EhrbaseConnection[] {
  const saved = Array.isArray(persistedConfig.ehrbaseConnections)
    ? persistedConfig.ehrbaseConnections.map(normalizeConnection).filter((value): value is EhrbaseConnection => Boolean(value))
    : [];
  const configured = saved.length ? saved : [legacyConnection()];
  // Debug EHRbase is injected only while the explicit development profile is
  // active. It is never written into the operator-managed config file.
  const debugUrl = process.env.DEBUG_EHRBASE_URL?.trim().replace(/\/$/, '');
  if (!debugUrl || configured.some((connection) => connection.id === 'debug-ehrbase')) return configured;
  return [...configured, { id: 'debug-ehrbase', name: 'Lokale Debug-EHRbase', url: `${debugUrl}/ehrbase/rest/openehr/v1`, authPlugin: 'none', subjectNamespace: 'debug' }];
}

export function getActiveEhrbaseConnection(): EhrbaseConnection {
  const connections = getEhrbaseConnections();
  if (process.env.DEBUG_EHRBASE_ACTIVE === 'true') {
    const debug = connections.find((connection) => connection.id === 'debug-ehrbase');
    if (debug) return debug;
  }
  return connections.find((connection) => connection.id === persistedConfig.activeEhrbaseConnectionId) || connections[0];
}

function mergeMaskedConnections(updates: unknown): EhrbaseConnection[] | undefined {
  if (!Array.isArray(updates)) return undefined;
  // The injected debug connection is runtime-only and must never consume one
  // of the two persisted operator connection slots.
  const persistedUpdates = updates.filter((entry) => (entry as Record<string, unknown>)?.id !== 'debug-ehrbase');
  if (persistedUpdates.length === 0 || persistedUpdates.length > 2) throw new Error('Configure one or two EHRbase connections');
  const existing = new Map(getEhrbaseConnections().map((connection) => [connection.id, connection]));
  const ids = new Set<string>();
  return persistedUpdates.map((entry) => {
    const normalized = normalizeConnection(entry);
    if (!normalized) throw new Error('Every EHRbase connection requires an id and URL');
    if (ids.has(normalized.id)) throw new Error('EHRbase connection IDs must be unique');
    ids.add(normalized.id);
    const raw = entry as Record<string, unknown>;
    const previous = existing.get(normalized.id);
    if (raw.password === '***' && previous?.password) normalized.password = previous.password;
    return normalized;
  });
}

function safeConnection(connection: EhrbaseConnection): EhrbaseConnection {
  return { ...connection, password: connection.password ? '***' : '' };
}

export function initConfig() {
  const candidates = getCandidateConfigFiles();
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
        persistedConfig = { ...persistedConfig, ...loaded };
        console.log("Loaded AppConfig overrides from file:", file);
      } catch (e) {
        console.error("Failed to parse config file:", file, e);
      }
    }
  }
}

export function getConfig(): AppConfig {
    const resolve = (persisted: string | undefined, env: string | undefined, fallback?: string) => {
        if (persisted !== undefined && persisted.trim() !== '') return persisted;
        if (env !== undefined && env.trim() !== '') return env;
        return fallback;
    };

    const activeConnection = getActiveEhrbaseConnection();
    return {
        ehrbaseUrl: activeConnection.url,
        ehrbaseUser: activeConnection.username,
        // Never ship a usable credential in source code. Operators must configure this
        // explicitly through the environment, a secret store, or the admin UI.
        ehrbasePass: activeConnection.password,
        ehrbaseSubjectNamespace: activeConnection.subjectNamespace || 'default',
        authMode: activeConnection.authPlugin === 'hip-keycloak' ? 'keycloak' : 'basic',
        keycloakApi: activeConnection.keycloakBaseUrl,
        keycloakTenantName: activeConnection.keycloakRealm,
        keycloakClientId: activeConnection.keycloakClientId,
        keycloakGrantType: activeConnection.keycloakGrantType || 'password',
        mappingServiceApi: resolve(persistedConfig.mappingServiceApi, process.env.MAPPING_SERVICE_API),
        pluginPackages: Array.isArray(persistedConfig.pluginPackages) ? persistedConfig.pluginPackages.filter((value): value is string => typeof value === 'string') : [],
        userAuthMode: resolve(persistedConfig.userAuthMode, process.env.USER_AUTH_MODE, 'local') as UserAuthMode,
        sessionLifetimeMinutes: Number(resolve(persistedConfig.sessionLifetimeMinutes?.toString(), process.env.SESSION_LIFETIME_MINUTES, '480')) || 480,
        // Legacy values are only used once by the bootstrap migration path; no
        // local credential is ever read by request-time authentication.
        localUsername: resolve(persistedConfig.localUsername, process.env.LOCAL_AUTH_USERNAME),
        localPassword: resolve(undefined, process.env.LOCAL_AUTH_PASSWORD),
        bootstrapAdminUsername: resolve(undefined, process.env.FORMS_BOOTSTRAP_ADMIN_USERNAME),
        bootstrapAdminPassword: resolve(undefined, process.env.FORMS_BOOTSTRAP_ADMIN_PASSWORD),
        bootstrapAdminDisplayName: resolve(undefined, process.env.FORMS_BOOTSTRAP_ADMIN_DISPLAY_NAME),
        bootstrapAdminEmail: resolve(undefined, process.env.FORMS_BOOTSTRAP_ADMIN_EMAIL),
        hipAdminIdentities: parseAdminAllowlist(resolve(undefined, process.env.FORMS_HIP_ADMIN_EMAILS)),
        defaultEhrId: activeConnection.defaultEhrId,
        sessionCookieSecure: resolve(undefined, process.env.SESSION_COOKIE_SECURE, 'false') === 'true',
        patientRegistryPersonTemplateId: resolve(persistedConfig.patientRegistryPersonTemplateId, process.env.PATIENT_REGISTRY_PERSON_TEMPLATE_ID, 'vg_Person.v1.1.1'),
        patientRegistryAql: resolve(persistedConfig.patientRegistryAql, process.env.PATIENT_REGISTRY_AQL, "SELECT e/ehr_id/value AS ehrId, c/content[openEHR-EHR-ADMIN_ENTRY.person_data.v0]/data[at0001]/items[openEHR-EHR-CLUSTER.person.v1 and name/value='Person']/items[openEHR-EHR-CLUSTER.structured_name.v1 and name/value='Name']/items[at0002]/value/value AS firstName, c/content[openEHR-EHR-ADMIN_ENTRY.person_data.v0]/data[at0001]/items[openEHR-EHR-CLUSTER.person.v1 and name/value='Person']/items[openEHR-EHR-CLUSTER.structured_name.v1 and name/value='Name']/items[at0005 and name/value='Familienname']/value/value AS lastName, c/content[openEHR-EHR-ADMIN_ENTRY.person_data.v0]/data[at0001]/items[openEHR-EHR-CLUSTER.person_birth_data_iso.v0]/items[at0001]/value/value AS birthDate, c/content[openEHR-EHR-EVALUATION.gender.v1]/data[at0002]/items[at0022]/value/value AS gender, c/context/start_time/value AS recordedAt FROM EHR e CONTAINS COMPOSITION c WHERE c/archetype_details/template_id/value = :personTemplateId ORDER BY c/context/start_time/value DESC"),
        scriptAiBaseUrl: resolve(persistedConfig.scriptAiBaseUrl, process.env.FORM_SCRIPT_AI_BASE_URL),
        scriptAiApiKey: resolve(undefined, process.env.FORM_SCRIPT_AI_API_KEY || process.env.OPENAI_API_KEY),
        scriptAiModel: resolve(persistedConfig.scriptAiModel, process.env.FORM_SCRIPT_AI_MODEL),
        ehrbaseConnections: getEhrbaseConnections(),
        activeEhrbaseConnectionId: activeConnection.id,
        requireAtomicCommitByDefault: persistedConfig.requireAtomicCommitByDefault ?? true,
        autosaveEnabledByDefault: persistedConfig.autosaveEnabledByDefault ?? true,
        autosaveDebounceMsDefault: persistedConfig.autosaveDebounceMsDefault ?? 2500,
    };
}

export function saveConfig(updates: AppConfig) {
    const cleanUpdates = { ...updates };
    const connections = mergeMaskedConnections(cleanUpdates.ehrbaseConnections);
    if (connections) {
      cleanUpdates.ehrbaseConnections = connections;
      const activeId = typeof cleanUpdates.activeEhrbaseConnectionId === 'string'
        ? cleanUpdates.activeEhrbaseConnectionId : persistedConfig.activeEhrbaseConnectionId;
      if (!activeId || !connections.some((connection) => connection.id === activeId)) {
        cleanUpdates.activeEhrbaseConnectionId = connections[0].id;
      }
    }
    // Filter out masked passwords
    Object.keys(cleanUpdates).forEach(key => {
        if ((cleanUpdates as any)[key] === '***') {
            delete (cleanUpdates as any)[key];
        }
    });
    // Authentication secrets are supplied through the environment/secret store,
    // never persisted in the editable JSON configuration.
    delete (cleanUpdates as any).localPassword;
    delete (cleanUpdates as any).hipIssuerUrl;
    delete (cleanUpdates as any).hipAuthorizationUrl;
    delete (cleanUpdates as any).hipTokenUrl;
    delete (cleanUpdates as any).hipUserInfoUrl;
    delete (cleanUpdates as any).hipClientId;
    delete (cleanUpdates as any).hipClientSecret;
    delete (cleanUpdates as any).hipRedirectUri;
    delete (cleanUpdates as any).hipScopes;
    delete (cleanUpdates as any).scriptAiApiKey;
    delete (cleanUpdates as any).bootstrapAdminPassword;

    persistedConfig = { ...persistedConfig, ...cleanUpdates };

    const targetFile = getSaveConfigFile();
    const targetDir = path.dirname(targetFile);
    if (!fs.existsSync(targetDir)) {
        try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
    }
    fs.writeFileSync(targetFile, JSON.stringify(persistedConfig, null, 2), 'utf8');
}

export function getPluginSettings(pluginId: string): Record<string, unknown> {
    const stored = persistedConfig.pluginSettings?.[pluginId];
    return stored && typeof stored === 'object' && !Array.isArray(stored) ? { ...stored } : {};
}

export function savePluginSettings(pluginId: string, updates: Record<string, unknown>): void {
    const current = getPluginSettings(pluginId);
    const next = { ...current };
    for (const [key, value] of Object.entries(updates)) {
        // A masked value means that an existing secret stays unchanged.
        if (value === '***') continue;
        next[key] = value;
    }
    persistedConfig = {
        ...persistedConfig,
        pluginSettings: {
            ...(persistedConfig.pluginSettings || {}),
            [pluginId]: next,
        },
    };
    const targetFile = getSaveConfigFile();
    const targetDir = path.dirname(targetFile);
    if (!fs.existsSync(targetDir)) {
        try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {}
    }
    fs.writeFileSync(targetFile, JSON.stringify(persistedConfig, null, 2), 'utf8');
}

export function getSafePluginSettings(pluginId: string, secretKeys: readonly string[] = []): Record<string, unknown> {
    const secretSet = new Set(secretKeys);
    const stored = getPluginSettings(pluginId);
    return Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, secretSet.has(key) ? (value ? '***' : '') : value]));
}

export function getSafeConfig(): Partial<AppConfig> {
    const full = getConfig();
    const activeConnection = getActiveEhrbaseConnection();
    return {
        // Legacy fields remain available to older clients but mirror the active
        // connection. New callers use ehrbaseConnections instead.
        ehrbaseUrl: activeConnection.url,
        ehrbaseUser: activeConnection.username || '',
        ehrbasePass: activeConnection.password ? '***' : '',
        ehrbaseSubjectNamespace: activeConnection.subjectNamespace || 'default',
        authMode: activeConnection.authPlugin === 'hip-keycloak' ? 'keycloak' : 'basic',
        keycloakApi: activeConnection.keycloakBaseUrl || '',
        keycloakTenantName: activeConnection.keycloakRealm || '',
        keycloakClientId: activeConnection.keycloakClientId || '',
        keycloakGrantType: activeConnection.keycloakGrantType || '',
        ehrbaseConnections: full.ehrbaseConnections?.map(safeConnection) || [],
        activeEhrbaseConnectionId: activeConnection.id,
        mappingServiceApi: full.mappingServiceApi || '',
        pluginPackages: full.pluginPackages || [],
        userAuthMode: full.userAuthMode || 'local',
        sessionLifetimeMinutes: full.sessionLifetimeMinutes || 480,
        localUsername: full.localUsername || '',
        localPassword: full.localPassword ? '***' : '',
        defaultEhrId: activeConnection.defaultEhrId || full.defaultEhrId || '',
        sessionCookieSecure: full.sessionCookieSecure || false,
        patientRegistryPersonTemplateId: full.patientRegistryPersonTemplateId || 'vg_Person.v1.1.1',
        patientRegistryAql: full.patientRegistryAql || '',
        scriptAiBaseUrl: full.scriptAiBaseUrl || '',
        scriptAiApiKey: full.scriptAiApiKey ? '***' : '',
        scriptAiModel: full.scriptAiModel || '',
        requireAtomicCommitByDefault: full.requireAtomicCommitByDefault ?? true,
        autosaveEnabledByDefault: full.autosaveEnabledByDefault ?? true,
        autosaveDebounceMsDefault: full.autosaveDebounceMsDefault ?? 2500,
    };
}
