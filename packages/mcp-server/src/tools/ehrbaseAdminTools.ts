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

  // FHIR CDR - a separate connector alongside EHRbase, same bearer token.
  // Patient/Encounter are created here directly as FHIR (openEHR has no
  // Composition-level "Encounter" concept for arrival/exit time, triage,
  // arrival mode, discharge disposition); clinical data with a real openEHR
  // template (Diagnosis, labs, ...) still goes through the normal Forms/
  // EHRbase pipeline and is only verified here afterwards.
  server.registerTool('get_fhir_cdr_metadata', {
    title: 'Get the FHIR CDR CapabilityStatement',
    description: 'Fetches the FHIR CDR connector\'s CapabilityStatement (GET /metadata) - use once to confirm reachability/auth before creating resources.',
    inputSchema: {},
  }, () => toResult(() => api.get('/api/admin/ehrbase/fhir-cdr/metadata')));

  server.registerTool('create_fhir_resource', {
    title: 'Create a FHIR resource on the FHIR CDR',
    description: 'POSTs a FHIR resource (e.g. Patient, Encounter) to the FHIR CDR connector. Returns the server\'s representation including the assigned id and any extensions (e.g. a linked openEHR EHR id) the connector adds on create - read those back before creating dependent resources (an Encounter needs the Patient\'s id in subject.reference).',
    inputSchema: {
      resourceType: z.string().describe('The FHIR resource type, e.g. "Patient" or "Encounter" - must match resource.resourceType.'),
      resource: z.record(z.string(), z.unknown()).describe('The complete FHIR resource body to create.'),
    },
  }, ({ resourceType, resource }) => toResult(() => api.post(`/api/admin/ehrbase/fhir-cdr/${encodeURIComponent(resourceType)}`, resource)));

  server.registerTool('get_fhir_resource', {
    title: 'Get a FHIR resource by id from the FHIR CDR',
    description: 'Fetches one FHIR resource by type and id from the FHIR CDR connector.',
    inputSchema: {
      resourceType: z.string(),
      id: z.string(),
    },
  }, ({ resourceType, id }) => toResult(() => api.get(`/api/admin/ehrbase/fhir-cdr/${encodeURIComponent(resourceType)}/${encodeURIComponent(id)}`)));

  server.registerTool('search_fhir_resource', {
    title: 'Search FHIR resources on the FHIR CDR',
    description: 'Searches a FHIR resource type on the FHIR CDR connector (GET /{resourceType}?...) and returns the raw Bundle. Use to verify that data written through openEHR/Forms actually surfaced as FHIR (e.g. search Condition by patient after submitting a Diagnosis composition).',
    inputSchema: {
      resourceType: z.string(),
      query: z.record(z.string(), z.string()).optional().describe('FHIR search parameters, e.g. { patient: "Patient/123", code: "..." }.'),
    },
  }, ({ resourceType, query }) => toResult(() => {
    const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query).toString()}` : '';
    return api.get(`/api/admin/ehrbase/fhir-cdr/${encodeURIComponent(resourceType)}${qs}`);
  }));

  // Debug log of every outbound FHIR/openEHR write Forms has made (see
  // apps/api's integrationCallLogService.ts) - a raw capture of the exact
  // request/response bodies for later curation into a Bruno collection.
  // Logging happens automatically on every real write; these tools only
  // browse/export what's already been captured.
  server.registerTool('list_integration_call_logs', {
    title: 'List logged FHIR/openEHR call payloads',
    description: 'Lists the outbound FHIR/openEHR write calls Forms has captured (request/response bodies not included - use get_integration_call_log for one entry\'s full payload). Filter by protocol/resourceType/success to find a specific call to build a Bruno request from.',
    inputSchema: {
      protocol: z.enum(['fhir', 'openehr']).optional(),
      resourceType: z.string().optional().describe('e.g. "Patient", "Encounter" for fhir; an openEHR templateId like "vg_Diagnosis.v1.1.1", or "contribution", for openehr.'),
      success: z.boolean().optional(),
      ehrId: z.string().optional().describe('Filter to calls for one openEHR EHR.'),
      patientId: z.string().optional().describe('Filter to calls for one patient (OR\'d with ehrId when both given).'),
      limit: z.number().optional().describe('Defaults to 50, capped at 200.'),
      offset: z.number().optional(),
    },
  }, ({ protocol, resourceType, success, ehrId, patientId, limit, offset }) => toResult(() => {
    const params = new URLSearchParams();
    if (protocol) params.set('protocol', protocol);
    if (resourceType) params.set('resourceType', resourceType);
    if (success !== undefined) params.set('success', String(success));
    if (ehrId) params.set('ehrId', ehrId);
    if (patientId) params.set('patientId', patientId);
    if (limit !== undefined) params.set('limit', String(limit));
    if (offset !== undefined) params.set('offset', String(offset));
    const qs = params.toString();
    return api.get(`/api/admin/ehrbase/call-logs${qs ? `?${qs}` : ''}`);
  }));

  server.registerTool('get_integration_call_log', {
    title: 'Get one logged FHIR/openEHR call in full',
    description: 'Fetches one captured call log by id, including its full request and response bodies - the actual payload to turn into a Bruno request. Get the id from list_integration_call_logs first.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.get(`/api/admin/ehrbase/call-logs/${encodeURIComponent(id)}`)));
}
