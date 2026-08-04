/** The normalized Forms identity used after all authentication methods. */
export interface Principal {
  userId: string;
  subject: string;
  issuer: string;
  authSource: 'local' | 'oidc' | 'launch' | `plugin:${string}`;
  displayName?: string;
  email?: string;
  roles: string[];
  permissions: string[];
}
