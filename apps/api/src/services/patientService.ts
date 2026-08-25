import axios from 'axios';
import prisma from '../db/prisma';
import { bindAqlParameters } from './aqlFunctionService';
import { getConfig, getActiveEhrbaseConnection } from './configService';
import { getEhrbaseRequestConfig } from './ehrbaseConnectionPlugins';

export interface CreatePatientInput { patientId: string; patientNamespace?: string; firstName: string; lastName: string; birthDate?: string; gender?: string; }
type AqlRow = Record<string, unknown>;
let lastSyncAt = 0;
let runningSync: Promise<number> | undefined;

function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function rowValue(row: AqlRow, name: string): unknown { return row[name] ?? row[name.toLowerCase()] ?? row[name.toUpperCase()]; }
function normalizeRows(data: unknown): AqlRow[] {
  if (Array.isArray(data)) return data.filter((item): item is AqlRow => Boolean(item && typeof item === 'object' && !Array.isArray(item)));
  if (data && typeof data === 'object' && Array.isArray((data as any).rows)) return normalizeRows((data as any).rows);
  return [];
}

async function ehrSubject(ehrId: string): Promise<{ patientId?: string; namespace?: string }> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  const response = await axios.get(`${ehrbaseUrl}/ehr/${encodeURIComponent(ehrId)}`, { headers, ...(auth ? { auth } : {}) });
  const ref = response.data?.ehr_status?.subject?.external_ref || response.data?.ehrStatus?.subject?.externalRef;
  return { patientId: text(ref?.id?.value), namespace: text(ref?.namespace) };
}

export async function syncPatientsFromPersonCompositions(force = false): Promise<number> {
  if (!force && Date.now() - lastSyncAt < 60_000) return 0;
  if (runningSync) return runningSync;
  runningSync = (async () => {
    const config = getConfig();
    const query = config.patientRegistryAql?.trim();
    const templateId = config.patientRegistryPersonTemplateId?.trim();
    if (!query || !templateId) return 0;
    const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
    const response = await axios.post(`${ehrbaseUrl}/query/aql`, { q: bindAqlParameters(query, { personTemplateId: templateId }) }, { headers, ...(auth ? { auth } : {}) });
    const rows = normalizeRows(response.data?.rows ?? response.data);
    let synced = 0;
    for (const row of rows) {
      const ehrId = text(rowValue(row, 'ehrId'));
      if (!ehrId) continue;
      const subject = await ehrSubject(ehrId);
      const patientId = text(rowValue(row, 'patientId')) || subject.patientId || ehrId;
      const namespace = text(rowValue(row, 'patientNamespace')) || subject.namespace || getActiveEhrbaseConnection().subjectNamespace || 'default';
      const firstName = text(rowValue(row, 'firstName')) || 'Unbekannt';
      const lastName = text(rowValue(row, 'lastName')) || patientId;
      await prisma.patient.upsert({ where: { ehrId }, create: { ehrId, patientId, patientNamespace: namespace, firstName, lastName, birthDate: text(rowValue(row, 'birthDate')), gender: text(rowValue(row, 'gender')) }, update: { patientId, patientNamespace: namespace, firstName, lastName, birthDate: text(rowValue(row, 'birthDate')), gender: text(rowValue(row, 'gender')) } });
      synced += 1;
    }
    lastSyncAt = Date.now();
    return synced;
  })().finally(() => { runningSync = undefined; });
  return runningSync;
}

export async function createPatient(input: CreatePatientInput) {
  const connection = getActiveEhrbaseConnection(); const namespace = input.patientNamespace || connection.subjectNamespace || 'default';
  const existing = await prisma.patient.findUnique({ where: { patientNamespace_patientId: { patientNamespace: namespace, patientId: input.patientId } } });
  if (existing) throw new Error(`Patient with ID ${input.patientId} already exists in namespace ${namespace}`);
  const requestConfig = await getEhrbaseRequestConfig(connection); const headers = { ...requestConfig.headers, Prefer: 'return=representation' }; const { auth, ehrbaseUrl } = requestConfig;
  let ehrId: string;
  try { const response = await axios.get(`${ehrbaseUrl}/ehr`, { headers, auth, params: { subject_id: input.patientId, subject_namespace: namespace } }); ehrId = response.data.ehr_id.value; }
  catch (error: any) { if (error.response?.status !== 404) throw new Error('Failed to create EHR in EHRbase'); const status = { _type: 'EHR_STATUS', archetype_node_id: 'openEHR-EHR-EHR_STATUS.generic.v1', name: { value: 'EHR Status' }, subject: { external_ref: { id: { _type: 'GENERIC_ID', value: input.patientId, scheme: 'id_scheme' }, namespace, type: 'PERSON' } }, is_queryable: true, is_modifiable: true }; const response = await axios.post(`${ehrbaseUrl}/ehr`, status, { headers, auth }); ehrId = response.data.ehr_id?.value || response.data.ehr_id; }
  return prisma.patient.create({ data: { patientId: input.patientId, patientNamespace: namespace, firstName: input.firstName, lastName: input.lastName, birthDate: input.birthDate, gender: input.gender, ehrId } });
}
export async function listPatients(sync = true) {
  if (sync) {
    try { await syncPatientsFromPersonCompositions(); }
    catch (error) { console.warn('[PATIENT SYNC] Keeping local patient list after synchronization failure:', error instanceof Error ? error.message : error); }
  }
  return prisma.patient.findMany({ orderBy: { createdAt: 'desc' } });
}
export async function getPatient(id: string) { return prisma.patient.findUnique({ where: { id } }); }
export async function getPatientByIdentifier(identifier: string) { return resolvePatientReference(identifier); }
export async function resolvePatientReference(identifier: string, namespace?: string) { const exact = await prisma.patient.findFirst({ where: { OR: [{ id: identifier }, { ehrId: identifier }] } }); if (exact) return exact; if (namespace) return prisma.patient.findUnique({ where: { patientNamespace_patientId: { patientNamespace: namespace, patientId: identifier } } }); return prisma.patient.findFirst({ where: { patientId: identifier }, orderBy: { createdAt: 'desc' } }); }
