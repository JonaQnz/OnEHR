import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAuthorizationHeader } from '../dist/auth.js';

test("the 'none' plugin returns no Authorization header", async () => {
  const header = await resolveAuthorizationHeader({ id: 'c1', name: 'x', url: 'https://x', authPlugin: 'none' });
  assert.equal(header, undefined);
});

test("the 'basic' plugin returns a base64 Basic header from username/password", async () => {
  const header = await resolveAuthorizationHeader({ id: 'c2', name: 'x', url: 'https://x', authPlugin: 'basic', username: 'alice', password: 'secret' });
  assert.equal(header, `Basic ${Buffer.from('alice:secret').toString('base64')}`);
});

test("the 'basic' plugin without credentials throws a descriptive error", async () => {
  await assert.rejects(
    resolveAuthorizationHeader({ id: 'c3', name: 'Test System', url: 'https://x', authPlugin: 'basic' }),
    /Credentials for EHRbase connection 'Test System' are not configured/,
  );
});

test("the 'hip-keycloak' plugin exchanges credentials for a bearer token via the password grant", async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), body: init.body });
    return new Response(JSON.stringify({ access_token: 'tok-abc', expires_in: 300 }), { status: 200 });
  };
  const connection = { id: 'c4', name: 'x', url: 'https://x', authPlugin: 'hip-keycloak', username: 'alice', password: 'secret', keycloakBaseUrl: 'https://kc.test', keycloakRealm: 'realm1', keycloakClientId: 'client1' };

  const header = await resolveAuthorizationHeader(connection, fetchStub);

  assert.equal(header, 'Bearer tok-abc');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://kc.test/auth/realms/realm1/protocol/openid-connect/token');
  const params = new URLSearchParams(calls[0].body);
  assert.equal(params.get('grant_type'), 'password');
  assert.equal(params.get('client_id'), 'client1');
  assert.equal(params.get('username'), 'alice');
  assert.equal(params.get('password'), 'secret');
});

test("the 'hip-keycloak' plugin caches the token and does not re-request until it's near expiry", async () => {
  let requests = 0;
  const fetchStub = async () => { requests += 1; return new Response(JSON.stringify({ access_token: 'tok-cached', expires_in: 300 }), { status: 200 }); };
  const connection = { id: 'c5', name: 'x', url: 'https://x', authPlugin: 'hip-keycloak', username: 'alice', password: 'secret', keycloakBaseUrl: 'https://kc.test', keycloakRealm: 'realm1', keycloakClientId: 'client1' };

  const first = await resolveAuthorizationHeader(connection, fetchStub);
  const second = await resolveAuthorizationHeader(connection, fetchStub);

  assert.equal(first, 'Bearer tok-cached');
  assert.equal(second, 'Bearer tok-cached');
  assert.equal(requests, 1, 'the second call should reuse the cached token, not hit Keycloak again');
});

test("the 'hip-keycloak' plugin surfaces Keycloak's own error_description on a failed grant", async () => {
  const fetchStub = async () => new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid user credentials' }), { status: 401 });
  const connection = { id: 'c6', name: 'x', url: 'https://x', authPlugin: 'hip-keycloak', username: 'alice', password: 'wrong', keycloakBaseUrl: 'https://kc.test', keycloakRealm: 'realm1', keycloakClientId: 'client1' };

  await assert.rejects(resolveAuthorizationHeader(connection, fetchStub), /Invalid user credentials/);
});

test("the 'hip-keycloak' plugin rejects with a clear error when Keycloak config is incomplete", async () => {
  const connection = { id: 'c7', name: 'Incomplete System', url: 'https://x', authPlugin: 'hip-keycloak', username: 'alice', password: 'secret' };
  await assert.rejects(resolveAuthorizationHeader(connection, async () => new Response('{}')), /HIP \/ Keycloak configuration for EHRbase connection 'Incomplete System' is incomplete/);
});
