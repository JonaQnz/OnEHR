import argon2 from 'argon2';
import { ApplicationRole as DbRole } from '@prisma/client';
import type { Principal } from 'core';
import prisma from '../db/prisma';
import { permissionsForRoles, type ApplicationRole } from './authorizationService';
import { writeAuditEvent } from './auditService';

const PASSWORD_OPTIONS: argon2.Options & { type: typeof argon2.argon2id } = {
  type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
};
const LOCAL_ISSUER = 'forms:local';

type UserWithRoles = {
  id: string; username: string | null; displayName: string | null; email: string | null;
  status: 'active' | 'inactive'; passwordHash: string | null;
  roles: Array<{ role: 'USER' | 'ADMIN' }>;
};

export interface PublicUser {
  id: string; username?: string; displayName?: string; email?: string; status: 'active' | 'inactive'; roles: ApplicationRole[]; lastLoginAt?: string;
}

function assertUsername(username: string): string {
  const value = username.trim();
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(value)) throw new UserServiceError(400, 'Username must contain 3–80 letters, numbers, dots, underscores, or dashes');
  return value;
}
function assertPassword(password: string, minimumLength = 12): string {
  if (password.length < minimumLength) throw new UserServiceError(400, `Password must contain at least ${minimumLength} characters`);
  return password;
}
function rolesOf(user: UserWithRoles): ApplicationRole[] {
  const roles = user.roles.map((entry) => entry.role as ApplicationRole);
  return roles.length ? roles : ['USER'];
}
export function toPrincipal(user: UserWithRoles, source: Principal['authSource'], subject = user.username || user.id, issuer = LOCAL_ISSUER): Principal {
  const roles = rolesOf(user);
  return { userId: user.id, subject, issuer, authSource: source, ...(user.displayName ? { displayName: user.displayName } : {}), ...(user.email ? { email: user.email } : {}), roles, permissions: permissionsForRoles(roles) };
}
function publicUser(user: UserWithRoles & { lastLoginAt?: Date | null }): PublicUser {
  return { id: user.id, ...(user.username ? { username: user.username } : {}), ...(user.displayName ? { displayName: user.displayName } : {}), ...(user.email ? { email: user.email } : {}), status: user.status, roles: rolesOf(user), ...(user.lastLoginAt ? { lastLoginAt: user.lastLoginAt.toISOString() } : {}) };
}

export class UserServiceError extends Error { constructor(public readonly status: number, message: string) { super(message); } }

export async function findLocalUser(username: string): Promise<UserWithRoles | null> {
  return prisma.applicationUser.findUnique({ where: { username }, include: { roles: true } }) as Promise<UserWithRoles | null>;
}
export async function verifyLocalPassword(username: string, password: string): Promise<Principal | null> {
  const user = await findLocalUser(username.trim());
  // Verify an Argon2 hash even for an unknown account to reduce timing signals.
  const hash = user?.passwordHash || await argon2.hash('not-a-real-password', PASSWORD_OPTIONS);
  const valid = await argon2.verify(hash, password);
  if (!user || !valid || user.status !== 'active') return null;
  await prisma.applicationUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  return toPrincipal(user, 'local');
}

export async function listUsers(): Promise<PublicUser[]> {
  const users = await prisma.applicationUser.findMany({ include: { roles: true }, orderBy: { createdAt: 'asc' } });
  return users.map((user) => publicUser(user as UserWithRoles & { lastLoginAt?: Date | null }));
}
export async function createLocalUser(input: { username: string; password: string; displayName?: string; email?: string; roles?: ApplicationRole[]; allowWeakBootstrapPassword?: boolean }, actorUserId?: string): Promise<PublicUser> {
  const username = assertUsername(input.username);
  const passwordHash = await argon2.hash(assertPassword(input.password, input.allowWeakBootstrapPassword ? 1 : 12), PASSWORD_OPTIONS);
  const roles: DbRole[] = input.roles?.includes('ADMIN') ? [DbRole.ADMIN] : [DbRole.USER];
  try {
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.applicationUser.create({ data: { username, passwordHash, displayName: input.displayName?.trim() || null, email: input.email?.trim() || null, roles: { create: roles.map((role) => ({ role })) }, }, include: { roles: true } });
      await tx.auditEvent.create({ data: { ...(actorUserId ? { actorUserId } : {}), action: 'user.created', resourceType: 'user', resourceId: created.id, metadata: { roles } } });
      return created;
    });
    return publicUser(user as unknown as UserWithRoles & { lastLoginAt?: Date | null });
  } catch (error: any) {
    if (error?.code === 'P2002') throw new UserServiceError(409, 'Username already exists');
    throw error;
  }
}
/** How many OTHER active users (besides `excludeUserId`) currently hold
 * ADMIN - used to guard against ever leaving the system with zero active
 * admins, whether via a role change away from ADMIN or a deactivation.
 * Read inside the caller's own transaction so the check and the write it
 * gates see a consistent snapshot. */
async function countOtherActiveAdmins(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], excludeUserId: string): Promise<number> {
  return tx.applicationUser.count({ where: { id: { not: excludeUserId }, status: 'active', roles: { some: { role: DbRole.ADMIN } } } });
}

export async function updateUser(id: string, input: { displayName?: string; email?: string; roles?: ApplicationRole[] }, actorUserId?: string): Promise<PublicUser> {
  const roles: DbRole[] | undefined = input.roles?.includes('ADMIN') ? [DbRole.ADMIN] : input.roles ? [DbRole.USER] : undefined;
  try {
    const user = await prisma.$transaction(async (tx) => {
      // QA review finding: nothing stopped an admin from demoting the sole
      // remaining ADMIN (themselves or someone else) to USER, locking the
      // whole system out of user.manage with no recovery besides
      // redeploying with FORMS_BOOTSTRAP_ADMIN_* env vars.
      if (roles && !roles.includes(DbRole.ADMIN)) {
        const current = await tx.applicationUser.findUnique({ where: { id }, include: { roles: true } });
        const wasAdmin = current?.roles.some((entry) => entry.role === DbRole.ADMIN);
        if (wasAdmin && (await countOtherActiveAdmins(tx, id)) === 0) {
          throw new UserServiceError(409, 'Cannot remove ADMIN from the last remaining active administrator.');
        }
      }
      const updated = await tx.applicationUser.update({ where: { id }, data: { ...(input.displayName !== undefined ? { displayName: input.displayName.trim() || null } : {}), ...(input.email !== undefined ? { email: input.email.trim() || null } : {}), ...(roles ? { roles: { deleteMany: {}, create: roles.map((role) => ({ role })) } } : {}) }, include: { roles: true } });
      await tx.auditEvent.create({ data: { ...(actorUserId ? { actorUserId } : {}), action: roles ? 'user.role-changed' : 'user.updated', resourceType: 'user', resourceId: id, metadata: roles ? { roles } : {} } });
      return updated;
    });
    return publicUser(user as unknown as UserWithRoles & { lastLoginAt?: Date | null });
  } catch (error: any) { if (error?.code === 'P2025') throw new UserServiceError(404, 'User not found'); throw error; }
}
export async function setUserStatus(id: string, active: boolean, actorUserId?: string): Promise<PublicUser> {
  // Same QA finding as updateUser above: an admin could deactivate their
  // own account (no recovery besides another admin, or nobody if they
  // were the last one) or deactivate the last remaining active admin.
  // Self-deactivation is blocked outright - there is never a legitimate
  // reason to deactivate your own account through this endpoint.
  if (!active && actorUserId && id === actorUserId) throw new UserServiceError(400, 'You cannot deactivate your own account.');
  try {
    const user = await prisma.$transaction(async (tx) => {
      if (!active) {
        const current = await tx.applicationUser.findUnique({ where: { id }, include: { roles: true } });
        const isAdmin = current?.roles.some((entry) => entry.role === DbRole.ADMIN);
        if (isAdmin && (await countOtherActiveAdmins(tx, id)) === 0) {
          throw new UserServiceError(409, 'Cannot deactivate the last remaining active administrator.');
        }
      }
      const updated = await tx.applicationUser.update({ where: { id }, data: { status: active ? 'active' : 'inactive' }, include: { roles: true } });
      if (!active) await tx.applicationSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.auditEvent.create({ data: { ...(actorUserId ? { actorUserId } : {}), action: active ? 'user.activated' : 'user.deactivated', resourceType: 'user', resourceId: id } });
      return updated;
    });
    return publicUser(user as unknown as UserWithRoles & { lastLoginAt?: Date | null });
  } catch (error: any) { if (error?.code === 'P2025') throw new UserServiceError(404, 'User not found'); throw error; }
}
export async function resetPassword(id: string, password: string, actorUserId?: string): Promise<void> {
  const passwordHash = await argon2.hash(assertPassword(password), PASSWORD_OPTIONS);
  try {
    await prisma.$transaction(async (tx) => { await tx.applicationUser.update({ where: { id }, data: { passwordHash } }); await tx.applicationSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }); await tx.auditEvent.create({ data: { ...(actorUserId ? { actorUserId } : {}), action: 'user.password-reset', resourceType: 'user', resourceId: id } }); });
  } catch (error: any) { if (error?.code === 'P2025') throw new UserServiceError(404, 'User not found'); throw error; }
}
export async function revokeUserSessions(id: string, actorUserId?: string): Promise<void> { await prisma.$transaction(async (tx) => { await tx.applicationSession.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }); await tx.auditEvent.create({ data: { ...(actorUserId ? { actorUserId } : {}), action: 'auth.session.revoked', resourceType: 'user', resourceId: id } }); }); }

/** Pure core of "should an existing user's stored roles be overwritten by
 * what the identity provider just asserted": no roles asserted (undefined)
 * means the caller isn't a source of truth for roles and nothing changes;
 * otherwise the DB is only touched when the resulting set actually differs,
 * so a login doesn't churn out no-op writes/audit events every time. */
export function computeRoleSync(currentRoles: ApplicationRole[], inputRoles: ApplicationRole[] | undefined): { desiredRoles?: DbRole[]; changed: boolean } {
  if (inputRoles === undefined) return { changed: false };
  const desiredRoles: DbRole[] = inputRoles.includes('ADMIN') ? [DbRole.ADMIN] : [DbRole.USER];
  const changed = desiredRoles.length !== currentRoles.length || desiredRoles.some((role) => !currentRoles.includes(role as ApplicationRole));
  return { desiredRoles, changed };
}

export async function resolveExternalIdentity(input: { issuer: string; subject: string; displayName?: string; email?: string; roles?: string[] }): Promise<Principal> {
  const existing = await prisma.identityLink.findUnique({ where: { issuer_externalSubject: { issuer: input.issuer, externalSubject: input.subject } }, include: { user: { include: { roles: true } } } });
  if (existing) {
    const user = existing.user as UserWithRoles;
    if (user.status !== 'active') throw new UserServiceError(403, 'User account is inactive');
    // The identity provider (Keycloak/HIP) is the source of truth for this
    // user's roles on every login, not just at account creation - otherwise a
    // role granted (or revoked) upstream after the first login would never
    // take effect here.
    const { desiredRoles, changed: rolesChanged } = computeRoleSync(rolesOf(user), input.roles as ApplicationRole[] | undefined);
    const updated = await prisma.$transaction(async (tx) => {
      await tx.identityLink.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } });
      const result = await tx.applicationUser.update({ where: { id: user.id }, data: { displayName: input.displayName || user.displayName, email: input.email || user.email, lastLoginAt: new Date(), ...(rolesChanged ? { roles: { deleteMany: {}, create: desiredRoles!.map((role) => ({ role })) } } : {}) }, include: { roles: true } });
      if (rolesChanged) await tx.auditEvent.create({ data: { actorUserId: user.id, action: 'user.role-changed', resourceType: 'user', resourceId: user.id, metadata: { roles: desiredRoles, source: 'hip-keycloak-login' } } });
      return result;
    });
    return toPrincipal(updated as unknown as UserWithRoles, 'oidc', input.subject, input.issuer);
  }
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.applicationUser.create({ data: { displayName: input.displayName || null, email: input.email || null, roles: { create: [{ role: input.roles?.includes('ADMIN') ? 'ADMIN' : 'USER' }] }, identities: { create: { issuer: input.issuer, externalSubject: input.subject } }, lastLoginAt: new Date() }, include: { roles: true } });
    await tx.auditEvent.create({ data: { action: 'user.created', resourceType: 'user', resourceId: user.id, metadata: { authSource: 'oidc', issuer: input.issuer } } });
    return user;
  });
  return toPrincipal(created as UserWithRoles, 'oidc', input.subject, input.issuer);
}
