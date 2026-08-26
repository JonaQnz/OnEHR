import axios from 'axios';
import prisma from '../db/prisma';
import { bindAqlParameters } from './aqlFunctionService';
import { getConfig, getActiveEhrbaseConnection } from './configService';
import { getEhrbaseRequestConfig } from './ehrbaseConnectionPlugins';
import { rowsFromResultSet } from './ehrbaseService';

export interface CreatePatientInput { patientId: string; patientNamespace?: string; firstName: string; lastName: string; birthDate?: string; gender?: string; }
type AqlRow = Record<string, unknown>;
let lastSyncAt = 0;
let runningSync: Promise<number> | undefined;

function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function rowValue(row: AqlRow, name: string): unknown { return row[name] ?? row[name.toLowerCase()] ?? row[name.toUpperCase()]; }
// EHRbase's raw /query/aql response is { columns: [...], rows: [[...]] }
// (positional arrays), not rows keyed by alias - rowsFromResultSet (shared
// with the stored-query execution path) does that column-name join.
function normalizeRows(data: unknown): AqlRow[] { return rowsFromResultSet(data); }

async function ehrSubject(ehrId: string): Promise<{ patientId?: string; namespace?: string }> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  // GET /ehr/{ehr_id} only embeds an OBJECT_REF (namespace/type/id) for
  // ehr_status on this deployment - confirmed live, never the actual
  // EHR_STATUS body, so `.subject` is always undefined there. The real
  // subject.external_ref (the external MRN this EHR was registered under -
  // see createPatient()) only comes from the dedicated ehr_status resource.
  const response = await axios.get(`${ehrbaseUrl}/ehr/${encodeURIComponent(ehrId)}/ehr_status`, { headers, ...(auth ? { auth } : {}) });
  const ref = response.data?.subject?.external_ref || response.data?.subject?.externalRef;
  return { patientId: text(ref?.id?.value), namespace: text(ref?.namespace) };
}

// Every EHR that exists on the connected EHRbase server, regardless of
// whether Forms has ever seen it - this is what makes an EHR someone
// registered directly on EHRbase (or via another system) show up here too,
// not just the ones with a Forms-recognizable Person composition.
async function discoverAllEhrIds(): Promise<string[]> {
  const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
  const response = await axios.post(`${ehrbaseUrl}/query/aql`, { q: 'SELECT e/ehr_id/value AS ehrId FROM EHR e' }, { headers, ...(auth ? { auth } : {}) });
  const rows = normalizeRows(response.data);
  const ids = new Set<string>();
  for (const row of rows) { const ehrId = text(rowValue(row, 'ehrId')); if (ehrId) ids.add(ehrId); }
  return [...ids];
}

export async function syncPatientsFromEhrbase(force = false): Promise<number> {
  if (!force && Date.now() - lastSyncAt < 60_000) return 0;
  if (runningSync) return runningSync;
  runningSync = (async () => {
    const config = getConfig();
    const query = config.patientRegistryAql?.trim();
    const templateId = config.patientRegistryPersonTemplateId?.trim();
    const allEhrIds = await discoverAllEhrIds();

    // Person-composition rows give us real demographics where they exist;
    // keyed by ehrId so an EHR without one just falls through to a bare stub.
    const personByEhrId = new Map<string, AqlRow>();
    if (query && templateId) {
      const { ehrbaseUrl, headers, auth } = await getEhrbaseRequestConfig();
      const response = await axios.post(`${ehrbaseUrl}/query/aql`, { q: bindAqlParameters(query, { personTemplateId: templateId }) }, { headers, ...(auth ? { auth } : {}) });
      const rows = normalizeRows(response.data);
      // The query orders by recorded time DESC and an EHR can have several
      // Person compositions (corrections/updates) - keep only the first
      // (newest) row seen per ehrId.
      for (const row of rows) { const ehrId = text(rowValue(row, 'ehrId')); if (ehrId && !personByEhrId.has(ehrId)) personByEhrId.set(ehrId, row); }
    }

    let synced = 0;
    for (const ehrId of allEhrIds) {
      const row = personByEhrId.get(ehrId);
      const subject = await ehrSubject(ehrId);
      const patientId = (row && text(rowValue(row, 'patientId'))) || subject.patientId || ehrId;
      const namespace = (row && text(rowValue(row, 'patientNamespace'))) || subject.namespace || getActiveEhrbaseConnection().subjectNamespace || 'default';
      await prisma.patient.upsert({
        where: { ehrId },
        // A brand new EHR with no Person composition yet: still register it
        // so it's visible (in the "needs assignment" group) - "Unbekannt" is
        // only ever a placeholder for a row that never existed locally before.
        create: {
          ehrId, patientId, patientNamespace: namespace,
          firstName: (row && text(rowValue(row, 'firstName'))) || 'Unbekannt',
          lastName: (row && text(rowValue(row, 'lastName'))) || patientId,
          birthDate: row ? text(rowValue(row, 'birthDate')) : undefined,
          gender: row ? text(rowValue(row, 'gender')) : undefined,
          origin: 'imported',
          hasPersonArchetype: Boolean(row),
        },
        // origin is deliberately absent here: a patient discovered by sync
        // starts "imported", but if createFormSession has since flipped it
        // to "native" that must never be undone by a later sync.
        // firstName/lastName/birthDate/gender are only overwritten when a
        // Person composition was actually found this time (`row` truthy) -
        // otherwise a real name entered at native creation, or found on a
        // previous sync, must never be clobbered back to "Unbekannt" just
        // because this particular sync run didn't see a composition for it.
        update: {
          patientId, patientNamespace: namespace,
          hasPersonArchetype: Boolean(row),
          ...(row ? {
            firstName: text(rowValue(row, 'firstName')) || 'Unbekannt',
            lastName: text(rowValue(row, 'lastName')) || patientId,
            birthDate: text(rowValue(row, 'birthDate')),
            gender: text(rowValue(row, 'gender')),
          } : {}),
        },
      });
      synced += 1;
    }
    lastSyncAt = Date.now();
    return synced;
  })().finally(() => { runningSync = undefined; });
  return runningSync;
}

/**
 * Targeted, cheap local update for the one thing a successful submit of the
 * registry's own Person template changes - flips hasPersonArchetype right
 * away instead of leaving it stale until the next full
 * syncPatientsFromEhrbase() sweep (which a clinician has no reason to think
 * to trigger just after finishing an admission). `updateMany` rather than
 * `update` so this is a safe no-op if the ehrId isn't a known patient row
 * (e.g. a standalone session) or is already flagged.
 */
export async function markPatientHasPersonArchetype(ehrId: string): Promise<void> {
  await prisma.patient.updateMany({ where: { ehrId, hasPersonArchetype: false }, data: { hasPersonArchetype: true } });
}

export async function createPatient(input: CreatePatientInput) {
  const connection = getActiveEhrbaseConnection(); const namespace = input.patientNamespace || connection.subjectNamespace || 'default';
  const existing = await prisma.patient.findUnique({ where: { patientNamespace_patientId: { patientNamespace: namespace, patientId: input.patientId } } });
  if (existing) throw new Error(`Patient with ID ${input.patientId} already exists in namespace ${namespace}`);
  const requestConfig = await getEhrbaseRequestConfig(connection); const headers = { ...requestConfig.headers, Prefer: 'return=representation' }; const { auth, ehrbaseUrl } = requestConfig;
  let ehrId: string;
  try { const response = await axios.get(`${ehrbaseUrl}/ehr`, { headers, auth, params: { subject_id: input.patientId, subject_namespace: namespace } }); ehrId = response.data.ehr_id.value; }
  catch (error: any) { if (error.response?.status !== 404) throw new Error('Failed to create EHR in EHRbase'); const status = { _type: 'EHR_STATUS', archetype_node_id: 'openEHR-EHR-EHR_STATUS.generic.v1', name: { value: 'EHR Status' }, subject: { external_ref: { id: { _type: 'GENERIC_ID', value: input.patientId, scheme: 'id_scheme' }, namespace, type: 'PERSON' } }, is_queryable: true, is_modifiable: true }; const response = await axios.post(`${ehrbaseUrl}/ehr`, status, { headers, auth }); ehrId = response.data.ehr_id?.value || response.data.ehr_id; }
  // hasPersonArchetype starts false even though firstName/lastName were just
  // typed in here - no vg_Person composition exists on EHRbase yet, only a
  // bare EHR_STATUS; the next sync flips it true once Stammdaten is actually
  // documented (and, per the update branch above, never clobbers this name
  // with "Unbekannt" in the meantime).
  return prisma.patient.create({ data: { patientId: input.patientId, patientNamespace: namespace, firstName: input.firstName, lastName: input.lastName, birthDate: input.birthDate, gender: input.gender, ehrId, origin: 'native', hasPersonArchetype: false } });
}
export async function listPatients(sync = true) {
  if (sync) {
    try { await syncPatientsFromEhrbase(); }
    catch (error) { console.warn('[PATIENT SYNC] Keeping local patient list after synchronization failure:', error instanceof Error ? error.message : error); }
  }
  return prisma.patient.findMany({ orderBy: { createdAt: 'desc' } });
}
export async function getPatient(id: string) { return prisma.patient.findUnique({ where: { id } }); }
export async function getPatientByIdentifier(identifier: string) { return resolvePatientReference(identifier); }
export async function resolvePatientReference(identifier: string, namespace?: string) { const exact = await prisma.patient.findFirst({ where: { OR: [{ id: identifier }, { ehrId: identifier }] } }); if (exact) return exact; if (namespace) return prisma.patient.findUnique({ where: { patientNamespace_patientId: { patientNamespace: namespace, patientId: identifier } } }); return prisma.patient.findFirst({ where: { patientId: identifier }, orderBy: { createdAt: 'desc' } }); }
