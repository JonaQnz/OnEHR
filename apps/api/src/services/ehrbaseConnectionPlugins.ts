import axios from 'axios';
import { getActiveEhrbaseConnection, type EhrbaseAuthPluginId, type EhrbaseConnection } from './configService';

export interface EhrbaseRequestConfig {
  ehrbaseUrl: string;
  headers: Record<string, string>;
  auth?: { username: string; password: string };
  connection: EhrbaseConnection;
}

export interface EhrbaseConnectionAuthPlugin {
  id: EhrbaseAuthPluginId;
  displayName: string;
  createRequestConfig(connection: EhrbaseConnection): Promise<Pick<EhrbaseRequestConfig, 'headers' | 'auth'>>;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function cleanUrl(value: string): string {
  const url = value.trim().replace(/\/$/, '');
  if (!url) throw new Error('EHRbase URL is not configured');
  return url;
}

const nonePlugin: EhrbaseConnectionAuthPlugin = {
  id: 'none',
  displayName: 'Keine Authentisierung',
  async createRequestConfig() {
    return { headers: {} };
  },
};

const basicPlugin: EhrbaseConnectionAuthPlugin = {
  id: 'basic',
  displayName: 'HTTP Basic Auth',
  async createRequestConfig(connection) {
    if (!connection.username || !connection.password) throw new Error(`Credentials for EHRbase connection '${connection.name}' are not configured`);
    return { headers: {}, auth: { username: connection.username, password: connection.password } };
  },
};

const hipKeycloakPlugin: EhrbaseConnectionAuthPlugin = {
  id: 'hip-keycloak',
  displayName: 'HIP / Keycloak OAuth2',
  async createRequestConfig(connection) {
    const cached = tokenCache.get(connection.id);
    if (cached && Date.now() < cached.expiresAt - 10_000) {
      return { headers: { Authorization: `Bearer ${cached.token}` } };
    }
    const baseUrl = connection.keycloakBaseUrl?.trim().replace(/\/$/, '');
    if (!baseUrl || !connection.keycloakRealm || !connection.keycloakClientId) {
      throw new Error(`HIP / Keycloak configuration for EHRbase connection '${connection.name}' is incomplete`);
    }
    const grantType = connection.keycloakGrantType || 'password';
    if (grantType === 'password' && (!connection.username || !connection.password)) {
      throw new Error(`Credentials for EHRbase connection '${connection.name}' are not configured`);
    }
    const payload = new URLSearchParams({ grant_type: grantType, client_id: connection.keycloakClientId });
    if (grantType === 'password') {
      payload.set('username', connection.username!);
      payload.set('password', connection.password!);
    }
    try {
      const response = await axios.post(
        `${baseUrl}/auth/realms/${encodeURIComponent(connection.keycloakRealm)}/protocol/openid-connect/token`,
        payload.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      const token = response.data?.access_token;
      if (typeof token !== 'string' || !token) throw new Error('Keycloak response did not contain an access token');
      tokenCache.set(connection.id, { token, expiresAt: Date.now() + Number(response.data?.expires_in || 300) * 1000 });
      return { headers: { Authorization: `Bearer ${token}` } };
    } catch (error: any) {
      const detail = error?.response?.data?.error_description || error?.message || 'Unknown error';
      throw new Error(`Failed to obtain HIP / Keycloak token: ${detail}`);
    }
  },
};

/** Authentication mechanisms are isolated here. Adding a mechanism means
 * registering one plugin, not modifying all EHRbase callers. */
export const ehrbaseConnectionAuthPlugins: Record<EhrbaseAuthPluginId, EhrbaseConnectionAuthPlugin> = {
  none: nonePlugin,
  basic: basicPlugin,
  'hip-keycloak': hipKeycloakPlugin,
};

export async function getEhrbaseRequestConfig(connection = getActiveEhrbaseConnection()): Promise<EhrbaseRequestConfig> {
  const plugin = ehrbaseConnectionAuthPlugins[connection.authPlugin];
  if (!plugin) throw new Error(`Unknown EHRbase authentication plugin '${connection.authPlugin}'`);
  const authConfig = await plugin.createRequestConfig(connection);
  return {
    ehrbaseUrl: cleanUrl(connection.url),
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authConfig.headers },
    ...(authConfig.auth ? { auth: authConfig.auth } : {}),
    connection,
  };
}

/** Compatibility helper for old consumers; new EHRbase callers use request config. */
export async function getActiveEhrbaseBearerToken(): Promise<string> {
  const config = await getEhrbaseRequestConfig();
  const header = config.headers.Authorization;
  if (!header?.startsWith('Bearer ')) throw new Error('The active EHRbase connection does not use bearer authentication');
  return header.slice('Bearer '.length);
}
