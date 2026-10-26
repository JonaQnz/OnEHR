import path from 'node:path';
import dotenv from 'dotenv';

// Credentials live only in the main repo's root .env (gitignored) - never in
// this project's own files. This project reuses the same admin login the
// existing formbuilder-mcp-server already authenticates with (see
// packages/mcp-server/src/apiClient.ts), rather than provisioning a separate
// service account. This file always compiles to dist/config.js directly
// (rootDir: src, no subdirectory), so __dirname is always backend/dist -
// every other module reaches this same, single dotenv.config() call via
// loadConfig() below rather than resolving the path again themselves.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '..', '.env') });

export interface WorkbenchConfig {
  port: number;
  webOrigin: string;
  formbuilderApiUrl: string;
  /** The Form Builder's own web app (not its API) - needed only to build an
   * iframe src for embedding a Composition read-only
   * (openehr/capabilityBridge.ts's getViewEmbedUrl). The person operating
   * this workbench's UI must be logged into that web app in the same
   * browser for the embed to render - a separate, personal session from
   * this backend's own service-account API login. */
  formbuilderWebUrl: string;
  formbuilderUsername: string;
  formbuilderPassword: string;
  anthropicApiKey?: string;
  /** The autonomous doctor agent's own LLM - user's explicit ask: OpenAI,
   * not Anthropic (see autonomy/doctorAgent.ts). Undefined until the user
   * adds OPENAI_API_KEY to the root .env themselves - autonomy stays
   * disabled/unavailable (surfaced via GET /api/health's openaiConfigured)
   * until then, never a hard failure at boot. */
  openaiApiKey?: string;
  /** Cheap/fast enough for a bounded, single-tool-call decision each visit;
   * overridable without a code change for whoever wants a stronger model. */
  openaiModel: string;
  dataDir: string;
  /** Blueprints/scenarios are plain YAML data, not TypeScript - tsc never
   * copies them into dist/, so this always points back at the source tree
   * (backend/src/fhir/blueprints, backend/scenarios), both here and in
   * every test that loads one. */
  blueprintsDir: string;
  scenariosDir: string;
}

export function loadConfig(): WorkbenchConfig {
  const username = process.env.FORMBUILDER_MCP_USERNAME || process.env.FORMS_BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.FORMBUILDER_MCP_PASSWORD || process.env.FORMS_BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error(
      'Missing Forms credentials: set FORMBUILDER_MCP_USERNAME/FORMBUILDER_MCP_PASSWORD (or reuse '
      + 'FORMS_BOOTSTRAP_ADMIN_USERNAME/FORMS_BOOTSTRAP_ADMIN_PASSWORD) in the main repo\'s root .env.',
    );
  }
  return {
    port: Number(process.env.WORKBENCH_PORT || 4500),
    webOrigin: process.env.WORKBENCH_WEB_ORIGIN || 'http://localhost:5190',
    formbuilderApiUrl: (process.env.FORMBUILDER_API_URL || 'http://localhost:3001').replace(/\/$/, ''),
    formbuilderWebUrl: (process.env.FORMBUILDER_WEB_URL || 'http://localhost:3000').replace(/\/$/, ''),
    formbuilderUsername: username,
    formbuilderPassword: password,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    dataDir: process.env.WORKBENCH_DATA_DIR || path.resolve(__dirname, '..', 'data'),
    blueprintsDir: path.resolve(__dirname, '..', 'src', 'fhir', 'blueprints'),
    scenariosDir: path.resolve(__dirname, '..', 'scenarios'),
  };
}
