import fs from 'fs';
import path from 'path';

export type UserAuthMode = 'local' | 'hip';

export interface AppConfig {
    ehrbaseUrl?: string;
    ehrbaseUser?: string;
    ehrbasePass?: string;
    ehrbaseSubjectNamespace?: string;
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

    return {
        ehrbaseUrl: resolve(persistedConfig.ehrbaseUrl, process.env.EHRBASE_URL, 'http://localhost:8080/ehrbase/rest/openehr/v1'),
        ehrbaseUser: resolve(persistedConfig.ehrbaseUser, process.env.EHRBASE_USER, 'admin'),
        // Never ship a usable credential in source code. Operators must configure this
        // explicitly through the environment, a secret store, or the admin UI.
        ehrbasePass: resolve(persistedConfig.ehrbasePass, process.env.EHRBASE_PASS),
        ehrbaseSubjectNamespace: resolve(persistedConfig.ehrbaseSubjectNamespace, process.env.EHRBASE_SUBJECT_NAMESPACE, 'default'),
        authMode: resolve(persistedConfig.authMode, process.env.AUTH_MODE, 'basic') as 'basic' | 'keycloak',
        keycloakApi: resolve(persistedConfig.keycloakApi, process.env.KEYCLOAK_API),
        keycloakTenantName: resolve(persistedConfig.keycloakTenantName, process.env.KEYCLOAK_TENANT_NAME),
        keycloakClientId: resolve(persistedConfig.keycloakClientId, process.env.KEYCLOAK_CLIENT_ID),
        keycloakGrantType: resolve(persistedConfig.keycloakGrantType, process.env.KEYCLOAK_GRANT_TYPE, 'password'),
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
        defaultEhrId: resolve(persistedConfig.defaultEhrId, process.env.DEFAULT_EHR_ID || process.env.EHRBASE_DEFAULT_EHR_ID),
        sessionCookieSecure: resolve(undefined, process.env.SESSION_COOKIE_SECURE, 'false') === 'true',
    };
}

export function saveConfig(updates: AppConfig) {
    const cleanUpdates = { ...updates };
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
    return {
        ehrbaseUrl: full.ehrbaseUrl,
        ehrbaseUser: full.ehrbaseUser,
        ehrbasePass: full.ehrbasePass ? '***' : '',
        ehrbaseSubjectNamespace: full.ehrbaseSubjectNamespace || 'default',
        authMode: full.authMode || 'basic',
        keycloakApi: full.keycloakApi || '',
        keycloakTenantName: full.keycloakTenantName || '',
        keycloakClientId: full.keycloakClientId || '',
        keycloakGrantType: full.keycloakGrantType || '',
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
        defaultEhrId: full.defaultEhrId || '',
        sessionCookieSecure: full.sessionCookieSecure || false,
    };
}
