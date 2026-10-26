import { loadConfig, type WorkbenchConfig } from './config';
import { FormbuilderApiClient } from './apiClient';
import { FhirHipClient } from './fhirHip/resourceClient';
import { BlueprintLoader } from './fhir/blueprint';
import { ResourceFormStore } from './fhir/resourceFormStore';
import { EntityRegistry } from './entity/registry';
import { CapabilityRegistry } from './capability/registry';
import { DynamicCapabilityRegistry } from './capability/dynamicRegistry';
import { ActivityLog } from './activity/log';
import { ScenarioProgressStore } from './scenario/progress';
import { GeneratedValuesStore } from './scenario/generatedValues';
import { LocalLocationRegistry } from './world/localLocations';
import { LocationLog } from './world/locationLog';
import { TaskStore } from './critic/taskStore';
import { DynamicEventsStore } from './scenario/dynamicEvents';
import { EntityStatusStore } from './activity/entityStatus';
import { PendingTaskStore } from './activity/pendingTasks';
import { FacilityRegistry, FACILITY_REGISTRY_NAMESPACE } from './world/facilities';
import type { PlannerDeps } from './agent/planner';

/** The original, always-open facility - every scenario run/file that
 * predates multi-facility support (no `facilityId` of its own) resolves
 * here, and its own clinic namespace is the LEGACY bare `'_clinic'` string
 * (see `clinicNamespaceFor` below) so every already-accumulated hospital
 * Location/HealthcareService/Schedule stays exactly where it is - zero data
 * migration for existing runs. */
export const DEFAULT_FACILITY_ID = 'krankenhaus';

/** User's own ask: "dass wir ein zweites Haus eröffnen können" - each open
 * facility (world/facilities.ts's `FacilityRegistry`) gets its OWN
 * independent "clinic" namespace, so a Rehazentrum's stations/staff/
 * HealthcareService/Schedule capacity never mixes with the hospital's. The
 * default facility keeps the legacy bare `'_clinic'` namespace (backward
 * compatible); every other facility gets `_clinic:<facilityId>`. */
export function clinicNamespaceFor(facilityId: string): string {
  return facilityId === DEFAULT_FACILITY_ID ? '_clinic' : `_clinic:${facilityId}`;
}

/** Inverse of `clinicNamespaceFor` - returns the facilityId a clinic
 * pseudo-run namespace belongs to, or `undefined` for a real (non-clinic)
 * scenarioRunId. */
export function facilityIdForClinicNamespace(namespace: string): string | undefined {
  if (namespace === '_clinic') return DEFAULT_FACILITY_ID;
  const match = /^_clinic:(.+)$/.exec(namespace);
  return match ? match[1] : undefined;
}

/** The reserved scenarioRunId for "the clinic" - its organizational
 * capacity (HealthcareService, Schedule, ...) is shared and accumulates
 * across every real scenario run rather than being re-created per run: a
 * new patient/run reuses the SAME CT-Diagnostik service and schedule a
 * previous one already ensured, and the clinic only grows when a genuinely
 * new capability is needed (spec section 18's "Nothing exists until the
 * scenario needs it" applies to the clinic as a whole, not per-run). Never
 * used as a real, user-visible scenarioRunId - `scenario/engine.ts`'s
 * request-imaging handler is the one place that writes to it directly, via
 * `WorkbenchContext.clinicDeps()`, while Patient/Encounter/Slot/Appointment
 * still go through the actual per-patient scenarioRunId. Not exported from
 * .mcp.json's tool surface as something an agent can address directly - it
 * is deliberately just "the (default facility's) clinic", not a run. Kept
 * as a plain constant (rather than requiring every caller to spell
 * `clinicNamespaceFor(DEFAULT_FACILITY_ID)`) so every pre-existing import of
 * this name keeps compiling unchanged. */
export const CLINIC_NAMESPACE = clinicNamespaceFor(DEFAULT_FACILITY_ID);

/** A real scenarioRunId must never collide with one of the reserved
 * pseudo-run namespaces - the default facility's clinic (`CLINIC_NAMESPACE`),
 * any OTHER facility's own clinic (`_clinic:<id>`), or the facility
 * directory itself. Shared by both the HTTP server and the MCP tools, so
 * the guard can never drift between the two entry points. */
export function isReservedNamespace(id: string): boolean {
  return id === CLINIC_NAMESPACE || id === FACILITY_REGISTRY_NAMESPACE || id.startsWith('_clinic:');
}

/** The full dependency bundle `forRun`/`clinicDeps` hand out - both the
 * HTTP server and the MCP server build every route/tool on top of this one
 * shape, so neither ever has its own separate wiring. */
export interface WorkbenchDeps extends PlannerDeps {
  capabilities: CapabilityRegistry;
  api: FormbuilderApiClient;
  progress: ScenarioProgressStore;
  generatedValues: GeneratedValuesStore;
  locations: LocalLocationRegistry;
  locationLog: LocationLog;
  tasks: TaskStore;
  dynamicEvents: DynamicEventsStore;
  /** "Form Builder as a capability" - the clinic-scoped, MCP-tool-writable
   * registry of capability bindings discovered/created after
   * `capability/catalog.ts`'s static list was authored. Shared across every
   * run, same reasoning as `forms`/`locations` below. */
  dynamicCapabilities: DynamicCapabilityRegistry;
  /** Visual-sim groundwork - see activity/entityStatus.ts's own doc
   * comment. Per-run, unlike dynamicCapabilities above. */
  entityStatus: EntityStatusStore;
  /** The real order lifecycle - see activity/pendingTasks.ts's own doc
   * comment. Per-run. */
  pendingTasks: PendingTaskStore;
}

/**
 * Wires up everything a scenario run needs. `BlueprintLoader`/`FhirHipClient`/
 * `FormbuilderApiClient` are shared across every run (blueprints are static
 * data, the HIP connection is one shared session). FhirResourceForms are
 * ALSO shared globally (spec's own framing: a Resource Form, once created
 * for a resource type, is reused everywhere - never re-derived per run) -
 * `forms` below is therefore always the one clinic-scoped ResourceFormStore,
 * regardless of which scenarioRunId `forRun` is called with. Only entities/
 * capabilities/activity/progress are genuinely per-scenarioRunId, since
 * that's what actually needs to look "empty" for a fresh run (spec section
 * 3) - and even entities fall through to the shared clinic registry for
 * reference resolution where needed (entity/fallbackRegistry.ts). Both the
 * HTTP server and the MCP server build their tool/route handlers on top of
 * this same WorkbenchContext, so neither ever has its own separate copy of
 * the planner wiring.
 */
export class WorkbenchContext {
  readonly config: WorkbenchConfig;
  readonly api: FormbuilderApiClient;
  readonly hip: FhirHipClient;
  readonly blueprints: BlueprintLoader;
  private readonly clinicForms: ResourceFormStore;
  /** One local (NOT FHIR - see localLocations.ts's own doc comment) ward
   * roster PER FACILITY - a Rehazentrum's stations/staff must never mix
   * with the hospital's. Lazily built/cached by `locationsFor` below,
   * keyed by facilityId (not by clinic namespace string) so callers never
   * have to think about the namespace encoding. */
  private readonly clinicLocationsByFacility = new Map<string, LocalLocationRegistry>();
  /** Same clinic-scoped sharing reasoning as `clinicForms` above - a
   * discovered/created capability binding (openEHR Form/block wiring) is
   * shared clinical documentation infrastructure, reusable by every
   * facility, not physical/organizational state - deliberately GLOBAL, not
   * per-facility. */
  private readonly clinicDynamicCapabilities: DynamicCapabilityRegistry;
  /** The directory of open facilities ("Häuser") - see world/facilities.ts. */
  readonly facilities: FacilityRegistry;
  private readonly runs = new Map<string, PlannerDeps>();

  constructor(config: WorkbenchConfig = loadConfig()) {
    this.config = config;
    this.api = new FormbuilderApiClient({
      baseUrl: config.formbuilderApiUrl,
      username: config.formbuilderUsername,
      password: config.formbuilderPassword,
    });
    this.hip = new FhirHipClient(this.api);
    this.blueprints = new BlueprintLoader(config.blueprintsDir);
    this.clinicForms = new ResourceFormStore(this.config.dataDir, CLINIC_NAMESPACE, this.blueprints);
    this.clinicDynamicCapabilities = new DynamicCapabilityRegistry(this.config.dataDir, CLINIC_NAMESPACE);
    this.facilities = new FacilityRegistry(this.config.dataDir);
    this.facilities.open(DEFAULT_FACILITY_ID, 'Krankenhaus', 'Das ursprüngliche, allgemeine Krankenhaus.');
  }

  /** Lazily builds (and caches) one facility's own station/staff roster -
   * never shared across facilities, unlike `clinicForms`/
   * `clinicDynamicCapabilities` above. */
  private locationsFor(facilityId: string): LocalLocationRegistry {
    const cached = this.clinicLocationsByFacility.get(facilityId);
    if (cached) return cached;
    const registry = new LocalLocationRegistry(this.config.dataDir, clinicNamespaceFor(facilityId));
    this.clinicLocationsByFacility.set(facilityId, registry);
    return registry;
  }

  /** Lazily builds (and caches) the JSON-store-backed dependencies for one
   * scenario run - each run's entities/capabilities/activity live in their
   * own directory (world/jsonStore.ts), so switching `scenarioRunId` never
   * mixes two runs' own patient data even within one long-lived server
   * process. Pass `CLINIC_NAMESPACE` (or use `clinicDeps()` below) to get
   * the shared clinic's own dependencies instead of a real run's. */
  forRun(scenarioRunId: string): WorkbenchDeps {
    const cached = this.runs.get(scenarioRunId) as WorkbenchDeps | undefined;
    if (cached) return cached;
    // A clinic pseudo-run (scenarioRunId === clinicNamespaceFor(someFacility))
    // gets THAT facility's own station/staff roster; a real patient run gets
    // the default facility's - harmless, since a real run's own `.locations`
    // field is never actually read anywhere (only `clinicDeps().locations`
    // is, confirmed by grep across scenario/engine.ts).
    const locations = this.locationsFor(facilityIdForClinicNamespace(scenarioRunId) ?? DEFAULT_FACILITY_ID);
    const deps: WorkbenchDeps = {
      blueprints: this.blueprints,
      forms: this.clinicForms,
      locations,
      dynamicCapabilities: this.clinicDynamicCapabilities,
      registry: new EntityRegistry(this.config.dataDir, scenarioRunId),
      capabilities: new CapabilityRegistry(this.config.dataDir, scenarioRunId),
      locationLog: new LocationLog(this.config.dataDir, scenarioRunId),
      tasks: new TaskStore(this.config.dataDir, scenarioRunId),
      dynamicEvents: new DynamicEventsStore(this.config.dataDir, scenarioRunId),
      entityStatus: new EntityStatusStore(this.config.dataDir, scenarioRunId),
      pendingTasks: new PendingTaskStore(this.config.dataDir, scenarioRunId),
      hip: this.hip,
      // Given straight to agent/patientBridge.ts and openehr/capabilityBridge.ts,
      // which call apps/api routes the FhirHipClient wrapper doesn't cover
      // (patient onboarding, composition/form sessions) - not otherwise used
      // by the FHIR Resource Form pipeline, which only ever goes through `hip`.
      api: this.api,
      activity: new ActivityLog(this.config.dataDir, scenarioRunId),
      // scenarioId '' is only ever the in-memory default before this run's
      // own progress.json exists - POST /api/scenario-runs is what actually
      // sets a real one (scenario/loader.ts's loadScenario is then keyed off
      // this file's own persisted scenarioId, not this placeholder).
      progress: new ScenarioProgressStore(this.config.dataDir, scenarioRunId, ''),
      generatedValues: new GeneratedValuesStore(this.config.dataDir, scenarioRunId),
    };
    this.runs.set(scenarioRunId, deps);
    return deps;
  }

  /** One facility's own shared clinic dependencies - `scenario/engine.ts`'s
   * request-imaging handler ensures HealthcareService/Schedule through
   * this, never through a real scenarioRunId's own deps, so they persist
   * and accumulate across every patient/run AT THAT FACILITY instead of
   * being re-created each time. Defaults to the original hospital, so
   * every pre-existing call site that never thinks about facilities at all
   * keeps working unchanged. */
  clinicDeps(facilityId: string = DEFAULT_FACILITY_ID): WorkbenchDeps {
    return this.forRun(clinicNamespaceFor(facilityId));
  }

  /** Convenience for the common case: a caller already holds a real
   * scenarioRunId and wants THAT run's own facility's clinic deps (not
   * necessarily the default facility's) - reads the run's own
   * `progress.facilityId` (falling back to the default for a run created
   * before multi-facility support existed) rather than making every call
   * site re-derive this. */
  clinicDepsForRun(scenarioRunId: string): WorkbenchDeps {
    const facilityId = this.forRun(scenarioRunId).progress.get().facilityId ?? DEFAULT_FACILITY_ID;
    return this.clinicDeps(facilityId);
  }

  /** Drops this run's in-memory dependency cache so the NEXT `forRun` call
   * rebuilds every store fresh off disk - must be called whenever a run's
   * underlying JSON files are deleted out from under it (world/jsonStore.ts's
   * deleteScenarioRun, spec section 3's "Reset Scenario"), or the cached
   * EntityRegistry/etc. instances would keep serving their old in-memory
   * state as if nothing had been reset. Never call this with
   * CLINIC_NAMESPACE - "Reset Scenario" resets one patient's run, never the
   * shared clinic. */
  forgetRun(scenarioRunId: string): void {
    this.runs.delete(scenarioRunId);
  }
}
