import type { ActivityLog } from '../activity/log';
import type { EntityStatusStore } from '../activity/entityStatus';
import type { PendingTaskStore, PendingTask } from '../activity/pendingTasks';
import { CapabilityUnresolved, requireOpenEhrCapabilityConfig } from '../capability/catalog';
import type { CapabilityRegistry } from '../capability/registry';
import type { DynamicCapabilityRegistry } from '../capability/dynamicRegistry';
import { ensureFhirResource, updateFhirResourceEntity, type PlannerDeps } from '../agent/planner';
import { ensureScenarioPatient } from '../agent/patientBridge';
import { ensureOpenEhrCapabilityAndRegister } from '../openehr/capabilityBridge';
import type { FormbuilderApiClient } from '../apiClient';
import type { EntityRegistryLike } from '../entity/registry';
import { FallbackEntityRegistry } from '../entity/fallbackRegistry';
import type { Scenario, ScenarioEvent } from './types';
import type { ScenarioProgressStore } from './progress';
import type { GeneratedValuesStore } from './generatedValues';
import type { LocalLocationRegistry } from '../world/localLocations';
import type { LocationLog } from '../world/locationLog';
import type { TaskStore } from '../critic/taskStore';
import { critiqueScenario } from '../critic/rules';
import type { DynamicEventsStore } from './dynamicEvents';

export interface ScenarioEngineDeps extends PlannerDeps {
  api: FormbuilderApiClient;
  capabilities: CapabilityRegistry;
  registry: EntityRegistryLike;
  activity: ActivityLog;
  generatedValues: GeneratedValuesStore;
  locations: LocalLocationRegistry;
  locationLog: LocationLog;
  tasks: TaskStore;
  /** Visual-sim groundwork - see activity/entityStatus.ts's own doc
   * comment. Bracketed around dispatch in executeNextEvent below. */
  entityStatus: EntityStatusStore;
  /** "Form Builder as a capability" - see capability/dynamicRegistry.ts's
   * own doc comment. Every EXISTING case below still resolves through the
   * static catalog only (unchanged call sites, zero regression risk) - a
   * brand-new capability registered here (register_capability MCP tool)
   * is looked up by its own new case passing this explicitly, e.g.
   * "pregnancy-status" below. */
  dynamicCapabilities: DynamicCapabilityRegistry;
  /** The real order lifecycle - see activity/pendingTasks.ts's own doc
   * comment. */
  pendingTasks: PendingTaskStore;
  /** Needed so executePendingTasks can make a synthetic execution event a
   * real, persisted member of scenario.events - see its own comment. */
  dynamicEvents: DynamicEventsStore;
}

export interface AdvanceScenarioResult {
  event: ScenarioEvent | null;
  finished: boolean;
}

/** A station (ward) a `patient-arrival`/`ward-transfer` event can move the
 * patient to. Deliberately LOCAL, not real FHIR: this deployment's real HIP
 * tenant has no FHIR resource-type mapping configured for `Location` at
 * all (live-confirmed: "No mapping found for selected arguments
 * [resourceType: Location, ...]" - `Organization` fails the identical way;
 * `Practitioner` works fine on the same tenant) - a genuine external
 * platform gap, not something fixable from this codebase. Writing a
 * reference to a Location that can't exist into a real Encounter would
 * leave a permanently broken reference on the real HIP, which is worse
 * than just tracking it locally - the user's own explicit call once this
 * was found. */
interface StationInfo {
  key: string;
  name: string;
  description: string;
}

/** The user's follow-up correction: the Klinik view was too patient-
 * centric - a Station should carry real staff ("Mitarbeitende"), with
 * patients as the last, least-emphasized link. Unlike Location itself,
 * `Practitioner` DOES work as a real FHIR resource type on this HIP tenant
 * (live-confirmed) - so staff are genuinely real FHIR entities, only the
 * "this Practitioner works at this Station" association is local (see
 * localLocations.ts's own doc comment). */
interface StaffInfo {
  scenarioKey: string;
  family: string;
  given: string;
  qualification: string;
}

/** Station/staff info is scenario-authored (`event.data.location`/
 * `event.data.staff`), not a fixed backend catalog - each scenario knows
 * its own wards and who works there. These two constants are only the
 * LAE demo's own historical defaults, kept so its existing scenario file
 * (which never set `data.location`/`data.staff`) keeps behaving exactly as
 * before. */
const DEFAULT_ARRIVAL_STATION: StationInfo = { key: 'location-notaufnahme', name: 'Notaufnahme', description: '12 Betten · Akut- und Notfallversorgung' };
const DEFAULT_ARRIVAL_STAFF: StaffInfo = { scenarioKey: 'practitioner-notaufnahme-1', family: 'Berger', given: 'Julia', qualification: 'Fachärztin für Notfallmedizin' };
const DEFAULT_IMAGING_STATION: StationInfo = { key: 'location-radiologie', name: 'Radiologie / CT', description: '2 CT-Geräte · Bildgebende Diagnostik' };
const DEFAULT_IMAGING_STAFF: StaffInfo = { scenarioKey: 'practitioner-radiologie-1', family: 'König', given: 'Thomas', qualification: 'Facharzt für Radiologie' };

function readStationInfo(data: Record<string, unknown> | undefined, fallback: StationInfo): StationInfo {
  const raw = data?.location as Partial<StationInfo> | undefined;
  if (!raw?.key) return fallback;
  return { key: String(raw.key), name: String(raw.name ?? fallback.name), description: String(raw.description ?? fallback.description) };
}

function readStaffInfo(data: Record<string, unknown> | undefined): StaffInfo | undefined {
  const raw = data?.staff as Partial<StaffInfo> | undefined;
  if (!raw?.scenarioKey || !raw.family) return undefined;
  return { scenarioKey: String(raw.scenarioKey), family: String(raw.family), given: String(raw.given ?? ''), qualification: String(raw.qualification ?? '') };
}

/** Idempotent: creates the station's assigned Practitioner the first time
 * it's needed (real FHIR, ensureFhirResource's own idempotency handles
 * repeat calls), then records the local staffing association. Returns the
 * practitioner's scenarioKey so the caller can also reference them from a
 * real Encounter.participant field - the genuinely-real half of "Station ->
 * Mitarbeitende -> Patient". A station can accumulate more than one staff
 * member over a scenario's life (e.g. two different surgeons using the
 * same OP for two different procedures) - `assignStaff` is additive. */
async function ensureStationStaffing(clinicDeps: ScenarioEngineDeps, locationKey: string, staff: StaffInfo | undefined): Promise<string | undefined> {
  if (!staff) return undefined;
  await ensureFhirResource(clinicDeps, {
    resourceType: 'Practitioner',
    scenarioKey: staff.scenarioKey,
    values: { 'name.0.family': staff.family, 'name.0.given.0': staff.given, 'qualification.0.code.text': staff.qualification },
    provenance: 'GENERATED',
  });
  clinicDeps.locations.assignStaff(locationKey, staff.scenarioKey);
  return staff.scenarioKey;
}

/** Records a ward transfer: ensures the (local) Station exists on the
 * shared clinic roster, ensures its assigned staff, then appends the
 * transfer to this patient's own real history (locationLog.ts) at the
 * exact moment this call happens - the honest, timestamped record the
 * Klinik view's time-scrubber replays later, without needing a stored
 * position for every possible instant. Returns the station's practitioner
 * so the caller can wire a real Encounter.participant reference. */
async function recordLocationTransfer(deps: ScenarioEngineDeps, clinicDeps: ScenarioEngineDeps, eventId: string, station: StationInfo, staff: StaffInfo | undefined, bed?: string): Promise<string | undefined> {
  clinicDeps.locations.ensure(station.key, station.name, station.description);
  deps.locationLog.append(eventId, station.key, new Date().toISOString(), bed);
  return ensureStationStaffing(clinicDeps, station.key, staff);
}

/** A run-scoped registry that can also resolve clinic-level scenario keys
 * (HealthcareService/Schedule/Practitioner, ...) - needed anywhere a
 * per-run entity's own reference field points at shared clinic capacity,
 * since a bare `deps.registry` alone would never find it. */
function withClinicFallback(deps: ScenarioEngineDeps, clinicDeps: ScenarioEngineDeps): ScenarioEngineDeps {
  return { ...deps, registry: new FallbackEntityRegistry(deps.registry, clinicDeps.registry) };
}

/** Updates the patient's existing Encounter's assigned Practitioner/status/
 * class, if any changed - shared by `patient-arrival`'s later siblings
 * (`ward-transfer`, `request-imaging`) so a hand-over to a new station's
 * doctor is always a real FHIR update, never a second Encounter. `classCode`
 * is the real "ambulant (AMB) vs. stationär (IMP)" decision - a live triage/
 * admission call, not something the patient's own arrival can know yet.
 * Assumes one Encounter per patient - true for every scenario built so far. */
async function updateEncounterHandover(deps: ScenarioEngineDeps, clinicDeps: ScenarioEngineDeps, practitionerKey: string | undefined, encounterStatus: unknown, classCode?: unknown): Promise<void> {
  const encounterEntity = deps.registry.list().find((entity) => entity.resourceType === 'Encounter');
  if (!encounterEntity) return;
  const values: Record<string, unknown> = {};
  if (practitionerKey) values['participant.0.individual.reference'] = practitionerKey;
  if (typeof encounterStatus === 'string') values.status = encounterStatus;
  if (typeof classCode === 'string') values['class.code'] = classCode;
  if (Object.keys(values).length === 0) return;
  await updateFhirResourceEntity(withClinicFallback(deps, clinicDeps), {
    scenarioKey: encounterEntity.scenarioKey,
    values,
    provenance: 'DERIVED',
  });
}

/** Spec section 26's "PLAN FIRST/EXECUTE SECOND/VERIFY THIRD" loop, made
 * concrete: each ScenarioEventType maps to exactly one handler below, which
 * always just calls the already-verified ensure* functions (agent/
 * planner.ts, agent/patientBridge.ts, openehr/capabilityBridge.ts) in the
 * right order - this file adds NO new HIP-writing logic of its own, only
 * orchestration. No LLM call happens here (see agent/generate.ts for the
 * separate, narrow fill-step this could call before an ensure* call, not
 * yet wired in).
 *
 * `deps` is this patient's own per-run dependencies (Patient/Encounter/
 * openEHR Compositions/Slot/Appointment - everything scoped to THIS
 * scenario run); `clinicDeps` is the shared clinic's own (context.ts's
 * CLINIC_NAMESPACE) - HealthcareService/Schedule/Locations/Practitioners
 * are ensured against `clinicDeps` specifically so a second patient/run
 * reuses the SAME standing clinic capacity instead of re-inventing it (the
 * user's own correction: "new patients always use the same clinic; it only
 * grows when a genuinely new requirement appears"). */
/** The real order lifecycle (user's own ask - "Aufgaben des Arztes werden
 * erst ausgeführt, wenn Pflege zu der Person kommt"). An order event
 * (`medication-order`/`order-basis`) opts in by carrying
 * `data.pendingResult: { kind, description?, payload }` - when present,
 * this files a real PendingTask (activity/pendingTasks.ts) AFTER the order
 * document itself already wrote successfully, so the order is a real fact
 * regardless of whether it's later ever fulfilled. No `pendingResult` given
 * -> a complete no-op, so every scenario written before this feature
 * existed keeps behaving byte-for-byte the same. Consumed later by
 * `executePendingTasks` (nursing-round) and reflected by `doctor-round`. */
function filePendingResultIfRequested(deps: ScenarioEngineDeps, event: ScenarioEvent, patientScenarioKey: string): void {
  const pendingResult = event.data?.pendingResult as { kind: 'medication-administration' | 'lab-value'; description?: string; payload?: Record<string, unknown> } | undefined;
  if (!pendingResult?.kind) return;
  deps.pendingTasks.fileFor({
    kind: pendingResult.kind,
    description: pendingResult.description ?? `Ausführung der Anordnung "${event.id}"`,
    orderedByRole: 'doctor',
    orderEventId: event.id,
    patientScenarioKey,
    payload: pendingResult.payload ?? {},
  });
}

/** Renders one completed PendingTask's own payload into a short, real
 * (not invented) summary a doctor-round's own note can quote - the
 * "er prüft die Ergebnisse" half of the user's ask. Mirrors each kind's
 * own field/option shape exactly (see the matching case bodies below). */
function describePendingTaskResult(task: PendingTask): string {
  const p = task.payload;
  const interpretationLabels: Record<string, string> = { N: 'Normal', L: 'Niedrig', H: 'Hoch', LL: 'Kritisch niedrig', HH: 'Kritisch hoch', A: 'Auffällig' };
  if (task.kind === 'lab-value') {
    const name = String(p.analyteName ?? 'Laborwert');
    const value = typeof p.value === 'number' ? `${p.value} ${String(p.unit ?? '')}`.trim() : undefined;
    const interpretation = typeof p.interpretation === 'string' ? interpretationLabels[p.interpretation] : undefined;
    return `${name}${value ? `: ${value}` : ''}${interpretation ? ` (${interpretation})` : ''}.`;
  }
  const medication = String(p.arzneimittel ?? p.medicationName ?? 'Medikament');
  const dose = typeof p.dosisbeschreibung === 'string' ? p.dosisbeschreibung : undefined;
  return `${medication}${dose ? ` (${dose})` : ''} verabreicht.`;
}

/** The real order lifecycle's execution half - "Aufgaben des Arztes werden
 * erst ausgeführt, wenn Pflege zu der Person kommt". Recurses straight back
 * into `executeEvent` for the SAME `medication-administration`/`lab-value`
 * dispatch a hand-authored scenario event would use, reusing every existing
 * field-mapping/dual-key/capability-resolution rule rather than
 * duplicating it - a synthetic event id keeps it distinct in the Activity
 * log without needing its own place in the scenario's own event list. No
 * pending tasks -> a complete no-op, so nursing-round behaves exactly as
 * before for every scenario that never files one. */
async function executePendingTasks(scenarioRunId: string, deps: ScenarioEngineDeps, clinicDeps: ScenarioEngineDeps, scenario: Scenario, patientScenarioKey: string, triggeringEventId: string, progressStore: ScenarioProgressStore): Promise<void> {
  for (const task of deps.pendingTasks.listPending(patientScenarioKey)) {
    const syntheticEvent: ScenarioEvent = { id: `${triggeringEventId}-executes-${task.id}`, type: task.kind, at: '0m', data: task.payload };
    await executeEvent(scenarioRunId, deps, clinicDeps, scenario, syntheticEvent, patientScenarioKey, progressStore);
    deps.pendingTasks.complete(task.id, syntheticEvent.id);
    // Real bug found live playing the appendicitis case: critic/rules.ts's
    // own checks (e.g. missing-preprocedure-medication) only ever look at
    // `scenario.events` - a synthetic execution event that only ever went
    // through `executeEvent` directly was invisible to them, so a REAL
    // medication-administration the patient actually received still read
    // as "never given". Appending it here (dynamicEvents.ts's own
    // mechanism, same as a human/agent appending a live decision) makes it
    // visible to the NEXT critique pass exactly like any other real event -
    // this step's own critique still runs against the `scenario` object
    // already in memory, so the fix takes effect starting the following
    // step, not retroactively for one already in flight. Immediately
    // marked completed too (not just appended) - otherwise the NEXT
    // executeNextEvent call would find this newly-visible event
    // "not yet completed" and try to execute (and re-submit!) it again.
    const existingIds = new Set(scenario.events.map((existing) => existing.id));
    if (!existingIds.has(syntheticEvent.id)) {
      deps.dynamicEvents.append(syntheticEvent, existingIds);
      const progress = progressStore.get();
      progressStore.save({
        ...progress,
        completedEventIds: [...progress.completedEventIds, syntheticEvent.id],
        completedAt: { ...progress.completedAt, [syntheticEvent.id]: new Date().toISOString() },
      });
    }
    deps.activity.append({
      reason: `Pflege führt offene Anordnung aus: ${task.description}`,
      action: 'task-execution',
      tool: 'nursing-round',
      result: 'success',
      message: `Anordnung "${task.orderEventId}" (${task.kind}) wurde ausgeführt und real dokumentiert.`,
    });
  }
}

async function executeEvent(scenarioRunId: string, deps: ScenarioEngineDeps, clinicDeps: ScenarioEngineDeps, scenario: Scenario, event: ScenarioEvent, patientScenarioKey: string, progressStore: ScenarioProgressStore): Promise<unknown> {
  switch (event.type) {
    case 'patient-arrival': {
      const data = event.data;
      const birthDate = scenario.patient.birthDate ?? `${new Date().getUTCFullYear() - scenario.patient.age}-01-01`;
      const patient = await ensureScenarioPatient(deps, {
        scenarioKey: scenario.patient.key,
        // The external patientId (Forms' own MRN-like identifier) must be
        // globally unique across ALL scenario runs, unlike the scenario key
        // above (which is only ever looked up within THIS run's own
        // registry) - two different runs of the same scenario file reusing
        // the bare scenario.patient.key here collided live ("Patient with
        // ID patient-maria already exists"). scenarioRunId is already
        // guaranteed unique per run (spec section 3), so folding it in here
        // is enough, with no separate uniqueness scheme of its own needed.
        patientId: `${scenario.patient.key}-${scenarioRunId}`,
        firstName: scenario.patient.firstName,
        lastName: scenario.patient.lastName,
        birthDate,
        gender: scenario.patient.sex,
        provenance: 'SOURCE',
      });

      // The patient's first real placement on the clinic floor. Ensured
      // BEFORE the Encounter itself so its assigned Practitioner's
      // scenarioKey is already known and can be embedded as a real
      // Encounter.participant reference.
      const station = readStationInfo(data, DEFAULT_ARRIVAL_STATION);
      const staff = readStaffInfo(data) ?? DEFAULT_ARRIVAL_STAFF;
      const arrivalPractitioner = await recordLocationTransfer(deps, clinicDeps, event.id, station, staff);

      const classSystem = typeof data?.classSystem === 'string' ? data.classSystem : 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
      const classCode = typeof data?.classCode === 'string' ? data.classCode : 'EMER';
      const status = typeof data?.encounterStatus === 'string' ? data.encounterStatus : 'arrived';

      const encounter = await ensureFhirResource(withClinicFallback(deps, clinicDeps), {
        resourceType: 'Encounter',
        scenarioKey: `encounter-${event.id}`,
        values: {
          status,
          'class.system': classSystem,
          'class.code': classCode,
          'subject.reference': scenario.patient.key,
          'period.start': new Date().toISOString(),
          ...(arrivalPractitioner ? { 'participant.0.individual.reference': arrivalPractitioner } : {}),
        },
        provenance: 'DERIVED',
      });
      return { patient, encounter };
    }

    // A generic station move for a scenario with more than the LAE demo's
    // two implicit stops (spec's own "no full FHIR location history" call,
    // made scenario-authorable): moves the patient to `data.location`,
    // ensures/assigns `data.staff` there, and hands the same real Encounter
    // over to that staff member (+ optionally updates its `status`).
    case 'ward-transfer': {
      const data = event.data;
      const rawLocation = data?.location as Partial<StationInfo> | undefined;
      if (!rawLocation?.key || !rawLocation.name) {
        throw new Error(`ward-transfer event "${event.id}" needs "data.location.key" and "data.location.name".`);
      }
      const station: StationInfo = { key: String(rawLocation.key), name: String(rawLocation.name), description: String(rawLocation.description ?? '') };
      const staff = readStaffInfo(data);
      const bed = typeof data?.bed === 'string' ? data.bed : undefined;
      const practitioner = await recordLocationTransfer(deps, clinicDeps, event.id, station, staff, bed);
      await updateEncounterHandover(deps, clinicDeps, practitioner, data?.encounterStatus, data?.encounterClass);
      return { station, practitioner };
    }

    // Real Pflegebericht entry - "Pflege kommt n mal pro Tag und prüft"
    // (spec/user's own ask), generated automatically by protocol.ts's
    // expansion, never hand-authored per case.
    case 'nursing-round': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const note = String(event.data?.note ?? 'Patient stabil, keine Auffälligkeiten.');
      const result = await ensureOpenEhrCapabilityAndRegister(
        deps, 'nursing-round', requireOpenEhrCapabilityConfig('nursing-round'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        { pflegebericht_progress_note: note },
      );
      // "Aufgaben des Arztes werden erst ausgeführt, wenn Pflege zu der
      // Person kommt" - THIS is that moment. See executePendingTasks' own
      // doc comment.
      await executePendingTasks(scenarioRunId, deps, clinicDeps, scenario, patientScenarioKey, event.id, progressStore);
      return result;
    }

    // Real Klinische Anordnung entry - "der Arzt kommt n mal pro Tag und
    // prüft [und] kann [ein] Ereignis auslösen": a routine round writes a
    // routine order; a severe one (protocol.ts's own severity simulation)
    // writes an urgent/emergency one and may ALSO trigger a real
    // ward-transfer right after (see protocol.ts's escalation logic).
    case 'doctor-round': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      // "Dann prüft er die Ergebnisse der Anordnung" - real completed
      // orders since the doctor's own last round, not protocol.ts's
      // fictional severity number. No unreviewed results -> the exact
      // canned text this always used before (backward compatible).
      const unreviewed = deps.pendingTasks.listUnreviewedDone(patientScenarioKey);
      const resultsSummary = unreviewed.map(describePendingTaskResult).join(' ');
      const result = await ensureOpenEhrCapabilityAndRegister(
        deps, 'doctor-round', requireOpenEhrCapabilityConfig('doctor-round'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          'vg_servicerequest.v1.1.1_service_name': String(data.serviceName ?? 'Verlaufskontrolle'),
          'vg_servicerequest.v1.1.1_service_type': String(data.serviceType ?? 'Visite'),
          'vg_servicerequest.v1.1.1_urgency': String(data.urgency ?? 'at0138'),
          'vg_servicerequest.v1.1.1_clinical_indication': String(data.clinicalIndication ?? (resultsSummary ? `Ergebnisse durchgesehen: ${resultsSummary}` : 'Regelhafte ärztliche Verlaufsbeurteilung im Rahmen der Visite.')),
          'vg_servicerequest.v1.1.1_comment': String(data.comment ?? (resultsSummary || 'Weiter nach Standardprotokoll.')),
          'vg_servicerequest.v1.1.1_date_time_value': typeof data.dueAt === 'string' ? data.dueAt : new Date().toISOString(),
          // Two `alwaysHidden` fields on the real form that still validate
          // as required on submit - their own configured defaultValue
          // only applies in the interactive UI, not a direct API patch, so
          // this workbench must supply them explicitly (live-discovered).
          'vg_servicerequest.v1.1.1_intent': 'order',
          'vg_servicerequest.v1.1.1_text_value_2': 'SIMULATIONSWORKBENCH',
        },
      );
      unreviewed.forEach((task) => deps.pendingTasks.markReviewed(task.id));
      return result;
    }

    // Real Laborbericht mit Probe (Panel) entry - "Laborergebnisse werden
    // von dir erzeugt [...] auch mal welche die ein Ereignis auslösen": a
    // non-empty `testDiagnosis` is protocol.ts's own chosen "this result is
    // abnormal enough to matter" signal, not a separate flag.
    case 'lab-result': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'lab-result', requireOpenEhrCapabilityConfig('lab-result'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          'vg_diagnosticreportlab.v1.1.2_test_name': String(data.testName ?? 'Kleines Blutbild'),
          'vg_diagnosticreportlab.v1.1.2_report_code': String(data.reportCode ?? '58410-2'),
          'vg_diagnosticreportlab.v1.1.2_overall_test_status': String(data.overallTestStatus ?? 'at0038'),
          'vg_diagnosticreportlab.v1.1.2_date_time_value': typeof data.collectedAt === 'string' ? data.collectedAt : new Date().toISOString(),
          'vg_diagnosticreportlab.v1.1.2_conclusion': String(data.conclusion ?? 'Laborwerte im Normbereich.'),
          ...(data.testDiagnosis ? { 'vg_diagnosticreportlab.v1.1.2_test_diagnosis': String(data.testDiagnosis) } : {}),
        },
      );
    }

    // Real "Prozedur (Basis)" entry - closes the exact gap the user spotted
    // by eye in the appendicitis case (an actual intervention was only ever
    // a free-text anamnesis note) AND the later ask for real OPS-coded
    // procedures. A brand-new Composition per procedure (like vital-signs/
    // nursing/doctor/lab) - a patient can have more than one in a stay.
    // `procedure_name`/`procedure_status` need BOTH their bare `id` and
    // fully-qualified `name` supplied - see capability/catalog.ts's own doc
    // comment on the live-confirmed required-field bug this works around.
    case 'procedure': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const procedureName = data.opsCode
        ? { value: String(data.procedureName ?? 'Operativer Eingriff'), mappings: [{ terminologyId: 'https://hip.vitagroup.ag/sid/procedure-code', code: String(data.opsCode), display: String(data.opsDisplay ?? data.procedureName ?? '') }] }
        : String(data.procedureName ?? 'Operativer Eingriff');
      const status = String(data.status ?? '532'); // 532 = Abgeschlossen/completed
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'procedure', requireOpenEhrCapabilityConfig('procedure'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          'vg_procedure.v1.1.0_procedure_name': procedureName, procedure_name: procedureName,
          'vg_procedure.v1.1.0_procedure_status': status, procedure_status: status,
          ...(data.category ? { 'vg_procedure.v1.1.0_procedure_category': String(data.category) } : {}),
          ...(data.indication ? { 'vg_procedure.v1.1.0_indication': String(data.indication) } : {}),
          ...(data.method ? { 'vg_procedure.v1.1.0_method': String(data.method) } : {}),
          ...(data.bodySite ? { 'vg_procedure.v1.1.0_body_site': String(data.bodySite) } : {}),
          'vg_procedure.v1.1.0_scheduled_date_time': typeof data.performedAt === 'string' ? data.performedAt : new Date().toISOString(),
          ...(data.outcome ? { 'vg_procedure.v1.1.0_outcome': String(data.outcome) } : {}),
          ...(data.complication ? { 'vg_procedure.v1.1.0_complication': String(data.complication) } : {}),
        },
      );
    }

    // Real, ICD-10-GM-coded diagnosis ("Diagnose (Basis)") - distinct from
    // the free-text anamnesis note, and the exact gap the critic's own
    // standing "missing-coded-diagnosis" finding names (see
    // capability/catalog.ts's doc comment for the live-verification
    // writeup: "Diagnose & Problem"'s coded selects silently corrupt
    // whatever is submitted, "Diagnose (Basis)" does not). A brand-new
    // Composition per diagnosis, like procedure/medication-order - a
    // patient can accrue more than one over a stay. Both `diagnose_name`
    // and `diagnose_kategorie` have identical layout `id`/`name` on this
    // form, so - unlike procedure/medication-order - no dual-key
    // required-field workaround is needed here. `diagnose_kategorie`'s
    // "Kategorie-Code (HIP)" terminology has no backing CodeSystem
    // anywhere (confirmed: 0 results from HAPI) and does not need one -
    // codeMappings is a DV_TEXT.mappings TERM_MAPPING the app stores
    // verbatim, never validated against a live terminology - so a
    // real-world category code (FHIR's own "Condition Category Codes"
    // convention) is enough.
    case 'coded-diagnosis': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const diagnosisName = data.icdCode
        ? { value: String(data.diagnosisName ?? 'Diagnose'), mappings: [{ terminologyId: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', code: String(data.icdCode), display: String(data.icdDisplay ?? data.diagnosisName ?? '') }] }
        : String(data.diagnosisName ?? 'Diagnose');
      const categoryDisplay = String(data.categoryDisplay ?? 'Encounter Diagnosis');
      const category = { value: categoryDisplay, mappings: [{ terminologyId: 'https://hip.vitagroup.ag/sid/condition-category-code', code: String(data.categoryCode ?? 'encounter-diagnosis'), display: categoryDisplay }] };
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'coded-diagnosis', requireOpenEhrCapabilityConfig('coded-diagnosis'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          diagnose_name: diagnosisName,
          diagnose_kategorie: category,
          diagnose_status: String(data.status ?? 'at0026'), // Aktiv
          diagnose_diagnosestatus: String(data.diagnosisStatus ?? 'at0018'), // Gesichert
          diagnose_sicherheit: String(data.certainty ?? 'at0076'), // Bestätigt
        },
      );
    }

    // Real single lab VALUE ("Laborwert (Basis)") - the Basis-level atomic
    // building block a panel report (the existing "lab-result" capability,
    // "Laborbericht mit Probe (Panel)") is conceptually made of - see
    // capability/catalog.ts's own doc comment. A different archetype
    // (vg_ObservationLab.v1.2.0) from "lab-result"'s
    // (vg_diagnosticreportlab.v1.1.2), not a replacement for it. Both
    // `test_name`/`diagnostic_service_category`/`analyte_name`/
    // `result_status` need the same dual-key (bare `id` + qualified `name`)
    // workaround as procedure/medication-order.
    case 'lab-value': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const analyteName = data.analyteCode
        ? { value: String(data.analyteName ?? 'Laborwert'), mappings: [{ terminologyId: 'https://hip.vitagroup.ag/sid/analyte-code', code: String(data.analyteCode), display: String(data.analyteName ?? '') }] }
        : String(data.analyteName ?? 'Laborwert');
      const testName = String(data.testName ?? data.analyteName ?? 'Laborwert');
      const resultStatus = String(data.resultStatus ?? 'at0018'); // Final
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'lab-value', requireOpenEhrCapabilityConfig('lab-value'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          'vg_observationlab.v1.2.0_test_name': testName, test_name: testName,
          'vg_observationlab.v1.2.0_diagnostic_service_category': 'Laboratory', diagnostic_service_category: 'Laboratory',
          'vg_observationlab.v1.2.0_analyte_name': analyteName, analyte_name: analyteName,
          'vg_observationlab.v1.2.0_result_status': resultStatus, result_status: resultStatus,
          ...(typeof data.value === 'number'
            ? { 'vg_observationlab.v1.2.0_quantity_value': { magnitude: data.value, unit: String(data.unit ?? '') }, quantity_value: { magnitude: data.value, unit: String(data.unit ?? '') } }
            : {}),
          ...(data.referenceRange ? { 'vg_observationlab.v1.2.0_textual_reference_range': String(data.referenceRange), textual_reference_range: String(data.referenceRange) } : {}),
          ...(data.interpretation ? { 'vg_observationlab.v1.2.0_observation_interpretation_code': String(data.interpretation), observation_interpretation_code: String(data.interpretation) } : {}),
          ...(data.comment ? { 'vg_observationlab.v1.2.0_comment': String(data.comment), comment: String(data.comment) } : {}),
        },
      );
    }

    // Real order/request ("Anordnung (Basis)") - the Basis-level building
    // block the existing "doctor-round" capability's own broader
    // "Klinische Anordnung" form conceptually extends - see
    // capability/catalog.ts's own doc comment. A different archetype
    // (vg_ServiceRequest.v1.1.1). `service_name`/`intent` need the same
    // dual-key workaround as procedure/medication-order/lab-value above.
    case 'order-basis': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const serviceName = data.serviceCode
        ? { value: String(data.serviceName ?? 'Anordnung'), mappings: [{ terminologyId: 'http://snomed.info/sct', code: String(data.serviceCode), display: String(data.serviceName ?? '') }] }
        : String(data.serviceName ?? 'Anordnung');
      const intent = String(data.intent ?? 'order');
      const result = await ensureOpenEhrCapabilityAndRegister(
        deps, 'order-basis', requireOpenEhrCapabilityConfig('order-basis'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          'vg_servicerequest.v1.1.1_service_name': serviceName, service_name: serviceName,
          'vg_servicerequest.v1.1.1_intent': intent, intent,
          ...(data.urgency ? { 'vg_servicerequest.v1.1.1_urgency': String(data.urgency), urgency: String(data.urgency) } : {}),
          ...(data.requestStatus ? { 'vg_servicerequest.v1.1.1_request_status': String(data.requestStatus), request_status: String(data.requestStatus) } : {}),
          ...(data.clinicalIndication ? { 'vg_servicerequest.v1.1.1_clinical_indication': String(data.clinicalIndication), clinical_indication: String(data.clinicalIndication) } : {}),
          ...(data.comment ? { 'vg_servicerequest.v1.1.1_comment': String(data.comment), comment: String(data.comment) } : {}),
        },
      );
      filePendingResultIfRequested(deps, event, patientScenarioKey);
      return result;
    }

    // Real pregnancy/antenatal status - built live via the openehr-architect
    // agent for this session's pregnancy demo (no pregnancy/antenatal Form
    // existed anywhere in this Forms instance before - see the
    // "missing-form:pregnancy-status" task this run filed via
    // request_missing_form while waiting). A brand-new "vg_PregnancyStatus.
    // v1.0.0" template composed from three real openEHR CKM archetypes
    // (estimated_date_delivery/obstetric_summary/fetal_heart), registered
    // into the DYNAMIC capability registry (not capability/catalog.ts -
    // this is the actual "Form Builder as a capability" mechanism from
    // Phase 2/4), so this is the one case that explicitly passes
    // `deps.dynamicCapabilities` rather than relying on the static-only
    // default every other case above uses. `gestation_by_scan` is a
    // DV_DURATION - EHRbase normalizes to a pure day count on read-back
    // (confirmed live: 28 weeks -> "P196D"), so days-only avoids the
    // ISO8601 ambiguity of mixing a week designator with anything else.
    // `gravidity`/`parity` (DV_COUNT) and `presence` (DV_CODED_TEXT) are
    // bare values, not wrapped, unlike `rate` (DV_QUANTITY). `edd`'s bare
    // `id` differs from its qualified `name` (same class of bug as
    // Procedure/Entlassungsbrief) - supplied under both keys defensively,
    // it being the form's only required field.
    case 'pregnancy-status': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const totalDays = (typeof data.gestationalAgeWeeks === 'number' ? data.gestationalAgeWeeks * 7 : 0)
        + (typeof data.gestationalAgeDays === 'number' ? data.gestationalAgeDays : 0);
      const edd = typeof data.estimatedDueDate === 'string' ? new Date(data.estimatedDueDate).toISOString() : new Date().toISOString();
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'pregnancy-status', requireOpenEhrCapabilityConfig('pregnancy-status', deps.dynamicCapabilities),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          ...(totalDays > 0 ? { 'vg_pregnancystatus.v1.0.0_gestation_by_scan': `P${totalDays}D`, gestation_by_scan: `P${totalDays}D` } : {}),
          'vg_pregnancystatus.v1.0.0_edd': edd, edd,
          ...(typeof data.gravida === 'number' ? { 'vg_pregnancystatus.v1.0.0_gravidity': data.gravida, gravidity: data.gravida } : {}),
          ...(typeof data.para === 'number' ? { 'vg_pregnancystatus.v1.0.0_parity': data.para, parity: data.para } : {}),
          ...(data.comment ? { 'vg_pregnancystatus.v1.0.0_comment': String(data.comment), comment: String(data.comment) } : {}),
          ...(typeof data.fetalHeartRate === 'number'
            ? {
              'vg_pregnancystatus.v1.0.0_presence': 'at0026', presence: 'at0026', // Present
              'vg_pregnancystatus.v1.0.0_rate': { magnitude: data.fetalHeartRate, unit: '1/min' }, rate: { magnitude: data.fetalHeartRate, unit: '1/min' },
            }
            : {}),
        },
      );
    }

    // Real medication ORDER ("Medikation (Basis)") - the workbench's own
    // FHIR-vs-openEHR split (see this feature's own investigation): real
    // FHIR `MedicationRequest` hits the SAME "No mapping found" tenant gap
    // as Location/Procedure/Task, so ordering happens here, in openEHR,
    // like everything else this project writes. `medication_item_name`/
    // `status` need the same dual-key fix as Procedure.
    case 'medication-order': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const medicationName = data.medicationCode
        ? { value: String(data.medicationName ?? 'Medikament'), mappings: [{ terminologyId: 'https://hip.vitagroup.ag/sid/medication-code', code: String(data.medicationCode), display: String(data.medicationDisplay ?? data.medicationName ?? '') }] }
        : String(data.medicationName ?? 'Medikament');
      const status = String(data.status ?? 'at0011'); // Aktiv
      const result = await ensureOpenEhrCapabilityAndRegister(
        deps, 'medication-order', requireOpenEhrCapabilityConfig('medication-order'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          'vg_medicationstatement.v1.1.0_medication_item_name': medicationName, medication_item_name: medicationName,
          'vg_medicationstatement.v1.1.0_status': status, status,
          ...(data.doseAndTiming ? { 'vg_medicationstatement.v1.1.0_dose_and_timing': String(data.doseAndTiming) } : {}),
          ...(data.route ? { 'vg_medicationstatement.v1.1.0_route': String(data.route) } : {}),
          ...(data.clinicalIndication ? { 'vg_medicationstatement.v1.1.0_clinical_indication': String(data.clinicalIndication) } : {}),
          ...(data.comment ? { 'vg_medicationstatement.v1.1.0_comment': String(data.comment) } : {}),
        },
      );
      filePendingResultIfRequested(deps, event, patientScenarioKey);
      return result;
    }

    // Real medication ADMINISTRATION (eMAR) - what was actually given, not
    // just ordered. `administration_status` needs the same dual-key fix
    // (its only field on this form with a bare `id` distinct from `name`).
    case 'medication-administration': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const status = String(data.status ?? '532'); // Abgeschlossen/completed
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'medication-administration', requireOpenEhrCapabilityConfig('medication-administration'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          clinical_administration_time: typeof data.administrationTime === 'string' ? data.administrationTime : new Date().toISOString(),
          administration_status: status, 'vg_medicationadministration.v1.0.2_administration_status': status,
          'vg_medicationadministration.v1.0.2_arzneimittel': String(data.arzneimittel ?? 'Medikament'),
          'vg_medicationadministration.v1.0.2_dosisbeschreibung': String(data.dosisbeschreibung ?? 'siehe Anordnung'),
          'vg_medicationadministration.v1.0.2_verabreichungsweg': String(data.verabreichungsweg ?? 'i.v.'),
          'vg_medicationadministration.v1.0.2_klinische_indikation': String(data.klinischeIndikation ?? 'siehe Anordnung'),
          'vg_medicationadministration.v1.0.2_nachkontrolliert': String(data.nachkontrolliert ?? 'true'),
          ...(data.medicationCode ? { medication_code: String(data.medicationCode) } : {}),
          ...(data.comment ? { 'vg_medicationadministration.v1.0.2_kommentar_3': String(data.comment) } : {}),
        },
      );
    }

    // Real discharge medication - "Entlassmedikation", ALREADY a second,
    // independent block on the SAME "Entlassung" Composition discharge-
    // letter uses (found live, not guessed). Closes the critic's own
    // "missing-discharge-medication" gap for real. Repeatable on this Form
    // Section (one patient can leave with several prescriptions) but, like
    // "Diagnostik-Befund"'s own repeatable group before it, a single flat
    // submission (not array-wrapped) is enough for one item.
    case 'discharge-medication': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'discharge-medication', requireOpenEhrCapabilityConfig('discharge-medication'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          'vg_medicationstatement.v1.1.0_medication_item_name': String(data.medicationName ?? 'Medikament'),
          'vg_medicationstatement.v1.1.0_status': String(data.status ?? 'at0011'), // Aktiv
          'vg_medicationstatement.v1.1.0_dose_and_timing': String(data.doseAndTiming ?? ''),
          'vg_medicationstatement.v1.1.0_route': String(data.route ?? 'oral'),
          'vg_medicationstatement.v1.1.0_clinical_indication': String(data.clinicalIndication ?? ''),
          'vg_medicationstatement.v1.1.0_therapeutic_intent': String(data.therapeuticIntent ?? 'Ambulante Weiterbehandlung nach Entlassung'),
          'vg_medicationstatement.v1.1.0_last_reviewed': typeof data.lastReviewed === 'string' ? data.lastReviewed : new Date().toISOString(),
          ...(data.comment ? { 'vg_medicationstatement.v1.1.0_comment': String(data.comment) } : {}),
        },
      );
    }

    // Real Diagnostik-Befund entry - the other half of the gap the user
    // spotted: a booked imaging Appointment (`request-imaging`) only ever
    // carried its finding as a free-text `comment`, never a structured
    // report. Reuses the SAME "Diagnostik & Labor" Composition doctor-round/
    // lab-result already write to, at its own `block-imaging` block.
    case 'diagnostic-report': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'diagnostic-report', requireOpenEhrCapabilityConfig('diagnostic-report'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          'diagnostik-befund_study_name': String(data.studyName ?? 'Bildgebende Diagnostik'),
          ...(data.modality ? { 'diagnostik-befund_modality': String(data.modality) } : {}),
          ...(data.targetBodySite ? { 'diagnostik-befund_target_body_site': String(data.targetBodySite) } : {}),
          'diagnostik-befund_study_date': typeof data.studyDate === 'string' ? data.studyDate : new Date().toISOString(),
          'diagnostik-befund_imaging_findings': String(data.findings ?? 'Unauffälliger Befund.'),
          ...(data.impression ? { 'diagnostik-befund_overall_impression': String(data.impression) } : {}),
          ...(data.diagnosis ? { 'diagnostik-befund_imaging_diagnosis': String(data.diagnosis) } : {}),
          ...(data.recommendation ? { 'diagnostik-befund_recommendation': String(data.recommendation) } : {}),
        },
      );
    }

    // Real "Entlassungsbrief - Verlauf & Procedere" entry - closes the
    // standing critic's own "missing-discharge-letter" gap. The real Form
    // Section itself enforces genuine minimum-length content (see
    // capability/catalog.ts's own doc comment) - a placeholder-length
    // string genuinely fails validation here, not just a cosmetic nicety.
    //
    // A real, live-discovered Form Builder bug (also hit on "Prozedur
    // (Basis)" before that form was swapped out): this Form Section's own
    // required-field check validates against each field's bare leaf `id`
    // (e.g. "synopsis"), not its fully-qualified `name`
    // ("entlassungsbrief_synopsis") - even though the WRITE path needs the
    // fully-qualified name. Confirmed live via `patch_form_session` +
    // `validate_form_session`: supplying BOTH keys satisfies the check
    // without duplicating any real openEHR content (the extra bare-id keys
    // don't map to any binding, so they're simply ignored on submit).
    case 'discharge-letter': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const synopsis = String(data.synopsis ?? '');
      const topic = String(data.topic ?? 'Nachsorge');
      const recommendation = String(data.recommendation ?? '');
      const rationale = String(data.rationale ?? '');
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'discharge-letter', requireOpenEhrCapabilityConfig('discharge-letter'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          entlassungsbrief_synopsis: synopsis, synopsis,
          entlassungsbrief_topic: topic, topic,
          entlassungsbrief_recommendation: recommendation, recommendation,
          entlassungsbrief_rationale: rationale, rationale,
        },
      );
    }

    // `certainty`/`status` used to be hardcoded to Suspected/Working on
    // every call - a scenario could never model genuine diagnostic
    // uncertainty progressing over a stay (user's own ask: "er macht
    // Verdachtsdiagnose oder er weiß es nicht"). Both now accept a real
    // override, still defaulting to exactly today's values when omitted
    // (backward compatible). Genuinely "weiß es nicht" needs no field at
    // all - simply not calling anamnesis/coded-diagnosis yet already
    // represents that correctly.
    case 'anamnesis': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const diagnosis = String(data.diagnosis ?? 'Unklare Beschwerden');
      const certaintyCodes: Record<string, string> = { suspected: 'at0074', probable: 'at0075', confirmed: 'at0076' };
      const statusCodes: Record<string, string> = { working: 'at0017', established: 'at0018' };
      const certainty = (typeof data.certainty === 'string' && certaintyCodes[data.certainty]) || 'at0074'; // Suspected
      const status = (typeof data.status === 'string' && statusCodes[data.status]) || 'at0017'; // Working
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'anamnesis', requireOpenEhrCapabilityConfig('anamnesis'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          'vg_diagnosis.v1.1.1_problem_diagnosis_name': diagnosis,
          'vg_diagnosis.v1.1.1_diagnostic_certainty': certainty,
          'vg_diagnosis.v1.1.1_diagnostic_status': status,
        },
      );
    }

    // A real doctor-patient conversation - the OTHER source of clinical
    // information besides reading the existing chart (user's own ask: "der
    // Arzt hat noch eine Fähigkeit: sich mit Patient/in unterhalten. Neue
    // Infos kommen auch daher."). Always logged as its own Activity entry
    // (action 'conversation' - see activity/log.ts's own doc comment on
    // this convention); when the conversation actually reveals new clinical
    // information (`data.newInfoLearned`), that's folded into the SAME
    // "anamnesis" capability every other free-text history update already
    // uses (Standards/Wiederverwendung, not a second note-taking mechanism)
    // - `forceNewComposition: false` means this genuinely UPDATES the same
    // running impression rather than creating a duplicate one.
    case 'patient-conversation': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const actorRole: 'doctor' | 'nurse' = data.actorRole === 'nurse' ? 'nurse' : 'doctor';
      const actorLabel = actorRole === 'nurse' ? 'Pflege' : 'Arzt';
      const topic = typeof data.topic === 'string' ? data.topic : 'Anamnese-Gespräch';
      const question = typeof data.question === 'string' ? data.question : undefined;
      const patientSays = String(data.patientSays ?? '');
      const exchange = question ? `Frage: "${question}" - Antwort: "${patientSays}"` : patientSays;
      deps.activity.append({
        reason: `Gespräch mit Patient:in (${actorLabel}) - ${topic}`,
        action: 'conversation',
        tool: 'patient-conversation',
        result: 'success',
        message: exchange,
      });
      // Every conversation is now a real chart entry (user's own critique,
      // self-filed live on the pregnancy-anc run: reusing `anamnesis` for
      // plain conversational notes is semantically unclean) - "Verlaufsnotiz"
      // (progress-note) is the correct, unstructured-but-anchored home for
      // it, real regardless of whether anything clinically actionable came
      // out of the exchange.
      await ensureOpenEhrCapabilityAndRegister(
        deps, 'progress-note', requireOpenEhrCapabilityConfig('progress-note', deps.dynamicCapabilities),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        { entry: [{ progress_note: `[${actorLabel}] ${topic}: ${exchange}` }] },
      );
      if (typeof data.newInfoLearned !== 'string' || !data.newInfoLearned) return undefined;
      const certaintyCodes: Record<string, string> = { suspected: 'at0074', probable: 'at0075', confirmed: 'at0076' };
      const statusCodes: Record<string, string> = { working: 'at0017', established: 'at0018' };
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'anamnesis', requireOpenEhrCapabilityConfig('anamnesis'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey,
        {
          'vg_diagnosis.v1.1.1_problem_diagnosis_name': data.newInfoLearned,
          'vg_diagnosis.v1.1.1_diagnostic_certainty': (typeof data.certainty === 'string' && certaintyCodes[data.certainty]) || 'at0074', // Suspected
          'vg_diagnosis.v1.1.1_diagnostic_status': (typeof data.status === 'string' && statusCodes[data.status]) || 'at0017', // Working
        },
      );
    }

    // `bp_systolic`/`bp_diastolic`/`bp_map`/`bp_pulse_pressure` are real
    // fields on the "Vitalzeichen" Form Section (openEHR-EHR-OBSERVATION.
    // blood_pressure.v2) that were simply never wired here - found live
    // while building the (severe-hypertension) pregnancy case, where blood
    // pressure is the defining vital sign. MAP/pulse pressure are
    // standard, deterministic arithmetic from systolic/diastolic (not a
    // clinical judgment call), so they're derived automatically whenever
    // both are given, exactly as a real monitor would report them,
    // rather than requiring the caller to compute and pass them separately.
    case 'vital-signs': {
      const patientEntity = requirePatientEntity(deps, patientScenarioKey);
      const data = event.data ?? {};
      const values: Record<string, unknown> = { context_start_time: new Date().toISOString() };
      if (typeof data.heartRate === 'number') values.hr_rate = { magnitude: data.heartRate, unit: '/min' };
      if (typeof data.spo2 === 'number') values.spo2_value = { numerator: data.spo2 };
      if (typeof data.respRate === 'number') values.resp_rate = { magnitude: data.respRate, unit: '/min' };
      if (typeof data.temperature === 'number') values.temp_value = { magnitude: data.temperature, unit: 'Cel' };
      if (typeof data.systolic === 'number' && typeof data.diastolic === 'number') {
        values.bp_systolic = { magnitude: data.systolic, unit: 'mm[Hg]' };
        values.bp_diastolic = { magnitude: data.diastolic, unit: 'mm[Hg]' };
        values.bp_map = { magnitude: Math.round(data.diastolic + (data.systolic - data.diastolic) / 3), unit: 'mm[Hg]' };
        values.bp_pulse_pressure = { magnitude: data.systolic - data.diastolic, unit: 'mm[Hg]' };
      }
      return ensureOpenEhrCapabilityAndRegister(
        deps, 'vital-signs', requireOpenEhrCapabilityConfig('vital-signs'),
        { id: patientEntity.formsPatientId! }, patientScenarioKey, values,
      );
    }

    case 'request-imaging': {
      // Spec section 19/20/27's own worked chain: HealthcareService ->
      // Schedule -> Slot -> Appointment. HealthcareService/Schedule are
      // CLINIC capacity - ensured against `clinicDeps`, so every patient
      // that ever needs this procedure shares the same entities instead of
      // each run minting its own. Slot/Appointment are THIS visit's own
      // booking - ensured against `deps` (this run), with a
      // FallbackEntityRegistry so the Slot's `schedule.reference` can
      // resolve the clinic-level Schedule even though Slot itself lives in
      // the per-run registry. `serviceKey`/`scheduleKey`/`capabilityKey`
      // default to the LAE demo's own original CT-imaging identifiers, so
      // that scenario (which never sets these) keeps behaving exactly as
      // before; a scenario with more than one bookable procedure (e.g. a
      // second, surgical appointment) sets its own keys so the two don't
      // collide/overwrite each other's capability record.
      //
      // Every value below is GENERATED-policy (per Blueprint.llmMayGenerate)
      // - `deps.generatedValues` (scenario/generatedValues.ts) lets whoever
      // is acting as the agent for this event supply these directly
      // (`set_generated_values`/POST .../generated-values), checked first;
      // only a field nobody supplied falls back to a small fixed default.
      // This is the "be the agent, not an API key" path - no
      // ANTHROPIC_API_KEY is needed for a human or an assistant driving
      // this workbench through its own tools to make these same choices.
      const overrides = deps.generatedValues.get(event.id);
      const data = event.data ?? {};
      const now = Date.now();
      const slotStart = typeof overrides.slotStart === 'string' ? overrides.slotStart : new Date(now + 3600_000).toISOString();
      const slotEnd = typeof overrides.slotEnd === 'string' ? overrides.slotEnd : new Date(now + 2 * 3600_000).toISOString();

      const serviceKey = typeof data.serviceKey === 'string' ? data.serviceKey : 'service-ct-imaging';
      const scheduleKey = typeof data.scheduleKey === 'string' ? data.scheduleKey : 'schedule-ct-today';
      const capabilityKey = typeof data.capabilityKey === 'string' ? data.capabilityKey : 'ct-imaging';
      const defaultServiceName = typeof data.serviceName === 'string' ? data.serviceName : 'CT-Diagnostik';
      const defaultComment = typeof data.comment === 'string' ? data.comment : 'CT-Pulmonalisangiographie (CTPA) bei V.a. Lungenembolie';

      const service = await ensureFhirResource(clinicDeps, {
        resourceType: 'HealthcareService', scenarioKey: serviceKey,
        values: { name: typeof overrides.healthcareServiceName === 'string' ? overrides.healthcareServiceName : defaultServiceName },
        provenance: 'GENERATED',
      });
      const schedule = await ensureFhirResource(clinicDeps, {
        resourceType: 'Schedule', scenarioKey: scheduleKey,
        values: {
          'actor.0.reference': serviceKey,
          'planningHorizon.start': new Date(now).toISOString(),
          'planningHorizon.end': new Date(now + 6 * 3600_000).toISOString(),
        },
        provenance: 'GENERATED',
      });

      const runDepsWithClinicFallback = withClinicFallback(deps, clinicDeps);
      const slot = await ensureFhirResource(runDepsWithClinicFallback, {
        resourceType: 'Slot', scenarioKey: `slot-${event.id}`,
        values: { 'schedule.reference': scheduleKey, status: 'busy', start: slotStart, end: slotEnd },
        provenance: 'GENERATED',
      });
      const appointment = await ensureFhirResource(deps, {
        resourceType: 'Appointment', scenarioKey: `appointment-${event.id}`,
        values: {
          status: 'booked',
          start: slotStart, end: slotEnd,
          'participant.0.actor.reference': patientScenarioKey, 'participant.0.status': 'accepted',
          'slot.0.reference': `slot-${event.id}`,
          comment: typeof overrides.appointmentComment === 'string' ? overrides.appointmentComment : defaultComment,
        },
        provenance: 'GENERATED',
      });
      // Registered on THIS run's own capabilities (not the clinic's) -
      // "for this patient, this procedure resolved to shared service/
      // schedule X plus their own slot/appointment Y/Z" is inherently
      // per-visit, even though two of its four resourceRefs point at
      // shared clinic entities.
      deps.capabilities.upsert(capabilityKey, {
        kind: 'fhir',
        resourceRefs: { healthcareService: serviceKey, schedule: scheduleKey, slot: `slot-${event.id}`, appointment: `appointment-${event.id}` },
      });

      // Historically request-imaging ALSO transferred the patient to
      // Radiologie - kept as the default so the LAE demo scenario (which
      // never sets `data.skipLocationTransfer`) keeps behaving exactly as
      // before. A scenario that already models its own explicit
      // `ward-transfer` around a booked procedure (e.g. scheduling an OP a
      // day before the patient is actually wheeled in) opts out.
      if (data.skipLocationTransfer !== true) {
        const station = readStationInfo(data, DEFAULT_IMAGING_STATION);
        const staff = readStaffInfo(data) ?? DEFAULT_IMAGING_STAFF;
        const practitioner = await recordLocationTransfer(deps, clinicDeps, event.id, station, staff);
        await updateEncounterHandover(deps, clinicDeps, practitioner, undefined);
      }

      return { service, schedule, slot, appointment };
    }

    default: {
      const exhaustive: never = event.type;
      throw new Error(`No handler for scenario event type "${exhaustive}".`);
    }
  }
}

function requirePatientEntity(deps: ScenarioEngineDeps, patientScenarioKey: string) {
  const entity = deps.registry.get(patientScenarioKey);
  if (!entity?.formsPatientId) throw new Error(`Patient "${patientScenarioKey}" has not been created yet (patient-arrival must run first).`);
  return entity;
}

/** The "system überwacht die Eingaben und kritisiert bei jedem Schritt"
 * ask: `critiqueScenario` is a pure function of the (already fully
 * expanded) scenario, computed fresh every call - cheap, and always
 * consistent with whatever the scenario file/dynamic-events currently say.
 *
 * Only findings anchored to an ALREADY-completed event are considered (a
 * gap about the discharge letter has no business appearing at hour 1) -
 * but for a dynamically-growing scenario (dynamicEvents.ts), "already
 * completed" is not the same set every call: an event that was genuinely
 * the scenario's own LAST event when first checked (so every "at
 * discharge" rule fired true) can later turn out not to have been the real
 * end at all, once more events get appended after it. Recomputing the
 * WHOLE critique fresh every call and reconciling (`resolveStale`) against
 * it - rather than a plain write-once check - is what keeps a Task
 * honestly reflecting the CURRENT scenario instead of freezing in whatever
 * was true the first time its anchor event completed. For every static,
 * fully-pre-expanded scenario (everything except the open-ended kind) this
 * changes nothing observable - the same findings recompute identically
 * every time. Every newly-opened Task is also mirrored into the Activity
 * log, the same place every other real action in this workbench is
 * visible. */
export function runCriticFor(deps: ScenarioEngineDeps, scenario: Scenario, completedEventIds: readonly string[]): void {
  const completed = new Set(completedEventIds);
  const findings = critiqueScenario(scenario).filter((finding) => completed.has(finding.anchorEventId));
  for (const finding of findings) {
    const { record, created } = deps.tasks.ensure({ id: finding.code, code: finding.code, description: finding.description, anchorEventId: finding.anchorEventId });
    if (!created) continue;
    deps.activity.append({
      reason: 'Kritik-System: Vollständigkeitsprüfung nach Ereignis "' + finding.anchorEventId + '"',
      action: 'critique',
      tool: 'critic',
      result: 'success',
      message: `Task erstellt: ${record.description}`,
    });
  }
  deps.tasks.resolveStale(new Set(findings.map((finding) => finding.code)));
}

/** Runs exactly the next not-yet-completed event and advances progress -
 * `execute_next_event`/the UI's "Step" button. Idempotent per event id: a
 * repeated call after progress was already saved simply finds no next
 * event for that id. Every underlying ensure* call is ALSO independently
 * idempotent per scenario key, so even re-running a step that partially
 * failed mid-way never duplicates HIP writes. */
export async function executeNextEvent(scenarioRunId: string, deps: ScenarioEngineDeps, clinicDeps: ScenarioEngineDeps, scenario: Scenario, progressStore: ScenarioProgressStore): Promise<AdvanceScenarioResult> {
  const progress = progressStore.get();
  const patientScenarioKey = progress.patientScenarioKey ?? scenario.patient.key;
  const next = scenario.events.find((event) => !progress.completedEventIds.includes(event.id));
  if (!next) {
    // Visual-sim groundwork: every static/dynamic event this run knows
    // about is done - the real next step, if any, is a live decision
    // someone (a human, or an "AI Arzt" - scenario/dynamicEvents.ts) still
    // has to make and append, not something already queued. "thinking" is
    // this exact wait, not a UI mockup value - logged, not just a status
    // flag, per the user's own ask for a real Activity-log trail of it.
    const reason = 'Nächster Schritt noch offen - wartet auf eine reale Entscheidung (Mensch oder AI-Arzt).';
    deps.entityStatus.set(patientScenarioKey, 'thinking', 'waiting for the next event to be decided/appended');
    deps.activity.append({ reason, action: 'thinking', result: 'success' });
    return { event: null, finished: true };
  }

  // A conversation is its own kind of activity, not a Form Builder
  // submission - "talking", not "filling-form" (user's own ask).
  deps.entityStatus.set(patientScenarioKey, next.type === 'patient-conversation' ? 'talking' : 'filling-form', `${next.id} (${next.type})`);
  try {
    await executeEvent(scenarioRunId, deps, clinicDeps, scenario, next, patientScenarioKey, progressStore);
  } catch (error) {
    if (error instanceof CapabilityUnresolved) {
      deps.entityStatus.set(patientScenarioKey, 'blocked-needs-form', error.capability);
    }
    throw error;
  }
  if (next.type === 'ward-transfer') {
    // User's own ask: on a handover, the doctor picking the case back up
    // starts genuinely "bei null" and may only work from what's actually
    // documented (get_world_state/get_hospital_state/get_handoff_briefing -
    // see mcp/tools/critiqueTools.ts), never carried-over narrative
    // context. Logged as a real "thinking" pause, not silently folded into
    // the generic "idle/completed" status every other event gets.
    const reason = `Übergabe an neue Station abgeschlossen - Behandlung beginnt bei null, nur auf Basis der dokumentierten Fakten (get_handoff_briefing).`;
    deps.entityStatus.set(patientScenarioKey, 'thinking', reason);
    deps.activity.append({ reason, action: 'thinking', tool: 'ward-transfer', result: 'success' });
  } else {
    deps.entityStatus.set(patientScenarioKey, 'idle', `${next.id} (${next.type}) completed`);
  }
  // Re-read fresh here rather than reusing the `progress` captured at the
  // top of this function: executeEvent may itself have gone through
  // executePendingTasks, which does its own progressStore.save() for any
  // synthetic executions it appended - saving against the stale `progress`
  // snapshot would silently wipe those completions back out.
  const latestProgress = progressStore.get();
  runCriticFor(deps, scenario, [...latestProgress.completedEventIds, next.id]);

  progressStore.save({
    ...latestProgress,
    patientScenarioKey,
    completedEventIds: [...latestProgress.completedEventIds, next.id],
    completedAt: { ...latestProgress.completedAt, [next.id]: new Date().toISOString() },
  });
  return { event: next, finished: false };
}

/** `advance_scenario`/the UI's "Play"/"Instant" actions - runs events one at
 * a time (each still independently logged to Activity/Registry) until the
 * scenario is finished or `maxEvents` is hit. `maxEvents` omitted runs to
 * completion (spec section 31's "Instant" mode). */
export async function runScenario(scenarioRunId: string, deps: ScenarioEngineDeps, clinicDeps: ScenarioEngineDeps, scenario: Scenario, progressStore: ScenarioProgressStore, maxEvents?: number): Promise<ScenarioEvent[]> {
  const executed: ScenarioEvent[] = [];
  while (maxEvents === undefined || executed.length < maxEvents) {
    const result = await executeNextEvent(scenarioRunId, deps, clinicDeps, scenario, progressStore);
    if (result.finished || !result.event) break;
    executed.push(result.event);
  }
  return executed;
}
