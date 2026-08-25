import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FormbuilderApiClient } from '../apiClient.js';
import { toResult } from '../toolResult.js';

/** Patient registry tools. Patients are Forms' own local record, kept in
 * sync with (but distinct from) EHRbase. sync_patients discovers *every*
 * EHR that exists on the active EHRbase connection - not just ones Forms
 * already knew about - and reads real demographics from a Person
 * Composition where one exists, falling back to a bare stub (name
 * "Unbekannt") for an EHR that has none yet. Each patient carries an
 * `origin`: "native" was created in Forms (create_patient); "imported" was
 * discovered on EHRbase by sync_patients and has no Forms-authored data
 * yet. An imported patient automatically becomes native the moment a form
 * is actually launched/created for them - that flip is one-way, a later
 * sync never reverts it back to imported. */
export function registerPatientTools(server: McpServer, api: FormbuilderApiClient): void {
  server.registerTool('list_patients', {
    title: 'List patients',
    description: 'Lists every patient known to Forms\' local registry - both natively created ones and ones discovered on EHRbase via sync_patients - each with its ehrId, `origin` ("native"/"imported"), and demographics where known.',
    inputSchema: {},
  }, () => toResult(() => api.get('/api/patients')));

  server.registerTool('get_patient', {
    title: 'Get a patient',
    description: 'Fetches one patient by id.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.get(`/api/patients/${encodeURIComponent(id)}`)));

  server.registerTool('create_patient', {
    title: 'Create a patient',
    description: 'Registers a new patient in Forms\' local registry with origin "native" and creates its EHR on EHRbase right away (unlike an imported patient, a native one does not need sync_patients to get an ehrId).',
    inputSchema: {
      patientId: z.string().describe('A stable external patient identifier (e.g. an MRN), not a database id.'),
      firstName: z.string(),
      lastName: z.string(),
      birthDate: z.string().optional().describe('ISO date, e.g. "1990-05-14".'),
      gender: z.string().optional(),
    },
  }, (input) => toResult(() => api.post('/api/patients', input)));

  server.registerTool('sync_patients', {
    title: 'Sync patients from EHRbase',
    description: 'Discovers every EHR on the active EHRbase connection (via `SELECT e/ehr_id/value FROM EHR e`, not just ones with Forms-recognizable data) and upserts Forms\' local patient registry: real demographics where a Person Composition exists, a bare "Unbekannt" stub with origin "imported" otherwise. Never downgrades a patient that has already become "native". Run this to pick up patients/EHRs that originated outside Forms, or after a patient gets an EHR record in EHRbase, before trying to launch a form for them.',
    inputSchema: {},
  }, () => toResult(() => api.post('/api/patients/sync')));

  server.registerTool('get_patient_compositions', {
    title: 'List a patient\'s EHRbase compositions',
    description: 'Lists the openEHR Compositions already recorded for a patient in EHRbase (most recent first) - id, template, name, and when they were recorded. Use this to see a patient\'s clinical history before deciding what form to launch next.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.get(`/api/patients/${encodeURIComponent(id)}/compositions`)));
}
