import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FormbuilderApiClient } from '../apiClient.js';
import { toResult } from '../toolResult.js';

/** Patient registry tools. Patients are Forms' own local record, kept in
 * sync with (but distinct from) EHRbase's Person compositions - a patient
 * always carries an ehrId once synced, which is what launch_form and the
 * runtime tools need to actually record clinical data against. */
export function registerPatientTools(server: McpServer, api: FormbuilderApiClient): void {
  server.registerTool('list_patients', {
    title: 'List patients',
    description: 'Lists every patient known to Forms\' local registry, each with its ehrId if already synced to EHRbase.',
    inputSchema: {},
  }, () => toResult(() => api.get('/api/patients')));

  server.registerTool('get_patient', {
    title: 'Get a patient',
    description: 'Fetches one patient by id.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.get(`/api/patients/${encodeURIComponent(id)}`)));

  server.registerTool('create_patient', {
    title: 'Create a patient',
    description: 'Registers a new patient in Forms\' local registry. This does not by itself create anything in EHRbase - a patient only gets an ehrId once a Person Composition exists for them there and sync_patients (or the normal EHRbase-side registration flow) picks it up.',
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
    description: 'Re-reads Person Compositions from the active EHRbase connection and updates Forms\' local patient registry (in particular, filling in ehrId for patients that now have one). Run this after a patient gets an EHR record in EHRbase, before trying to launch a form for them.',
    inputSchema: {},
  }, () => toResult(() => api.post('/api/patients/sync')));

  server.registerTool('get_patient_compositions', {
    title: 'List a patient\'s EHRbase compositions',
    description: 'Lists the openEHR Compositions already recorded for a patient in EHRbase (most recent first) - id, template, name, and when they were recorded. Use this to see a patient\'s clinical history before deciding what form to launch next.',
    inputSchema: { id: z.string() },
  }, ({ id }) => toResult(() => api.get(`/api/patients/${encodeURIComponent(id)}/compositions`)));
}
