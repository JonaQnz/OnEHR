import { Router } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { getConfig } from '../services/configService';
import { clearSession, frontendSafePrincipal, getUserAuthMode, isUserAuthConfigured, loginHip, loginLocal, UserAuthError } from '../services/userAuthService';

const router = Router();
router.get('/config', (_req, res) => { const config = getConfig(); res.json({ mode: getUserAuthMode(config), authRequired: isUserAuthConfigured(config) }); });
router.get('/me', (req, res) => { const config = getConfig(); const principal = req.principal; const safe = frontendSafePrincipal(req.auth || null) || (principal ? { user: { id: principal.userId, displayName: principal.displayName || principal.subject, authSource: principal.authSource, ...(principal.email ? { email: principal.email } : {}) }, roles: principal.roles, permissions: principal.permissions } : { user: null, roles: [], permissions: [] }); res.json({ authenticated: Boolean(req.auth || principal), authRequired: isUserAuthConfigured(config), mode: getUserAuthMode(config), ...safe }); });
router.post('/login', asyncHandler(async (req, res) => {
  try {
    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const result = getUserAuthMode() === 'hip' ? await loginHip(username, password) : await loginLocal(username, password);
    res.setHeader('Set-Cookie', result.cookie);
    res.json({ authenticated: true, ...frontendSafePrincipal(result.context) });
  } catch (error) {
    const status = error instanceof UserAuthError ? error.status : 500;
    res.status(status).json({ error: status === 401 ? 'Invalid username or password' : error instanceof Error ? error.message : 'Login failed' });
  }
}));
router.post('/logout', asyncHandler(async (req, res) => { res.setHeader('Set-Cookie', await clearSession(req)); res.json({ authenticated: false }); }));
export default router;
