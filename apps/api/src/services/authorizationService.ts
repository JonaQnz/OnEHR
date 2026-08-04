import type { Principal } from 'core';

export const ROLE_PERMISSIONS = {
  USER: [
    'patient.search', 'patient.read', 'form.execute', 'form-session.read-own',
    'form-session.write-own', 'composition.read', 'composition.write',
  ],
  ADMIN: [
    'form.design', 'form.publish', 'plugin.configure', 'system.configure',
    'user.manage', 'audit.read',
  ],
} as const;

export type ApplicationRole = keyof typeof ROLE_PERMISSIONS;
export type Permission = (typeof ROLE_PERMISSIONS)[ApplicationRole][number];

export function permissionsForRoles(roles: readonly string[]): string[] {
  const permissions = new Set<string>();
  for (const permission of ROLE_PERMISSIONS.USER) permissions.add(permission);
  if (roles.includes('ADMIN')) for (const permission of ROLE_PERMISSIONS.ADMIN) permissions.add(permission);
  return [...permissions].sort();
}

export function hasPermission(principal: Principal, permission: string): boolean {
  return principal.permissions.includes(permission);
}

export function requirePermission(principal: Principal | undefined, permission: string): void {
  if (!principal) throw new AuthorizationError(401, 'Authentication required');
  if (!hasPermission(principal, permission)) throw new AuthorizationError(403, 'Permission denied');
}

export class AuthorizationError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
