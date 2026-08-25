import { randomBytes } from 'crypto';
import type { Principal } from 'core';
import type { Request } from 'express';
import prisma from '../db/prisma';
import { getConfig, type AppConfig, type UserAuthMode } from './configService';
import { authenticateActiveHipLogin } from './ehrbaseConnectionPlugins';
import { writeAuditEvent } from './auditService';
import { createLocalUser, resolveExternalIdentity, UserServiceError, verifyLocalPassword } from './userService';
import { permissionsForRoles } from './authorizationService';

const SESSION_COOKIE = 'forms_session';
export interface AuthContext { principal: Principal; sessionId: string; }
export class UserAuthError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

function base64Url(value: Buffer): string { return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''); }
function randomId(): string { return base64Url(randomBytes(32)); }
function parseCookies(header: string | undefined): Record<string, string> { return header ? Object.fromEntries(header.split(';').map((entry) => { const [key, ...value] = entry.trim().split('='); return [key, decodeURIComponent(value.join('='))]; }).filter(([key]) => Boolean(key))) : {}; }
function cookieFlags(config: AppConfig): string { return `HttpOnly; Path=/; SameSite=Lax${config.sessionCookieSecure ? '; Secure' : ''}`; }
function sessionLifetimeMs(config: AppConfig): number { return Math.max(5, Math.min(7 * 24 * 60, config.sessionLifetimeMinutes || 480)) * 60_000; }
function localIssuer(): string { return 'forms:local'; }
function isHipConfigured(config: AppConfig = getConfig()): boolean {
  const connections = config.ehrbaseConnections || [];
  const active = connections.find((connection) => connection.id === config.activeEhrbaseConnectionId) || connections[0];
  return Boolean(active?.authPlugin === 'hip-keycloak' && active.keycloakBaseUrl && active.keycloakRealm && active.keycloakClientId);
}

export function getUserAuthMode(config: AppConfig = getConfig()): UserAuthMode { return config.userAuthMode === 'hip' ? 'hip' : config.userAuthMode === 'disabled-development-only' ? 'disabled-development-only' : 'local'; }
export function isUserAuthConfigured(config: AppConfig = getConfig()): boolean { if (getUserAuthMode(config) === 'disabled-development-only') return process.env.NODE_ENV !== 'production'; return getUserAuthMode(config) !== 'hip' || isHipConfigured(config); }
export function frontendSafePrincipal(context: AuthContext | null) { if (!context) return null; const { principal } = context; return { user: { id: principal.userId, displayName: principal.displayName || principal.subject, authSource: principal.authSource, ...(principal.email ? { email: principal.email } : {}) }, roles: principal.roles, permissions: principal.permissions }; }

async function createSession(principal: Principal, config = getConfig()): Promise<{ context: AuthContext; cookie: string }> { const sessionId = randomId(); await prisma.applicationSession.create({ data: { id: sessionId, userId: principal.userId, expiresAt: new Date(Date.now() + sessionLifetimeMs(config)) } }); return { context: { principal, sessionId }, cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Max-Age=${Math.floor(sessionLifetimeMs(config) / 1000)}; ${cookieFlags(config)}` }; }
function sessionIdFromRequest(req: Request): string | undefined { return parseCookies(req.headers.cookie)[SESSION_COOKIE]; }
export async function getCurrentAuthContext(req: Request): Promise<AuthContext | null> {
  const sessionId = sessionIdFromRequest(req); if (!sessionId) return null;
  const session = await prisma.applicationSession.findUnique({ where: { id: sessionId }, include: { user: { include: { roles: true, identities: true } } } });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'active') return null;
  const roles = session.user.roles.map((item) => item.role);
  const identity = session.user.identities[0];
  const principal: Principal = { userId: session.user.id, subject: session.user.username || identity?.externalSubject || session.user.id, issuer: identity?.issuer || localIssuer(), authSource: identity?.issuer.startsWith('hip-keycloak:') ? 'plugin:hip-keycloak' : identity ? 'oidc' : 'local', ...(session.user.displayName ? { displayName: session.user.displayName } : {}), ...(session.user.email ? { email: session.user.email } : {}), roles, permissions: permissionsForRoles(roles) };
  void prisma.applicationSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } }).catch(() => undefined);
  return { principal, sessionId: session.id };
}

export interface BootstrapAdminInput { username: string; password: string; displayName: string; email?: string; allowWeakPassword: boolean; }

/** Pure decision of whether/how to bootstrap an admin from config, split out
 * of `ensureBootstrapAdmin` so it's unit-testable without a database: `null`
 * means "nothing configured, do nothing"; otherwise the normalized input to
 * create the account with, or a thrown UserAuthError for a production policy
 * violation. Does not know whether an admin already exists - that DB check
 * stays in `ensureBootstrapAdmin`. */
export function resolveBootstrapAdminInput(config: AppConfig, isProduction: boolean): BootstrapAdminInput | null {
  const username = config.bootstrapAdminUsername || config.localUsername;
  const password = config.bootstrapAdminPassword || config.localPassword;
  if (!username || !password) return null;
  if (password.length < 12 && isProduction) throw new UserAuthError(400, 'A production bootstrap administrator password must contain at least 12 characters');
  return { username, password, displayName: config.bootstrapAdminDisplayName || username, ...(config.bootstrapAdminEmail ? { email: config.bootstrapAdminEmail } : {}), allowWeakPassword: password.length < 12 };
}

export async function ensureBootstrapAdmin(): Promise<void> {
  const input = resolveBootstrapAdminInput(getConfig(), process.env.NODE_ENV === 'production');
  if (!input) return;
  const admins = await prisma.roleAssignment.count({ where: { role: 'ADMIN' } });
  if (admins > 0) return;
  await createLocalUser({ username: input.username, password: input.password, displayName: input.displayName, ...(input.email ? { email: input.email } : {}), roles: ['ADMIN'], allowWeakBootstrapPassword: input.allowWeakPassword });
  console.info('[AUTH] Bootstrap administrator created from explicit environment configuration');
}

export async function loginLocal(username: string, password: string): Promise<{ context: AuthContext; cookie: string }> { if (getUserAuthMode() !== 'local') throw new UserAuthError(400, 'Local login is disabled'); const principal = await verifyLocalPassword(username, password); if (!principal) { await writeAuditEvent({ action: 'auth.login.failed', resourceType: 'auth', metadata: { source: 'local' } }); throw new UserAuthError(401, 'Invalid username or password'); } const session = await createSession(principal); await writeAuditEvent({ actorUserId: principal.userId, action: 'auth.login.success', resourceType: 'session', resourceId: session.context.sessionId, metadata: { source: 'local' } }); return session; }

export async function loginHip(username: string, password: string): Promise<{ context: AuthContext; cookie: string }> {
  if (getUserAuthMode() !== 'hip' || !isHipConfigured()) throw new UserAuthError(503, 'HIP login is not configured for the active system connection');
  try {
    const identity = await authenticateActiveHipLogin(username, password);
    const principal = await resolveExternalIdentity(identity);
    const session = await createSession({ ...principal, authSource: 'plugin:hip-keycloak' });
    await writeAuditEvent({ actorUserId: principal.userId, action: 'auth.login.success', resourceType: 'session', resourceId: session.context.sessionId, metadata: { source: 'hip-keycloak', issuer: identity.issuer } });
    return session;
  } catch (error) {
    await writeAuditEvent({ action: 'auth.login.failed', resourceType: 'auth', metadata: { source: 'hip-keycloak' } });
    if (error instanceof UserServiceError) throw error;
    throw new UserAuthError(401, 'HIP login failed');
  }
}

export async function clearSession(req: Request): Promise<string> { const id = sessionIdFromRequest(req); if (id) { const session = await prisma.applicationSession.findUnique({ where: { id } }); await prisma.applicationSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date() } }); if (session) await writeAuditEvent({ actorUserId: session.userId, action: 'auth.logout', resourceType: 'session', resourceId: id }); } return `${SESSION_COOKIE}=; Max-Age=0; ${cookieFlags(getConfig())}`; }
