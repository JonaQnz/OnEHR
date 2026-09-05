const userAuthService = require('../../dist/services/userAuthService');
const configService = require('../../dist/services/configService');

const ADMIN_PERMISSIONS = ['patient.search', 'patient.read', 'form.execute', 'form-session.read-own', 'form-session.write-own', 'composition.read', 'composition.write', 'terminology.read', 'form.design', 'form.publish', 'plugin.configure', 'system.configure', 'user.manage', 'audit.read', 'terminology.manage', 'terminology.publish'];

/**
 * Controls what attachAuth (middleware/auth.ts) sees for every request
 * against a startTestServer() instance, by monkeypatching the exact two
 * functions it calls through - getCurrentAuthContext (the real
 * cookie/session lookup) and getConfig (whose userAuthMode gates the
 * "disabled-development-only" auto-auth fallback). Same monkeypatch-the-
 * dist-module technique every other service test already uses for
 * dist/db/prisma, applied one layer up at the HTTP boundary. Forcing
 * userAuthMode to 'local' here means an anonymous test genuinely gets no
 * principal (no silent dev-mode bypass), regardless of the host machine's
 * own NODE_ENV or persisted config.
 */
function installTestAuth() {
  const original = { getCurrentAuthContext: userAuthService.getCurrentAuthContext, getConfig: configService.getConfig };
  let current = null;
  userAuthService.getCurrentAuthContext = async () => current;
  configService.getConfig = () => ({ userAuthMode: 'local' });
  return {
    asAdmin(overrides = {}) {
      current = { principal: { userId: 'test-admin', subject: 'test-admin', issuer: 'test', authSource: 'local', displayName: 'Test Admin', roles: ['ADMIN'], permissions: ADMIN_PERMISSIONS, ...overrides }, sessionId: 'test-session-admin' };
    },
    asUser(permissions = [], overrides = {}) {
      current = { principal: { userId: 'test-user', subject: 'test-user', issuer: 'test', authSource: 'local', displayName: 'Test User', roles: ['USER'], permissions, ...overrides }, sessionId: 'test-session-user' };
    },
    asAnonymous() { current = null; },
    restore() {
      userAuthService.getCurrentAuthContext = original.getCurrentAuthContext;
      configService.getConfig = original.getConfig;
    },
  };
}

module.exports = { installTestAuth, ADMIN_PERMISSIONS };
