const assert = require('node:assert/strict');
const test = require('node:test');
const { permissionsForRoles, hasPermission, requirePermission, AuthorizationError } = require('../dist/services/authorizationService');
const { getUserAuthMode, isUserAuthConfigured } = require('../dist/services/userAuthService');

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
