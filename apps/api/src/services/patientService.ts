import axios from 'axios';
import prisma from '../db/prisma';
import { HttpError } from '../middleware/errorHandler';
import { bindAqlParameters } from './aqlFunctionService';
import { getConfig, getActiveEhrbaseConnection } from './configService';
import { ehrbaseConnectionAuthPlugins, getEhrbaseRequestConfig } from './ehrbaseConnectionPlugins';
import { rowsFromResultSet } from './ehrbaseService';
import { logIntegrationCall } from './integrationCallLogService';

export interface PatientCreationConfiguration {
  mode: 'ehrbase' | 'fhir';
  configured: boolean;
  /** Only present when mode is 'fhir' and configured - the Person Form Section whose values createPatient must be given. */
  formId?: string;
  error?: string;
}

/** Whether patient creation goes through EHRbase's plain /ehr endpoint
 * (every non-HIP connection - unchanged, always "configured") or the FHIR
 * CDR connector (a HIP connection - Patient/EHR-id linkage lives there
 * instead, see ehrbaseConnectionPlugins.createFhirPatient). The 'fhir' mode
 * fails closed rather than silently falling back to the EHRbase path, so a
 * half-configured HIP connection surfaces as a clear setup error instead of
 * quietly creating patients nobody meant to create there. */
export function getPatientCreationConfiguration(): PatientCreationConfiguration {
  const connection = getActiveEhrbaseConnection();
  if (connection.authPlugin !== 'hip-keycloak') return { mode: 'ehrbase', configured: true };
  const missing: string[] = [];
  if (!connection.fhirBaseUrl) missing.push('FHIR-Basis-URL');
  if (!connection.fhirPatientFormId) missing.push('Person-Formular');
  const mapping = connection.fhirPatientMapping || {};
  if (!mapping.firstName || !mapping.lastName) missing.push('Mapping Vorname/Nachname');
  if (missing.length) {
    return { mode: 'fhir', configured: false, error: `Die FHIR API zur Patientenanlage ist nicht konfiguriert: ${missing.join(', ')} fehlt/fehlen.` };
  }
  return { mode: 'fhir', configured: true, formId: connection.fhirPatientFormId! };
}

export interface CreatePatientInput {
  patientId: string; patientNamespace?: string; firstName: string; lastName: string; birthDate?: string; gender?: string;
  /** Full Person Form values (fieldName -> submitted value, exactly the
   * shape a Person Form Section's own session values take), required when
   * getPatientCreationConfiguration().mode is 'fhir' - buildIsikPatientResource
   * needs more than firstName/lastName/birthDate/gender (address, insurance,
   * ...) and pulls it from here via connection.fhirPatientMapping. Ignored
   * in 'ehrbase' mode. */
  personFormValues?: Record<string, unknown>;
}
type AqlRow = Record<string, unknown>;
let lastSyncAt = 0;
let runningSync: Promise<number> | undefined;

function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function rowValue(row: AqlRow, name: string): unknown { return row[name] ?? row[name.toLowerCase()] ?? row[name.toUpperCase()]; }
// EHRbase's raw /query/aql response is { columns: [...], rows: [[...]] }
// (positional arrays), not rows keyed by alias - rowsFromResultSet (shared
// with the stored-query execution path) does that column-name join.
function normalizeRows(data: unknown): AqlRow[] { return rowsFromResultSet(data); }

/** Runs `fn` over `items` with at most `concurrency` in flight at once,
 * isolating each item's own failure instead of letting one rejection
 * abort the whole batch (used by syncPatientsFromEhrbase - see its own
 * comment for why this matters there). Exported for its own unit test. */
export async function mapWithConcurrency<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<{ failures: Array<{ item: T; error: unknown }> }> {
  const failures: Array<{ item: T; error: unknown }> = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex; nextIndex += 1;
      try { await fn(items[index]); } catch (error) { failures.push({ item: items[index], error }); }
    }
  }
  await Promise.all(Array.from({ length: Math.max(0, Math.min(concurrency, items.length)) }, () => worker()));
  return { failures };
}

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

    // QA review finding: this used to be a fully sequential for-loop (one
    // blocking EHRbase call + one DB upsert per EHR) with no partial-
    // failure recovery at all - one flaky/timing-out EHR threw, which
    // aborted the entire sync (rejecting `runningSync` for every
    // concurrent caller awaiting it) AND skipped the `lastSyncAt = Date
    // .now()` below entirely, so a persistently-broken single EHR kept
    // re-triggering (and re-timing-out) a full resync on every single
    // `GET /patients`. mapWithConcurrency bounds how many EHRbase calls
    // run at once (avoids hammering EHRbase for a large registry) and
    // isolates each EHR's own failure so the rest of the batch - and
    // lastSyncAt - are unaffected by it.
    let synced = 0;
    const { failures } = await mapWithConcurrency(allEhrIds, 5, async (ehrId) => {
      const row = personByEhrId.get(ehrId);
      const subject = await ehrSubject(ehrId);
      // Only a real discovery (a Person composition's own patientId, or the
      // EHR's registered external_ref subject id) - never the bare ehrId.
      // The ehrId fallback below is only for the `create` branch (a brand
      // new EHR never seen before genuinely has no better id yet); baking
      // it into `patientId` here made it leak into `update` too, silently
      // clobbering a real business identifier (e.g. an MRN entered at
      // native/FHIR patient creation) with the raw ehrId on every sync that
      // didn't happen to see a Person composition or subject ref - which is
      // exactly the case for a patient created via the FHIR CDR, since its
      // linked EHR's ehr_status carries no matching external_ref subject.
      const discoveredPatientId = (row && text(rowValue(row, 'patientId'))) || subject.patientId;
      const patientId = discoveredPatientId || ehrId;
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
        // firstName/lastName/birthDate/gender/patientId are only overwritten
        // when something better was actually found this time (`row` truthy,
        // or `subject.patientId` from the EHR's own external_ref) -
        // otherwise a real identifier/name entered at native/FHIR creation,
        // or found on a previous sync, must never be clobbered back to a
        // placeholder just because this particular sync run didn't see one.
        update: {
          patientNamespace: namespace,
          hasPersonArchetype: Boolean(row),
          ...(discoveredPatientId ? { patientId: discoveredPatientId } : {}),
          ...(row ? {
            firstName: text(rowValue(row, 'firstName')) || 'Unbekannt',
            lastName: text(rowValue(row, 'lastName')) || patientId,
            birthDate: text(rowValue(row, 'birthDate')),
            gender: text(rowValue(row, 'gender')),
          } : {}),
        },
      });
      synced += 1;
    });
    if (failures.length > 0) {
      console.error('[PATIENT SYNC]', `${failures.length}/${allEhrIds.length} EHRs failed to sync`, failures.map(({ item, error }) => ({ ehrId: item, error: error instanceof Error ? error.message : String(error) })));
    }
    // Always advances, even on partial failure - the whole point of the
    // fix above. A total outage (discoverAllEhrIds itself failing, e.g.
    // EHRbase unreachable) still throws normally, above, and correctly
    // leaves lastSyncAt untouched - only a per-EHR failure inside this
    // loop is treated as "the sync still ran".
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

async function createEhrOnEhrbase(connection: ReturnType<typeof getActiveEhrbaseConnection>, patientId: string, namespace: string): Promise<string> {
  const requestConfig = await getEhrbaseRequestConfig(connection); const headers = { ...requestConfig.headers, Prefer: 'return=representation' }; const { auth, ehrbaseUrl } = requestConfig;
  try { const response = await axios.get(`${ehrbaseUrl}/ehr`, { headers, auth, params: { subject_id: patientId, subject_namespace: namespace } }); return response.data.ehr_id.value; }
  catch (error: any) {
    if (error.response?.status !== 404) throw new Error('Failed to create EHR in EHRbase');
    const status = { _type: 'EHR_STATUS', archetype_node_id: 'openEHR-EHR-EHR_STATUS.generic.v1', name: { value: 'EHR Status' }, subject: { external_ref: { id: { _type: 'GENERIC_ID', value: patientId, scheme: 'id_scheme' }, namespace, type: 'PERSON' } }, is_queryable: true, is_modifiable: true };
    const url = `${ehrbaseUrl}/ehr`;
    try {
      const response = await axios.post(url, status, { headers, auth });
      const ehrId = response.data.ehr_id?.value || response.data.ehr_id;
      logIntegrationCall({
        protocol: 'openehr', resourceType: 'EHR_STATUS', operation: 'create-ehr', method: 'POST', url,
        requestBody: status, responseBody: response.data, statusCode: response.status, success: true,
        ehrId, patientId,
      });
      return ehrId;
    } catch (createError: any) {
      logIntegrationCall({
        protocol: 'openehr', resourceType: 'EHR_STATUS', operation: 'create-ehr', method: 'POST', url,
        requestBody: status, responseBody: createError?.response?.data, statusCode: createError?.response?.status,
        success: false, errorMessage: createError instanceof Error ? createError.message : String(createError), patientId,
      });
      throw createError;
    }
  }
}

export async function createPatient(input: CreatePatientInput) {
  const connection = getActiveEhrbaseConnection(); const namespace = input.patientNamespace || connection.subjectNamespace || 'default';
  const existing = await prisma.patient.findUnique({ where: { patientNamespace_patientId: { patientNamespace: namespace, patientId: input.patientId } } });
  // QA review finding: a plain Error here fell through errorHandler.ts's
  // catch-all as HTTP 500 - a routine "patient already exists" conflict
  // (e.g. a clinician double-clicking "create patient") looked like a
  // server crash to the frontend instead of a handled 409.
  if (existing) throw new HttpError(409, `Patient with ID ${input.patientId} already exists in namespace ${namespace}`);

  const creationConfig = getPatientCreationConfiguration();
  let ehrId: string;
  let fhirPatientId: string | undefined;
  if (creationConfig.mode === 'fhir') {
    if (!creationConfig.configured) throw new HttpError(500, creationConfig.error!);
    const plugin = ehrbaseConnectionAuthPlugins[connection.authPlugin];
    if (!plugin.createFhirPatient) throw new HttpError(500, `Connection '${connection.name}' does not support FHIR patient creation`);
    if (!input.personFormValues) throw new HttpError(400, 'personFormValues is required when patient creation is routed through the FHIR API (see get_patient_creation_configuration)');
    const created = await plugin.createFhirPatient(connection, input.personFormValues);
    if (!created.ehrId) throw new HttpError(502, `FHIR CDR created Patient ${created.fhirPatientId} but returned no linked openEHR EHR id`);
    ehrId = created.ehrId;
    fhirPatientId = created.fhirPatientId;
  } else {
    ehrId = await createEhrOnEhrbase(connection, input.patientId, namespace);
  }

  // hasPersonArchetype starts false even though firstName/lastName were just
  // typed in here - no vg_Person composition exists on EHRbase yet, only a
  // bare EHR_STATUS; the next sync flips it true once Stammdaten is actually
  // documented (and, per the update branch above, never clobbers this name
  // with "Unbekannt" in the meantime).
  const patient = await prisma.patient.create({ data: { patientId: input.patientId, patientNamespace: namespace, firstName: input.firstName, lastName: input.lastName, birthDate: input.birthDate, gender: input.gender, ehrId, origin: 'native', hasPersonArchetype: false } });
  // fhirPatientId is not persisted (no schema column - the Prisma record's
  // ehrId is what everything else keys off) - included here only so a
  // caller that just created a HIP-routed patient can see/log the FHIR
  // Patient id without a second lookup.
  return fhirPatientId ? { ...patient, fhirPatientId } : patient;
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
