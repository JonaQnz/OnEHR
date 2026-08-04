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
export async function updateUser(id: string, input: { displayName?: string; email?: string; roles?: ApplicationRole[] }, actorUserId?: string): Promise<PublicUser> {
  const roles: DbRole[] | undefined = input.roles?.includes('ADMIN') ? [DbRole.ADMIN] : input.roles ? [DbRole.USER] : undefined;
  try {
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.applicationUser.update({ where: { id }, data: { ...(input.displayName !== undefined ? { displayName: input.displayName.trim() || null } : {}), ...(input.email !== undefined ? { email: input.email.trim() || null } : {}), ...(roles ? { roles: { deleteMany: {}, create: roles.map((role) => ({ role })) } } : {}) }, include: { roles: true } });
      await tx.auditEvent.create({ data: { ...(actorUserId ? { actorUserId } : {}), action: roles ? 'user.role-changed' : 'user.updated', resourceType: 'user', resourceId: id, metadata: roles ? { roles } : {} } });
      return updated;
    });
    return publicUser(user as unknown as UserWithRoles & { lastLoginAt?: Date | null });
  } catch (error: any) { if (error?.code === 'P2025') throw new UserServiceError(404, 'User not found'); throw error; }
}
export async function setUserStatus(id: string, active: boolean, actorUserId?: string): Promise<PublicUser> {
  try {
    const user = await prisma.$transaction(async (tx) => {
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

export async function resolveExternalIdentity(input: { issuer: string; subject: string; displayName?: string; email?: string; roles?: string[] }): Promise<Principal> {
  const existing = await prisma.identityLink.findUnique({ where: { issuer_externalSubject: { issuer: input.issuer, externalSubject: input.subject } }, include: { user: { include: { roles: true } } } });
  if (existing) {
    const user = existing.user as UserWithRoles;
    if (user.status !== 'active') throw new UserServiceError(403, 'User account is inactive');
    await prisma.$transaction([prisma.identityLink.update({ where: { id: existing.id }, data: { lastSeenAt: new Date() } }), prisma.applicationUser.update({ where: { id: user.id }, data: { displayName: input.displayName || user.displayName, email: input.email || user.email, lastLoginAt: new Date() } })]);
    return toPrincipal(user, 'oidc', input.subject, input.issuer);
  }
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.applicationUser.create({ data: { displayName: input.displayName || null, email: input.email || null, roles: { create: [{ role: input.roles?.includes('ADMIN') ? 'ADMIN' : 'USER' }] }, identities: { create: { issuer: input.issuer, externalSubject: input.subject } }, lastLoginAt: new Date() }, include: { roles: true } });
    await tx.auditEvent.create({ data: { action: 'user.created', resourceType: 'user', resourceId: user.id, metadata: { authSource: 'oidc', issuer: input.issuer } } });
    return user;
  });
  return toPrincipal(created as UserWithRoles, 'oidc', input.subject, input.issuer);
}
