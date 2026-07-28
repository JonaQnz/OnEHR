import axios from 'axios';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Request } from 'express';
import { getConfig, type AppConfig, type UserAuthMode } from './configService';

export interface AuthenticatedUser {
  id: string;
  name?: string;
  email?: string;
  authMode: UserAuthMode;
}

export interface AuthContext extends AuthenticatedUser {
  accessToken?: string;
}

interface StoredSession {
  context: AuthContext;
  expiresAt: number;
}

interface PendingHipLogin {
  state: string;
  codeVerifier: string;
  returnTo: string;
  createdAt: number;
}

const SESSION_COOKIE = 'forms_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;
const sessions = new Map<string, StoredSession>();
const pendingHipLogins = new Map<string, PendingHipLogin>();

export class UserAuthError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'UserAuthError';
  }
}

function base64Url(value: Buffer): string {
  return value.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomId(): string {
  return base64Url(randomBytes(32));
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(header.split(';').map((entry) => {
    const [key, ...value] = entry.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }).filter(([key]) => Boolean(key)));
}

function cookieFlags(config: AppConfig): string {
  return `HttpOnly; Path=/; SameSite=Lax${config.sessionCookieSecure ? '; Secure' : ''}`;
}

function createSession(context: AuthContext, config: AppConfig): { sessionId: string; cookie: string } {
  const sessionId = randomId();
  sessions.set(sessionId, { context, expiresAt: Date.now() + SESSION_TTL_MS });
  return { sessionId, cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; ${cookieFlags(config)}` };
}

function getSessionId(req: Request): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE];
}

function getSessionContext(req: Request): AuthContext | null {
  const sessionId = getSessionId(req);
  if (!sessionId) return null;
  const stored = sessions.get(sessionId);
  if (!stored) return null;
  if (stored.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return stored.context;
}

function isLocalConfigured(config: AppConfig): boolean {
  return Boolean(config.localUsername && config.localPassword);
}

function isHipConfigured(config: AppConfig): boolean {
  return Boolean(config.hipClientId && config.hipRedirectUri && (config.hipIssuerUrl || (config.hipAuthorizationUrl && config.hipTokenUrl)));
}

export function isUserAuthConfigured(config: AppConfig = getConfig()): boolean {
  return config.userAuthMode === 'hip' ? isHipConfigured(config) : isLocalConfigured(config);
}

export function getUserAuthMode(config: AppConfig = getConfig()): UserAuthMode {
  return config.userAuthMode === 'hip' ? 'hip' : 'local';
}

export function getCurrentAuthContext(req: Request): AuthContext | null {
  return getSessionContext(req);
}

export function createAnonymousContext(config: AppConfig = getConfig()): AuthContext {
  return { id: 'anonymous', name: 'Local user', authMode: getUserAuthMode(config) };
}

export function loginLocal(username: string, password: string, config: AppConfig = getConfig()): { context: AuthContext; cookie: string } {
  if (getUserAuthMode(config) !== 'local') throw new UserAuthError(400, 'Local login is disabled');
  if (!isLocalConfigured(config)) throw new UserAuthError(503, 'Local authentication is not configured');
  if (!constantTimeEqual(username, config.localUsername || '') || !constantTimeEqual(password, config.localPassword || '')) {
    throw new UserAuthError(401, 'Invalid username or password');
  }
  const context: AuthContext = { id: username, name: username, authMode: 'local' };
  return { context, cookie: createSession(context, config).cookie };
}

async function discoverHip(config: AppConfig): Promise<{ authorization_endpoint: string; token_endpoint: string; userinfo_endpoint?: string }> {
  if (config.hipAuthorizationUrl && config.hipTokenUrl) {
    return { authorization_endpoint: config.hipAuthorizationUrl, token_endpoint: config.hipTokenUrl, userinfo_endpoint: config.hipUserInfoUrl };
  }
  if (!config.hipIssuerUrl) throw new UserAuthError(503, 'HIP issuer is not configured');
  try {
    const response = await axios.get(`${config.hipIssuerUrl.replace(/\/$/, '')}/.well-known/openid-configuration`, { timeout: 10000 });
    return response.data;
  } catch (error: any) {
    throw new UserAuthError(502, `Unable to discover HIP login endpoints: ${error.response?.status || error.message}`);
  }
}

export async function beginHipLogin(returnTo = '/'): Promise<string> {
  const config = getConfig();
  if (getUserAuthMode(config) !== 'hip') throw new UserAuthError(400, 'HIP login is disabled');
  if (!isHipConfigured(config)) throw new UserAuthError(503, 'HIP authentication is not configured');
  const endpoints = await discoverHip(config);
  const state = randomId();
  const codeVerifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(codeVerifier).digest());
  const safeReturnTo = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
  pendingHipLogins.set(state, { state, codeVerifier, returnTo: safeReturnTo, createdAt: Date.now() });
  const url = new URL(endpoints.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.hipClientId!);
  url.searchParams.set('redirect_uri', config.hipRedirectUri!);
  url.searchParams.set('scope', config.hipScopes || 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function formEncode(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function readJwtPayload(token: string): Record<string, any> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export async function completeHipLogin(state: string, code: string): Promise<{ context: AuthContext; cookie: string; returnTo: string }> {
  const config = getConfig();
  const pending = pendingHipLogins.get(state);
  pendingHipLogins.delete(state);
  if (!pending || pending.createdAt + LOGIN_STATE_TTL_MS < Date.now()) throw new UserAuthError(400, 'HIP login state is invalid or expired');
  if (!code) throw new UserAuthError(400, 'HIP did not return an authorization code');
  const endpoints = await discoverHip(config);
  try {
    const response = await axios.post(endpoints.token_endpoint, formEncode({
      grant_type: 'authorization_code',
      code,
      client_id: config.hipClientId!,
      redirect_uri: config.hipRedirectUri!,
      code_verifier: pending.codeVerifier,
      ...(config.hipClientSecret ? { client_secret: config.hipClientSecret } : {}),
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
    const accessToken = response.data?.access_token;
    if (!accessToken) throw new UserAuthError(502, 'HIP token response did not contain an access token');
    let profile: Record<string, any> = {};
    if (endpoints.userinfo_endpoint) {
      const profileResponse = await axios.get(endpoints.userinfo_endpoint, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 10000 });
      profile = profileResponse.data || {};
    } else {
      profile = readJwtPayload(response.data?.id_token || '') || {};
    }
    if (!profile.sub) throw new UserAuthError(502, 'HIP did not return a user identity');
    const context: AuthContext = { id: String(profile.sub), name: profile.name || profile.preferred_username, email: profile.email, authMode: 'hip', accessToken };
    const session = createSession(context, config);
    return { context, cookie: session.cookie, returnTo: pending.returnTo };
  } catch (error: any) {
    if (error instanceof UserAuthError) throw error;
    throw new UserAuthError(502, `HIP login failed: ${error.response?.data?.error_description || error.response?.status || error.message}`);
  }
}

export function clearSession(req: Request, config: AppConfig = getConfig()): string {
  const sessionId = getSessionId(req);
  if (sessionId) sessions.delete(sessionId);
  return `${SESSION_COOKIE}=; Max-Age=0; ${cookieFlags(config)}`;
}
