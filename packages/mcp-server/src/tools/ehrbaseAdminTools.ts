import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FormbuilderApiClient } from '../apiClient.js';
import { toResult } from '../toolResult.js';

/** Direct EHRbase access for design-time/debugging use (the openEHR
 * architect role) - as opposed to the form/patient/runtime tools, which only
 * ever go through Forms' own curated APIs. Everything else an agent needs
 * (import a template, create a patient/EHR, submit a Composition) is already
 * covered there; these two exist for the gap that's left: inspecting a
 * template before deciding to import it, and ad-hoc AQL for debugging what's
 * actually in EHRbase. Both require Forms ADMIN (system.configure). */
export function registerEhrbaseAdminTools(server: McpServer, api: FormbuilderApiClient): void {
  server.registerTool('get_remote_template_detail', {
    title: 'Get a remote WebTemplate\'s full structure',
    description: 'Fetches the full WebTemplate JSON (every field, path, RM type) for a template on the active EHRbase connection, whether or not it\'s been imported into Forms yet. Use this to decide whether a template is right for a form before import_remote_template/generate_form_from_template, or to see what get_template_fields would show after importing.',
    inputSchema: { templateId: z.string() },
  }, ({ templateId }) => toResult(() => api.get(`/api/admin/ehrbase/remote-templates/${encodeURIComponent(templateId)}`)));

  server.registerTool('get_remote_template_opt', {
    title: 'Get a remote template\'s raw OPT XML',
    description: 'Fetches the raw Operational Template (ADL2 XML) for a template on the active EHRbase connection - the actual C_ARCHETYPE_ROOT/C_COMPLEX_OBJECT/C_CODE_PHRASE/term_definitions/component_ontologies/term_bindings source. Unlike get_remote_template_detail (the already-flattened, single-language WebTemplate JSON), this carries multi-language term definitions, term bindings, and the fixed name/value constraints that disambiguate two C_ARCHETYPE_ROOTs sharing the same archetype id.',
    inputSchema: { templateId: z.string() },
  }, ({ templateId }) => toResult(() => api.get(`/api/admin/ehrbase/remote-templates/${encodeURIComponent(templateId)}/opt`)));

  server.registerTool('run_aql_query', {
    title: 'Run an ad-hoc AQL query against EHRbase',
    description: 'Executes an arbitrary read AQL query against the active EHRbase connection and returns the rows. For debugging/inspection (e.g. "what did that last submission actually store?") - runtime forms/plugins use the separate, curated AQL Function system instead, not this. Use named parameters (:paramName) rather than string-building values into the query.',
    inputSchema: {
      query: z.string().describe('An AQL SELECT query. Use :paramName placeholders for values, bound via the parameters argument.'),
      parameters: z.record(z.string(), z.unknown()).optional(),
    },
  }, ({ query, parameters }) => toResult(() => api.post('/api/admin/ehrbase/aql', { query, parameters })));
}
