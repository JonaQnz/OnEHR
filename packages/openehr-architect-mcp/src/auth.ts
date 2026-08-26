import type { EhrbaseConnection } from './config.js';

/**
 * Mirrors apps/api/src/services/ehrbaseConnectionPlugins.ts's three auth
 * plugins (none/basic/hip-keycloak) - deliberately re-implemented here rather
 * than imported, since this server is a standalone process outside Forms'
 * own runtime (no dependency on apps/api's compiled output or its module
 * graph), talking straight to EHRbase.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function requestHipToken(connection: EhrbaseConnection, fetchImpl: typeof fetch): Promise<{ token: string; expiresIn: number }> {
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
  const response = await fetchImpl(`${baseUrl}/auth/realms/${encodeURIComponent(connection.keycloakRealm)}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: payload.toString(),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || typeof body?.access_token !== 'string') {
    throw new Error(`Failed to obtain HIP / Keycloak token: ${body?.error_description || `HTTP ${response.status}`}`);
  }
  return { token: body.access_token, expiresIn: Number(body.expires_in || 300) };
}

/** Resolves the Authorization header (if any) for one request to the active
 * EHRbase connection - bearer for hip-keycloak (cached until near expiry),
 * Basic for basic auth, none for the 'none' plugin. `fetchImpl` is injectable
 * for tests; production callers never need to pass it. */
export async function resolveAuthorizationHeader(connection: EhrbaseConnection, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  if (connection.authPlugin === 'none') return undefined;
  if (connection.authPlugin === 'basic') {
    if (!connection.username || !connection.password) throw new Error(`Credentials for EHRbase connection '${connection.name}' are not configured`);
    return `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString('base64')}`;
  }
  const cached = tokenCache.get(connection.id);
  if (cached && Date.now() < cached.expiresAt - 10_000) return `Bearer ${cached.token}`;
  const result = await requestHipToken(connection, fetchImpl);
  tokenCache.set(connection.id, { token: result.token, expiresAt: Date.now() + result.expiresIn * 1000 });
  return `Bearer ${result.token}`;
}
