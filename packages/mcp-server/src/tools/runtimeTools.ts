import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FormbuilderApiClient } from '../apiClient.js';
import { toResult } from '../toolResult.js';

const runtimeMode = z.enum(['create', 'edit', 'view', 'prefill']);

/** Runtime tools: actually filling in and submitting forms/Compositions for
 * a patient, as opposed to designing them. launch_form is the recommended
 * entry point for "start this form for this patient" - it's the same
 * one-shot call a real embedding host makes, and internally creates the
 * session and optionally loads existing provider data in one step.
 * create_form_session is the lower-level primitive underneath it, for
 * finer-grained control. */
export function registerRuntimeTools(server: McpServer, api: FormbuilderApiClient): void {
  server.registerTool('launch_form', {
    title: 'Launch a form for a patient',
    description: 'Starts (or resumes) a form session for a patient in one call - the same entry point a real embedding host uses. Returns a session to then patch_form_session (save answers), validate_form_session, and submit_form_session_to_provider. Prefer this over create_form_session unless you need lower-level control.',
    inputSchema: {
      formId: z.string(),
      patient: z.object({ id: z.string(), namespace: z.string().optional() }),
      mode: runtimeMode.optional().describe('Defaults to "create". Use "edit" to resume/change a previously submitted composition, "view" for read-only, "prefill" to only prefill without persisting yet.'),
      initialValues: z.record(z.string(), z.unknown()).optional().describe('Field values to seed the session with, keyed by field id. Overrides anything the provider would have loaded.'),
      providerReference: z.string().optional().describe('An explicit openEHR composition version/reference to load, for edit mode.'),
      load: z.enum(['never', 'provider']).optional().describe('"provider" loads existing EHRbase data for this patient/form before returning (needed for edit/view of existing data).'),
      encounterId: z.string().optional(),
    },
  }, (input) => toResult(() => api.post('/api/form-launches', input)));

  server.registerTool('create_form_session', {
    title: 'Create a form session (low-level)',
    description: 'Creates a form session directly, without launch_form\'s provider-loading/initial-values convenience. Prefer launch_form for the normal "start this form for this patient" case.',
    inputSchema: {
      formId: z.string(),
      patientId: z.string(),
      patientNamespace: z.string().optional(),
      values: z.record(z.string(), z.unknown()).optional(),
      mode: runtimeMode.optional(),
      providerId: z.string().optional(),
      providerReference: z.string().optional(),
    },
  }, (input) => toResult(() => api.post('/api/form-sessions', input)));

  server.registerTool('list_form_sessions', {
    title: 'List form sessions',
    description: 'Lists form sessions, optionally filtered by patient and/or form.',
    inputSchema: { patientId: z.string().optional(), formId: z.string().optional() },
  }, ({ patientId, formId }) => toResult(() => {
    const query = new URLSearchParams({ ...(patientId ? { patientId } : {}), ...(formId ? { formId } : {}) }).toString();
    return api.get(`/api/form-sessions${query ? `?${query}` : ''}`);
  }));

  server.registerTool('get_form_session', {
    title: 'Get a form session',
    description: 'Fetches a form session\'s current status, values, and revision.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.get(`/api/form-sessions/${encodeURIComponent(id)}`)));

  server.registerTool('patch_form_session', {
    title: 'Save answers into a form session',
    description: 'Saves answers into a session (like autosave while a user is filling in a form). `values`, if given, REPLACES the session\'s entire values object - it is not merged with what\'s already stored, so include every field you want kept, not just the ones that changed (read get_form_session first if you only have a partial update and need to merge client-side). This matches the real web runtime, which always saves its full local form state on every autosave. Only "draft"/"in_progress"/"cancelled" are valid for status here - "ready"/"submitted"/"failed" are set automatically by validate_form_session/submit_form_session_to_provider and are rejected if passed here. Read get_form_session\'s revision first if you need optimistic concurrency (expectedRevision).',
    inputSchema: {
      id: z.string(),
      values: z.record(z.string(), z.unknown()).optional().describe('The session\'s complete field values, keyed by field id - this REPLACES the stored values, it does not merge. Include every field to keep, not just the ones that changed.'),
      status: z.enum(['draft', 'in_progress', 'cancelled']).optional().describe('"ready"/"submitted"/"failed" are not settable here - see validate_form_session/submit_form_session_to_provider.'),
      expectedRevision: z.number().optional(),
    },
  }, ({ id, ...body }) => toResult(() => api.patch(`/api/form-sessions/${encodeURIComponent(id)}`, body)));

  server.registerTool('validate_form_session', {
    title: 'Validate a form session',
    description: 'Runs the form\'s validation rules (including its formScript\'s validation logic) against the session\'s current values, without submitting. Check this before submit_form_session_to_provider.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.post(`/api/form-sessions/${encodeURIComponent(id)}/validate`)));

  server.registerTool('submit_form_session_to_provider', {
    title: 'Submit a form session',
    description: 'Submits a session\'s current values as a Composition to the data provider (EHRbase by default) - the actual "save this clinical data for real" step. Validate first; a stale/unvalidated submission can be rejected.',
    inputSchema: {
      id: z.string(),
      providerId: z.string().optional().describe('Defaults to "ehrbase".'),
      validatedRevision: z.number().optional().describe('The revision validate_form_session returned, to prove validation ran against the exact values being submitted.'),
    },
  }, ({ id, ...body }) => toResult(() => api.post(`/api/form-sessions/${encodeURIComponent(id)}/provider/submit`, body)));

  server.registerTool('load_form_session_from_provider', {
    title: 'Load provider data into a form session',
    description: 'Loads existing data for this session\'s patient/form from the data provider (EHRbase by default) into the session - for resuming/editing a previously submitted composition outside of launch_form\'s own load option.',
    inputSchema: { id: z.string(), providerId: z.string().optional() },
  }, ({ id, providerId }) => toResult(() => api.post(`/api/form-sessions/${encodeURIComponent(id)}/provider/load`, { providerId })));

  // Composition sessions: the runtime counterpart of a Composition-kind form
  // (see formTools.ts) - a session that composes several child form sessions
  // into one clinical document, e.g. one page/tab per child form.
  server.registerTool('start_composition_session', {
    title: 'Start a Composition session for a patient',
    description: 'Starts (or resumes, unless forceNew) a runtime session for a Composition-kind form, for a patient. Its blocks are then filled in by creating child form sessions (create_form_session/launch_form) and wiring each into the composition with attach_composition_block.',
    inputSchema: {
      compositionFormId: z.string(),
      patientId: z.string(),
      patientNamespace: z.string().optional(),
      ehrId: z.string().optional(),
      mode: runtimeMode.optional(),
      forceNew: z.boolean().optional(),
    },
  }, (input) => toResult(() => api.post('/api/composition-sessions', input)));

  server.registerTool('get_patient_composition_sessions', {
    title: 'List a patient\'s Composition sessions',
    description: 'Lists composition sessions for a given patient.',
    inputSchema: { patientId: z.string() },
  }, ({ patientId }) => toResult(() => api.get(`/api/composition-sessions?patientId=${encodeURIComponent(patientId)}`)));

  server.registerTool('get_composition_session', {
    title: 'Get a Composition session',
    description: 'Fetches a composition session, including which child form sessions are attached to which blocks.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.get(`/api/composition-sessions/${encodeURIComponent(id)}`)));

  server.registerTool('attach_composition_block', {
    title: 'Attach a form session to a Composition block',
    description: 'Wires an existing child form session (from create_form_session/launch_form) into one block of a composition session.',
    inputSchema: { id: z.string().describe('The composition session id.'), blockId: z.string(), childSessionId: z.string() },
  }, ({ id, blockId, childSessionId }) => toResult(() => api.put(`/api/composition-sessions/${encodeURIComponent(id)}/blocks/${encodeURIComponent(blockId)}`, { childSessionId })));

  server.registerTool('validate_composition_session', {
    title: 'Validate a Composition session',
    description: 'Runs the composition\'s own validation (including its composition script) across all attached child form sessions.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.post(`/api/composition-sessions/${encodeURIComponent(id)}/validate`)));
}
