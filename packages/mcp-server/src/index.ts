#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FormbuilderApiClient, loadConfigFromEnv } from './apiClient.js';
import { registerFormTools } from './tools/formTools.js';
import { registerPatientTools } from './tools/patientTools.js';
import { registerRuntimeTools } from './tools/runtimeTools.js';
import { registerEhrbaseAdminTools } from './tools/ehrbaseAdminTools.js';

// Credentials live only in the repo-root .env (gitignored, see
// docs/authentication.md) - never in .mcp.json, which is normally committed.
// This mirrors apps/api/src/index.ts's own dotenv loading.
const packageDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(packageDir, '..', '..', '..', '.env') });

async function main(): Promise<void> {
  const api = new FormbuilderApiClient(loadConfigFromEnv());
  const server = new McpServer({ name: 'formbuilder-mcp-server', version: '1.0.0' }, {
    instructions:
      'Tools for the onEHR Form Builder / Composition Builder / patient / form-runtime APIs. '
      + 'A Composition is a Form with kind "composition" - there is no separate Composition entity. '
      + 'Typical form-editing loop: get_form (or create_form) -> edit the canonical_json object -> '
      + 'check_form_script if it has a formScript -> update_form with the full modified object -> publish_form when ready.',
  });

  registerFormTools(server, api);
  registerPatientTools(server, api);
  registerRuntimeTools(server, api);
  registerEhrbaseAdminTools(server, api);

  await server.connect(new StdioServerTransport());
}

void main().catch((error) => {
  console.error('[formbuilder-mcp-server] fatal startup error', error);
  process.exitCode = 1;
});
