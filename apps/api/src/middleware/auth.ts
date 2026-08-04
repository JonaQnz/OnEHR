import type { NextFunction, Request, Response } from 'express';
import type { Principal } from 'core';
import { AuthorizationError, requirePermission as assertPermission } from '../services/authorizationService';
import { getConfig } from '../services/configService';
import { getCurrentAuthContext, getUserAuthMode, type AuthContext } from '../services/userAuthService';

declare global {
  namespace Express {
    interface Request { auth?: AuthContext; principal?: Principal; }
  }
}

export function attachAuth(req: Request, _res: Response, next: NextFunction): void {
  void getCurrentAuthContext(req).then((context) => { if (context) { req.auth = context; req.principal = context.principal; } else req.principal = developmentPrincipal(); next(); }).catch(next);
}

function developmentPrincipal(): Principal | undefined {
  if (getUserAuthMode(getConfig()) !== 'disabled-development-only' || process.env.NODE_ENV === 'production') return undefined;
  return { userId: 'development', subject: 'development', issuer: 'forms:development', authSource: 'local', displayName: 'Development user', roles: ['ADMIN'], permissions: ['patient.search', 'patient.read', 'form.execute', 'form-session.read-own', 'form-session.write-own', 'composition.read', 'composition.write', 'form.design', 'form.publish', 'plugin.configure', 'system.configure', 'user.manage', 'audit.read'] };
}

export function requireAuthentication(req: Request, res: Response, next: NextFunction): void {
  req.principal = req.principal || developmentPrincipal();
  if (req.principal) return next();
  res.status(401).json({ error: 'Authentication required', authRequired: true });
}
/** Compatibility alias for existing routes; new routes should use requireAuthentication. */
export const requireAuth = requireAuthentication;

export function requirePermission(permission: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    requireAuthentication(req, res, () => {
      try { assertPermission(req.principal, permission); next(); }
      catch (error) { const status = error instanceof AuthorizationError ? error.status : 403; res.status(status).json({ error: error instanceof Error ? error.message : 'Permission denied' }); }
    });
  };
}
