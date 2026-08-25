const assert = require('node:assert/strict');
const test = require('node:test');
const { permissionsForRoles, hasPermission, requirePermission, AuthorizationError } = require('../dist/services/authorizationService');
const { getUserAuthMode, isUserAuthConfigured, resolveBootstrapAdminInput, UserAuthError } = require('../dist/services/userAuthService');

test('roles are permission bundles and ADMIN includes USER permissions', () => {
  const user = permissionsForRoles(['USER']);
  const admin = permissionsForRoles(['ADMIN']);
  assert.ok(user.includes('form.execute'));
  assert.ok(!user.includes('form.design'));
  assert.ok(admin.includes('form.execute'));
  assert.ok(admin.includes('form.design'));
  assert.ok(admin.includes('user.manage'));
});

test('permission checks use only the normalized Principal', () => {
  const principal = { userId: 'user-1', subject: 'alice', issuer: 'forms:local', authSource: 'local', roles: ['USER'], permissions: permissionsForRoles(['USER']) };
  assert.equal(hasPermission(principal, 'patient.read'), true);
  assert.throws(() => requirePermission(principal, 'system.configure'), (error) => error instanceof AuthorizationError && error.status === 403);
});

test('HIP mode is configured exclusively through the active HIP / Keycloak connection plugin', () => {
  assert.equal(getUserAuthMode({ userAuthMode: 'local' }), 'local');
  assert.equal(isUserAuthConfigured({ userAuthMode: 'hip' }), false);
  assert.equal(isUserAuthConfigured({ userAuthMode: 'hip', activeEhrbaseConnectionId: 'hip', ehrbaseConnections: [{ id: 'hip', name: 'HIP', url: 'https://ehr.example', authPlugin: 'hip-keycloak', keycloakBaseUrl: 'https://hip.example', keycloakRealm: 'forms', keycloakClientId: 'forms-ui' }] }), true);
});

test('development-only disabled authentication is never configured in production', () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try { assert.equal(isUserAuthConfigured({ userAuthMode: 'disabled-development-only' }), false); }
  finally { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; }
});

test('resolveBootstrapAdminInput does nothing when no bootstrap credentials are configured', () => {
  assert.equal(resolveBootstrapAdminInput({}, false), null);
  assert.equal(resolveBootstrapAdminInput({ bootstrapAdminUsername: 'admin' }, false), null);
});

test('resolveBootstrapAdminInput normalizes username/password/displayName/email sources', () => {
  const input = resolveBootstrapAdminInput({
    bootstrapAdminUsername: 'jona.kunze', bootstrapAdminPassword: 'a-long-unique-password', bootstrapAdminEmail: 'jona.kunze@vitagroup.ag',
  }, false);
  assert.deepEqual(input, { username: 'jona.kunze', password: 'a-long-unique-password', displayName: 'jona.kunze', email: 'jona.kunze@vitagroup.ag', allowWeakPassword: false });
});

test('resolveBootstrapAdminInput falls back to the username as the display name and omits email when unset', () => {
  const input = resolveBootstrapAdminInput({ bootstrapAdminUsername: 'admin', bootstrapAdminPassword: 'a-long-unique-password' }, false);
  assert.equal(input.displayName, 'admin');
  assert.equal(input.email, undefined);
});

test('resolveBootstrapAdminInput accepts a short password outside production and flags it as weak', () => {
  const input = resolveBootstrapAdminInput({ bootstrapAdminUsername: 'admin', bootstrapAdminPassword: 'short' }, false);
  assert.equal(input.allowWeakPassword, true);
});

test('resolveBootstrapAdminInput rejects a short password in production', () => {
  assert.throws(
    () => resolveBootstrapAdminInput({ bootstrapAdminUsername: 'admin', bootstrapAdminPassword: 'short' }, true),
    (error) => error instanceof UserAuthError && error.status === 400,
  );
});

test('resolveBootstrapAdminInput accepts the legacy LOCAL_AUTH_* fallback source', () => {
  const input = resolveBootstrapAdminInput({ localUsername: 'legacy-admin', localPassword: 'a-long-unique-password' }, false);
  assert.equal(input.username, 'legacy-admin');
});
