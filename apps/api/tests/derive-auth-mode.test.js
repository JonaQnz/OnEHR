const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveAuthMode } = require('../dist/middleware/auth');

// QA review finding: 4 route files (formLaunchRoutes, formSessionRoutes,
// compositionSessionRoutes, scriptConnectorRoutes) independently checked
// `authSource === 'oidc'` to decide authMode 'hip' vs 'local'. The real
// HIP/Keycloak login flow (userAuthService.ts's loginHip) always sets
// authSource to 'plugin:hip-keycloak', never 'oidc' - so every real
// HIP-authenticated clinician silently got authMode: 'local' everywhere
// that flowed (n8n workflows, plugins, script connectors). Now one
// shared helper, so this can't drift back apart across 4 files again.
test('a real HIP/Keycloak login (authSource "plugin:hip-keycloak") resolves to authMode "hip"', () => {
  assert.equal(deriveAuthMode('plugin:hip-keycloak'), 'hip');
});

test('a local Forms-managed account resolves to authMode "local"', () => {
  assert.equal(deriveAuthMode('local'), 'local');
});

test('a generic (non-HIP) oidc identity resolves to authMode "local", not "hip"', () => {
  // This is the exact bug: the old check treated 'oidc' as HIP, which is
  // wrong in the other direction too - a generic OIDC identity provider
  // is not the HIP/Keycloak integration this flag exists to signal.
  assert.equal(deriveAuthMode('oidc'), 'local');
});

test('a form-launch identity resolves to authMode "local"', () => {
  assert.equal(deriveAuthMode('launch'), 'local');
});

test('an undefined authSource (no principal) resolves to authMode "local"', () => {
  assert.equal(deriveAuthMode(undefined), 'local');
});

test('a different plugin source (not hip-keycloak) resolves to authMode "local"', () => {
  assert.equal(deriveAuthMode('plugin:some-other-idp'), 'local');
});
