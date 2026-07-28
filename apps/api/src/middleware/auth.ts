import type { NextFunction, Request, Response } from 'express';
import { getConfig } from '../services/configService';
import { createAnonymousContext, getCurrentAuthContext, isUserAuthConfigured, type AuthContext } from '../services/userAuthService';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function attachAuth(req: Request, _res: Response, next: NextFunction): void {
  req.auth = getCurrentAuthContext(req) || undefined;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.auth) {
    next();
    return;
  }
  // Development/standalone mode remains usable before credentials are configured.
  // As soon as local or HIP credentials are configured, every protected route requires login.
  if (!isUserAuthConfigured(getConfig())) {
    req.auth = createAnonymousContext();
    next();
    return;
  }
  res.status(401).json({ error: 'Authentication required', authRequired: true });
}
