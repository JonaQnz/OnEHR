const assert = require('node:assert/strict');
const test = require('node:test');
const { extractKeycloakRoles, determineHipAdminAccess } = require('../dist/services/ehrbaseConnectionPlugins');

test('extractKeycloakRoles reads realm and per-client roles, tolerating absent claims', () => {
  assert.deepEqual(extractKeycloakRoles({}, 'forms-ui'), { realmRoles: [], clientRoles: [] });
  assert.deepEqual(extractKeycloakRoles({ realm_access: { roles: ['offline_access', 'admin'] } }, undefined), { realmRoles: ['offline_access', 'admin'], clientRoles: [] });
  assert.deepEqual(
    extractKeycloakRoles({ resource_access: { 'forms-ui': { roles: ['viewer'] }, other: { roles: ['admin'] } } }, 'forms-ui'),
    { realmRoles: [], clientRoles: ['viewer'] },
  );
  // Malformed claim shapes (not arrays) are ignored rather than thrown on.
  assert.deepEqual(extractKeycloakRoles({ realm_access: { roles: 'admin' } }, undefined), { realmRoles: [], clientRoles: [] });
});

test('determineHipAdminAccess grants admin from a matching realm or client role, case-insensitively', () => {
  const base = { email: 'user@example.com', subject: 'sub-1', username: 'user', allowlist: [] };
  assert.equal(determineHipAdminAccess({ ...base, realmRoles: ['ADMIN'], clientRoles: [] }).isAdmin, true);
  assert.equal(determineHipAdminAccess({ ...base, realmRoles: [], clientRoles: ['forms-admin'] }).isAdmin, true);
  assert.equal(determineHipAdminAccess({ ...base, realmRoles: ['offline_access'], clientRoles: ['viewer'] }).isAdmin, false);
});

test('determineHipAdminAccess grants admin via the FORMS_HIP_ADMIN_EMAILS allowlist independent of token roles', () => {
  const result = determineHipAdminAccess({
    realmRoles: [], clientRoles: [], email: 'jona.kunze@vitagroup.ag', subject: 'sub-1', username: 'jona.kunze',
    allowlist: ['jona.kunze@vitagroup.ag'],
  });
  assert.equal(result.isAdmin, true);
  assert.equal(result.allowlistGrantsAdmin, true);
  assert.equal(result.tokenGrantsAdmin, false);
});

test('determineHipAdminAccess allowlist match is case-insensitive and also matches subject/username', () => {
  assert.equal(determineHipAdminAccess({ realmRoles: [], clientRoles: [], email: 'Jona.Kunze@VitaGroup.ag', subject: 'sub-1', username: 'jona.kunze', allowlist: ['jona.kunze@vitagroup.ag'] }).isAdmin, true);
  assert.equal(determineHipAdminAccess({ realmRoles: [], clientRoles: [], email: undefined, subject: 'known-subject', username: 'someone', allowlist: ['known-subject'] }).isAdmin, true);
  assert.equal(determineHipAdminAccess({ realmRoles: [], clientRoles: [], email: undefined, subject: 'sub-1', username: 'jona.kunze', allowlist: ['jona.kunze'] }).isAdmin, true);
});

test('determineHipAdminAccess denies admin when nothing matches, including an empty allowlist', () => {
  const result = determineHipAdminAccess({ realmRoles: [], clientRoles: [], email: 'nobody@example.com', subject: 'sub-2', username: 'nobody', allowlist: [] });
  assert.equal(result.isAdmin, false);
  assert.equal(result.tokenGrantsAdmin, false);
  assert.equal(result.allowlistGrantsAdmin, false);
});
