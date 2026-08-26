import fs from 'node:fs';
import path from 'node:path';

/**
 * Reads the SAME EHRbase connection Forms itself uses (data/config.json,
 * written by apps/api's own Config page) rather than asking for a second copy
 * of the same secrets in this server's own env - this server always targets
 * whichever EHRbase connection is currently active in Forms, automatically.
 * Mirrors apps/api/src/services/configService.ts's own candidate-file search
 * (DATA_DIR env, then a few repo-relative fallbacks) so this works the same
 * whether run on the host or inside the api container.
 */
export type EhrbaseAuthPluginId = 'none' | 'basic' | 'hip-keycloak';

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
}

function candidateConfigFiles(): string[] {
  const candidates: string[] = [];
  if (process.env.DATA_DIR) candidates.push(path.join(process.env.DATA_DIR, 'config.json'));
  const here = path.dirname(new URL(import.meta.url).pathname);
  candidates.push(path.resolve(here, '..', '..', '..', 'data', 'config.json'));
  candidates.push(path.resolve(process.cwd(), 'data', 'config.json'));
  candidates.push(path.resolve(process.cwd(), '..', 'data', 'config.json'));
  candidates.push(path.resolve(process.cwd(), '.data', 'config.json'));
  return Array.from(new Set(candidates));
}

function loadAppConfig(): Record<string, unknown> {
  for (const file of candidateConfigFiles()) {
    if (fs.existsSync(file)) {
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* try the next candidate */ }
    }
  }
  return {};
}

/**
 * Env-var fallback, for when Forms itself is running on nothing but env vars
 * (no persisted connection yet - see configService.ts's own legacyConnection()).
 * Kept intentionally small: only what's needed to authenticate and reach
 * EHRbase, not the full EhrbaseConnection shape Forms itself persists.
 */
function legacyConnectionFromEnv(): EhrbaseConnection | undefined {
  const url = process.env.EHRBASE_URL;
  if (!url) return undefined;
  const authPlugin: EhrbaseAuthPluginId = process.env.AUTH_MODE === 'hip' ? 'hip-keycloak' : process.env.EHRBASE_USER ? 'basic' : 'none';
  return {
    id: 'legacy-env', name: 'EHRBASE_URL (env)', url, authPlugin,
    username: process.env.EHRBASE_USER, password: process.env.EHRBASE_PASS,
    keycloakBaseUrl: process.env.KEYCLOAK_API, keycloakRealm: process.env.KEYCLOAK_TENANT_NAME,
    keycloakClientId: process.env.KEYCLOAK_CLIENT_ID, keycloakGrantType: process.env.KEYCLOAK_GRANT_TYPE,
  };
}

export function getActiveEhrbaseConnection(): EhrbaseConnection {
  const config = loadAppConfig();
  const connections = Array.isArray(config.ehrbaseConnections) ? config.ehrbaseConnections as EhrbaseConnection[] : [];
  const activeId = typeof config.activeEhrbaseConnectionId === 'string' ? config.activeEhrbaseConnectionId : undefined;
  const active = (activeId ? connections.find((c) => c.id === activeId) : undefined) || connections[0];
  if (active) return active;
  const legacy = legacyConnectionFromEnv();
  if (legacy) return legacy;
  throw new Error(
    'No EHRbase connection configured. Set one up on Forms\' Config page (persists to data/config.json), '
    + 'or set EHRBASE_URL (+ EHRBASE_USER/EHRBASE_PASS or AUTH_MODE=hip + KEYCLOAK_* env vars) for this process.',
  );
}
