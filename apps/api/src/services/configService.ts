import fs from 'fs';
import path from 'path';

export interface AppConfig {
    ehrbaseUrl?: string;
    ehrbaseUser?: string;
    ehrbasePass?: string;
    authMode?: 'basic' | 'keycloak';
    keycloakApi?: string;
    keycloakTenantName?: string;
    keycloakClientId?: string;
    keycloakGrantType?: string;
    mappingServiceApi?: string;
}

// In Docker, we can save config to /app/data/config.json.
// In local dev, it will be in apps/api/data/config.json.
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

let persistedConfig: AppConfig = {};

export function initConfig() {
    if (!fs.existsSync(DATA_DIR)) {
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    }
    
    if (fs.existsSync(CONFIG_FILE)) {
        try {
            persistedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            console.log("Loaded AppConfig overrides from file:", CONFIG_FILE);
        } catch (e) {
            console.error("Failed to parse config.json, using defaults.", e);
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
        ehrbasePass: resolve(persistedConfig.ehrbasePass, process.env.EHRBASE_PASS, 'W9zuwPhr03a9px'),
        authMode: resolve(persistedConfig.authMode, process.env.AUTH_MODE, 'basic') as 'basic' | 'keycloak',
        keycloakApi: resolve(persistedConfig.keycloakApi, process.env.KEYCLOAK_API),
        keycloakTenantName: resolve(persistedConfig.keycloakTenantName, process.env.KEYCLOAK_TENANT_NAME),
        keycloakClientId: resolve(persistedConfig.keycloakClientId, process.env.KEYCLOAK_CLIENT_ID),
        keycloakGrantType: resolve(persistedConfig.keycloakGrantType, process.env.KEYCLOAK_GRANT_TYPE, 'password'),
        mappingServiceApi: resolve(persistedConfig.mappingServiceApi, process.env.MAPPING_SERVICE_API),
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

    persistedConfig = { ...persistedConfig, ...cleanUpdates };
    
    if (!fs.existsSync(DATA_DIR)) {
        try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(persistedConfig, null, 2), 'utf8');
}

export function getSafeConfig(): Partial<AppConfig> {
    const full = getConfig();
    return {
        ehrbaseUrl: full.ehrbaseUrl,
        ehrbaseUser: full.ehrbaseUser,
        ehrbasePass: full.ehrbasePass ? '***' : '',
        authMode: full.authMode || 'basic',
        keycloakApi: full.keycloakApi || '',
        keycloakTenantName: full.keycloakTenantName || '',
        keycloakClientId: full.keycloakClientId || '',
        keycloakGrantType: full.keycloakGrantType || '',
        mappingServiceApi: full.mappingServiceApi || '',
    };
}
