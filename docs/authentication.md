# Forms authentication and user management

Forms owns application authentication, authorization and its opaque server-side session. System connection plugins own only their target-system credentials. The active EHRbase or HIP connection is never a Forms browser session.

## Bootstrap the first administrator

Before the first start with local authentication, set these environment variables once:

```text
FORMS_BOOTSTRAP_ADMIN_USERNAME=admin-name
FORMS_BOOTSTRAP_ADMIN_PASSWORD=a-long-unique-password-of-at-least-12-characters
FORMS_BOOTSTRAP_ADMIN_DISPLAY_NAME=Forms Administrator
```

The API creates the account only when no ADMIN role exists. It hashes the password with Argon2id and does not log it. Remove `FORMS_BOOTSTRAP_ADMIN_PASSWORD` after the first successful start; subsequent administrators are managed in **Users**.

The existing `LOCAL_AUTH_USERNAME` and `LOCAL_AUTH_PASSWORD` are accepted only as a one-time compatibility bootstrap source. They are no longer checked for every login.

The normal policy requires 12 characters. A shorter password is accepted only for an explicit bootstrap outside production, so a local demo can be set up without weakening password changes or user administration.

## Modes

`USER_AUTH_MODE=local` (default) uses Forms accounts. `USER_AUTH_MODE=hip` displays a username/password login and asks the active HIP / Keycloak system-connection plugin for a Keycloak token. A successful token response creates or resolves a local shadow user by the plugin's stable `issuer + subject`; the token is discarded and never reaches the browser. No separate HIP issuer, discovery, callback URL or client configuration exists in Forms. `disabled-development-only` is accepted only outside production and must never be used for deployments.

Set `SESSION_LIFETIME_MINUTES` to change the server-side session lifetime (default: 480 minutes).

## Security properties

- Browser cookie: opaque id, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `SESSION_COOKIE_SECURE=true`.
- Passwords use Argon2id; hashes and tokens are never returned by APIs or put in plugin/browser contexts.
- Deactivating a user and resetting a password revoke all active sessions.
- HIP credentials are checked only by the active HIP / Keycloak system plugin. The returned access token is not persisted, exposed to the browser or forwarded to Forms plugins.
- Audit events cover authentication and user administration. Target-system authentication remains inside the relevant system connection plugin.
