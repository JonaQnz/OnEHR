import type { Principal } from 'core';

export const ROLE_PERMISSIONS = {
  USER: [
    'patient.search', 'patient.read', 'form.execute', 'form-session.read-own',
    'form-session.write-own', 'composition.read', 'composition.write',
    // Any clinician filling in a form needs to search/validate against a
    // configured terminology binding - same tier as form.execute, not an
    // admin concern (managing/publishing the terminology itself is).
    'terminology.read',
  ],
  ADMIN: [
    'form.design', 'form.publish', 'plugin.configure', 'system.configure',
    'user.manage', 'audit.read',
    // terminology.manage: create/edit a custom terminology's draft concepts.
    // terminology.publish: freeze a draft as an immutable version / retire a
    // published one - kept separate from terminology.manage (mirrors
    // form.design vs form.publish) since publishing has broader, harder-to-
    // undo downstream impact (forms may already be pinned to a version).
    'terminology.manage', 'terminology.publish',
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
