const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createAnonymousContext,
  isUserAuthConfigured,
  loginLocal,
  getUserAuthMode,
} = require('../dist/services/userAuthService');

const localConfig = {
  userAuthMode: 'local',
  localUsername: 'alice',
  localPassword: 'secret',
  sessionCookieSecure: false,
};

test('local auth is configurable without adding a permissions engine', () => {
  assert.equal(getUserAuthMode(localConfig), 'local');
  assert.equal(isUserAuthConfigured(localConfig), true);
  assert.equal(createAnonymousContext({ userAuthMode: 'local' }).id, 'anonymous');
});

test('local login creates an HttpOnly session cookie', () => {
  const result = loginLocal('alice', 'secret', localConfig);
  assert.equal(result.context.id, 'alice');
  assert.equal(result.context.authMode, 'local');
  assert.match(result.cookie, /^forms_session=.+HttpOnly/);
});

test('invalid local credentials are rejected', () => {
  assert.throws(() => loginLocal('alice', 'wrong', localConfig), (error) => error.status === 401);
});

test('HIP mode is not considered configured until its basic OIDC settings exist', () => {
  assert.equal(isUserAuthConfigured({ userAuthMode: 'hip' }), false);
  assert.equal(isUserAuthConfigured({ userAuthMode: 'hip', hipClientId: 'forms', hipRedirectUri: 'http://localhost/callback', hipIssuerUrl: 'https://hip.example' }), true);
});
