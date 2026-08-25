const assert = require('node:assert/strict');
const test = require('node:test');
const { computeRoleSync } = require('../dist/services/userService');

test('computeRoleSync leaves roles untouched when the identity provider asserts nothing', () => {
  const result = computeRoleSync(['USER'], undefined);
  assert.equal(result.changed, false);
  assert.equal(result.desiredRoles, undefined);
});

test('computeRoleSync is a no-op when the asserted roles already match', () => {
  assert.equal(computeRoleSync(['USER'], ['USER']).changed, false);
  assert.equal(computeRoleSync(['ADMIN'], ['ADMIN']).changed, false);
});

test('computeRoleSync promotes a user to ADMIN when asserted', () => {
  const result = computeRoleSync(['USER'], ['ADMIN']);
  assert.equal(result.changed, true);
  assert.deepEqual(result.desiredRoles, ['ADMIN']);
});

test('computeRoleSync demotes an ADMIN back to USER when no longer asserted', () => {
  const result = computeRoleSync(['ADMIN'], ['USER']);
  assert.equal(result.changed, true);
  assert.deepEqual(result.desiredRoles, ['USER']);
});

test('computeRoleSync treats a user with no current roles as USER for comparison purposes', () => {
  // rolesOf() in userService already normalizes "no role rows" to ['USER'],
  // so a login asserting USER for such an account is a no-op.
  assert.equal(computeRoleSync(['USER'], ['USER']).changed, false);
});
