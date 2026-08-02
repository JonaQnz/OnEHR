import fs from 'fs';
import path from 'path';

export type UserAuthMode = 'local' | 'hip';
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
    localUsername?: string;
    localPassword?: string;
    hipIssuerUrl?: string;
    hipAuthorizationUrl?: string;
    hipTokenUrl?: string;
    hipUserInfoUrl?: string;
    hipClientId?: string;
    hipClientSecret?: string;
    hipRedirectUri?: string;
    hipScopes?: string;
    defaultEhrId?: string;
    sessionCookieSecure?: boolean;
    scriptAiBaseUrl?: string;
    scriptAiApiKey?: string;
    scriptAiModel?: string;
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
  return saved.length ? saved : [legacyConnection()];
}

export function getActiveEhrbaseConnection(): EhrbaseConnection {
  const connections = getEhrbaseConnections();
  return connections.find((connection) => connection.id === persistedConfig.activeEhrbaseConnectionId) || connections[0];
}

function mergeMaskedConnections(updates: unknown): EhrbaseConnection[] | undefined {
  if (!Array.isArray(updates)) return undefined;
  if (updates.length === 0 || updates.length > 2) throw new Error('Configure one or two EHRbase connections');
  const existing = new Map(getEhrbaseConnections().map((connection) => [connection.id, connection]));
  const ids = new Set<string>();
  return updates.map((entry) => {
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
        localUsername: resolve(persistedConfig.localUsername, process.env.LOCAL_AUTH_USERNAME),
        localPassword: resolve(undefined, process.env.LOCAL_AUTH_PASSWORD),
        hipIssuerUrl: resolve(persistedConfig.hipIssuerUrl, process.env.HIP_ISSUER_URL),
        hipAuthorizationUrl: resolve(persistedConfig.hipAuthorizationUrl, process.env.HIP_AUTHORIZATION_URL),
        hipTokenUrl: resolve(persistedConfig.hipTokenUrl, process.env.HIP_TOKEN_URL),
        hipUserInfoUrl: resolve(persistedConfig.hipUserInfoUrl, process.env.HIP_USERINFO_URL),
        hipClientId: resolve(persistedConfig.hipClientId, process.env.HIP_CLIENT_ID),
        hipClientSecret: resolve(undefined, process.env.HIP_CLIENT_SECRET),
        hipRedirectUri: resolve(persistedConfig.hipRedirectUri, process.env.HIP_REDIRECT_URI, 'http://localhost:3001/api/auth/callback/hip'),
        hipScopes: resolve(persistedConfig.hipScopes, process.env.HIP_SCOPES, 'openid profile email'),
        defaultEhrId: activeConnection.defaultEhrId,
        sessionCookieSecure: resolve(undefined, process.env.SESSION_COOKIE_SECURE, 'false') === 'true',
        scriptAiBaseUrl: resolve(persistedConfig.scriptAiBaseUrl, process.env.FORM_SCRIPT_AI_BASE_URL),
        scriptAiApiKey: resolve(undefined, process.env.FORM_SCRIPT_AI_API_KEY || process.env.OPENAI_API_KEY),
        scriptAiModel: resolve(persistedConfig.scriptAiModel, process.env.FORM_SCRIPT_AI_MODEL),
        ehrbaseConnections: getEhrbaseConnections(),
        activeEhrbaseConnectionId: activeConnection.id,
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
    delete (cleanUpdates as any).hipClientSecret;
    delete (cleanUpdates as any).scriptAiApiKey;

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
        localUsername: full.localUsername || '',
        localPassword: full.localPassword ? '***' : '',
        hipIssuerUrl: full.hipIssuerUrl || '',
        hipAuthorizationUrl: full.hipAuthorizationUrl || '',
        hipTokenUrl: full.hipTokenUrl || '',
        hipUserInfoUrl: full.hipUserInfoUrl || '',
        hipClientId: full.hipClientId || '',
        hipClientSecret: full.hipClientSecret ? '***' : '',
        hipRedirectUri: full.hipRedirectUri || '',
        hipScopes: full.hipScopes || 'openid profile email',
        defaultEhrId: activeConnection.defaultEhrId || full.defaultEhrId || '',
        sessionCookieSecure: full.sessionCookieSecure || false,
        scriptAiBaseUrl: full.scriptAiBaseUrl || '',
        scriptAiApiKey: full.scriptAiApiKey ? '***' : '',
        scriptAiModel: full.scriptAiModel || '',
    };
}
