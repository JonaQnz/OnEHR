#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTemplateTools } from './tools/templateTools.js';
import { registerDocumentTemplateTools } from './tools/documentTemplateTools.js';

async function main(): Promise<void> {
  const server = new McpServer({ name: 'openehr-architect-mcp', version: '1.0.0' }, {
    instructions:
      'Direct access to EHRbase\'s own openEHR Definitions REST API (/definition/template/adl1.4) for authoring '
      + 'openEHR Operational Templates - separate from, and external to, the Forms app itself (packages/mcp-server, '
      + 'the "formbuilder" MCP, only ever reads templates already registered on EHRbase). '
      + 'No self-hostable template-design tool with a public authoring API exists in the openEHR ecosystem today '
      + '(researched: Better\'s Archetype Designer is GUI-only SaaS with no authoring API, LinkEHR has no public '
      + 'self-host/API story, everything else - ADL Workbench, Archetype Editor, Ocean Template Designer - is a '
      + 'Windows desktop app) - EHRbase\'s own definitions endpoint is the one genuine, already-running external '
      + 'API for this, so these tools are a thin, direct bridge to it. '
      + 'Typical new-template loop: list_ehrbase_templates to see what exists -> get_ehrbase_template_opt on the '
      + 'closest existing template as a structural reference -> compose the new OPT XML yourself from that '
      + 'reference -> upload_ehrbase_template (EHRbase\'s own validation is the safety net: a malformed OPT comes '
      + 'back as a 4xx with the reason) -> get_ehrbase_template_webtemplate to confirm the resulting field '
      + 'structure -> the formbuilder MCP\'s import_remote_template to bring it into Forms and build a form on it. '
      + 'For a new document assembled from reusable building blocks you have already published this way (e.g. a '
      + 'discharge letter composed of separately-authored Diagnoses/Medication/Synopsis archetypes), use '
      + 'compose_document_template instead of hand-authoring the combined OPT - it resolves each named archetype '
      + 'out of its own already-uploaded source template and compiles them into one new OPT/COMPOSITION, without '
      + 'renumbering any of their at-codes.',
  });

  registerTemplateTools(server);
  registerDocumentTemplateTools(server);

  await server.connect(new StdioServerTransport());
}

void main().catch((error) => {
  console.error('[openehr-architect-mcp] fatal startup error', error);
  process.exitCode = 1;
});
