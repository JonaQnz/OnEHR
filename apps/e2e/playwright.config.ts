import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The same root .env docker-compose.yml already reads for local dev
// credentials (gitignored, never committed) - reused here rather than
// inventing a second credential file, so there's exactly one place to set
// up local login for this whole repo.
loadEnv({ path: path.resolve(here, '../../.env') });

const WEB_BASE_URL = process.env.E2E_BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'dot' : 'list',
  // Runs once before the whole suite: logs in via the same non-interactive
  // /api/auth/login the MCP server uses (see packages/mcp-server/src/
  // apiClient.ts) instead of automating the real HIP/Keycloak redirect UI,
  // and saves the resulting session cookie to STORAGE_STATE_PATH for every
  // test below to reuse - one login for the whole run, not one per test.
  globalSetup: './global-setup.ts',
  use: {
    baseURL: WEB_BASE_URL,
    storageState: path.resolve(here, '.auth/storage-state.json'),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
