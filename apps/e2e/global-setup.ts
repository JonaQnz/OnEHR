import { request } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE_PATH = path.resolve(here, '.auth/storage-state.json');
const API_BASE_URL = process.env.E2E_API_URL || 'http://localhost:3001';

/** Logs in once via POST /api/auth/login - the same non-interactive,
 * password-based session-cookie login packages/mcp-server/src/apiClient.ts
 * already uses, deliberately not automating the real HIP/Keycloak redirect
 * UI (fragile to couple E2E tests to an external IdP's own login page, and
 * the backend already supports this direct path for exactly this kind of
 * caller). Cookie has no Domain attribute (HttpOnly; Path=/; SameSite=Lax -
 * see userAuthService.ts's cookieFlags), so it applies to `localhost`
 * regardless of port and is valid for the web app on :3000 too, same as
 * every already-shipped page's own `credentials: 'include'` fetches to the
 * API on :3001 already rely on. */
export default async function globalSetup(): Promise<void> {
  const username = process.env.E2E_ADMIN_USERNAME || process.env.FORMBUILDER_MCP_USERNAME || process.env.FORMS_BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.E2E_ADMIN_PASSWORD || process.env.FORMBUILDER_MCP_PASSWORD || process.env.FORMS_BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'Missing E2E login credentials: set E2E_ADMIN_USERNAME/E2E_ADMIN_PASSWORD in the root .env '
      + '(or reuse the existing FORMBUILDER_MCP_USERNAME/PASSWORD or FORMS_BOOTSTRAP_ADMIN_USERNAME/PASSWORD - '
      + 'see playwright.config.ts for where that file is loaded from).',
    );
  }
  const context = await request.newContext({ baseURL: API_BASE_URL });
  const response = await context.post('/api/auth/login', { data: { username, password } });
  if (!response.ok()) {
    throw new Error(`E2E login failed (${response.status()}): ${await response.text()}`);
  }
  await context.storageState({ path: STORAGE_STATE_PATH });
  await context.dispose();
}
