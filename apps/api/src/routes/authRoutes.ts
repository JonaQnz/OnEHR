import { Router } from 'express';
import { getConfig } from '../services/configService';
import { asyncHandler } from '../middleware/errorHandler';
import {
  beginHipLogin,
  clearSession,
  completeHipLogin,
  getCurrentAuthContext,
  getUserAuthMode,
  isUserAuthConfigured,
  loginLocal,
  UserAuthError,
} from '../services/userAuthService';

const router = Router();

router.get('/config', (_req, res) => {
  const config = getConfig();
  res.json({ mode: getUserAuthMode(config), authRequired: isUserAuthConfigured(config) });
});

router.get('/me', (req, res) => {
  const config = getConfig();
  const context = getCurrentAuthContext(req);
  res.json({
    authenticated: Boolean(context),
    authRequired: isUserAuthConfigured(config),
    mode: getUserAuthMode(config),
    user: context ? { id: context.id, name: context.name, email: context.email, authMode: context.authMode } : null,
  });
});

router.post('/login', (req, res) => {
  try {
    const result = loginLocal(String(req.body?.username || ''), String(req.body?.password || ''));
    res.setHeader('Set-Cookie', result.cookie);
    res.json({ authenticated: true, user: result.context });
  } catch (error: any) {
    const status = error instanceof UserAuthError ? error.status : 500;
    res.status(status).json({ error: error.message });
  }
});

router.get('/login/hip', asyncHandler(async (req, res) => {
  const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
  res.redirect(await beginHipLogin(returnTo));
}));

router.get('/callback/hip', asyncHandler(async (req, res) => {
  try {
    const result = await completeHipLogin(String(req.query.state || ''), String(req.query.code || ''));
    res.setHeader('Set-Cookie', result.cookie);
    res.redirect(result.returnTo);
  } catch (error: any) {
    const status = error instanceof UserAuthError ? error.status : 500;
    res.status(status).json({ error: error.message });
  }
}));

router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSession(req));
  res.json({ authenticated: false });
});

export default router;
