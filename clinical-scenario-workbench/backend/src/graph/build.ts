import { FallbackEntityRegistry } from '../entity/fallbackRegistry';
import { getPath } from '../fhir/resourceFactory';
import type { EntityRecord } from '../entity/registry';
import type { ScenarioEngineDeps } from '../scenario/engine';

/**
 * The "journey through the hospital" graph the frontend's JourneyGraph
 * component renders (React Flow) - built server-side so the frontend never
 * needs to understand FHIR reference shapes itself. Two flavors:
 * `buildJourneyGraph` is ONE case's own detailed journey; `buildClinicGraph`
 * is the bird's-eye view across every case at once, hung off the shared
 * clinic capacity. A node is either the Patient, one other FHIR entity, or
 * one openEHR capability (an "Anamnese"/"Vitalzeichen-Erfassung"
 * Composition, which has no FHIR entity of its own). An edge is a REAL
 * reference found inside an actual FHIR resource body (a `reference`-typed
 * FhirFormField's stored "ResourceType/id" value, resolved back to the
 * OTHER entity that owns that id via a reverse index) - not a guessed/
 * hardcoded shape, so the graph always matches what's genuinely in HIP
 * right now, including a resource grown by the Resource Form Manager after
 * this code was written.
 */
export interface JourneyGraphNode {
  id: string;
  kind: 'patient' | 'fhir' | 'openEHR' | 'location';
  resourceType?: string;
  capability?: string;
  label: string;
  /** A few short, human-readable secondary rows (e.g. a Patient's gender +
   * birth date, an Appointment's status + start time) - what makes the
   * graph show real clinical information at a glance instead of just a
   * resource-type badge and one name. */
  details: string[];
  provenance?: string;
  shared: boolean;
  /** Clinic-graph nodes only - which scenario run this Patient belongs to,
   * so the frontend can drill down into that case's own detailed graph. */
  scenarioRunId?: string;
  /** Case-graph nodes only - the scenarioKey of the Patient this node
   * ultimately belongs to (itself, for a Patient node), so the frontend can
   * offer an "open patient" shortcut on every node, not only the Patient's
   * own card. Undefined for a node with no single owning patient (a shared
   * clinic resource like HealthcareService/Schedule/Location). */
  patientScenarioKey?: string;
  createdAt: string;
}

export interface JourneyGraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface JourneyGraph {
  nodes: JourneyGraphNode[];
  edges: JourneyGraphEdge[];
  /** Clinic graph only - every real, timestamped ward transfer across every
   * case, oldest first. This is the honest source of truth the frontend's
   * time-scrubber replays: "where was patient P at time T" is always
   * derived from this real history, never fabricated for a moment the
   * simulation hasn't actually reached. */
  movements?: MovementMoment[];
}

export interface MovementMoment {
  scenarioRunId: string;
  /** Matches the clinic graph's own (scenarioRunId-namespaced) patient node
   * id, so the frontend can join a moment straight back to a node. */
  patientNodeId: string;
  locationScenarioKey: string;
  eventId: string;
  timestamp: string;
}

function formatShortDateTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatDate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString('de-DE');
}

const GENDER_LABELS: Record<string, string> = { male: 'Männlich', female: 'Weiblich', other: 'Divers', unknown: 'Unbekannt' };
const ENCOUNTER_STATUS_LABELS: Record<string, string> = { planned: 'Geplant', arrived: 'Angekommen', triaged: 'Triagiert', 'in-progress': 'Laufend', onleave: 'Unterbrochen', finished: 'Abgeschlossen', cancelled: 'Storniert' };
const APPOINTMENT_STATUS_LABELS: Record<string, string> = { proposed: 'Vorgeschlagen', pending: 'Ausstehend', booked: 'Gebucht', arrived: 'Patient anwesend', fulfilled: 'Durchgeführt', cancelled: 'Storniert', noshow: 'Nicht erschienen' };
const SLOT_STATUS_LABELS: Record<string, string> = { free: 'Frei', busy: 'Belegt', 'busy-unavailable': 'Nicht verfügbar', 'busy-tentative': 'Vorläufig belegt' };

/** Deliberately a small, explicit switch (matches scenario/engine.ts's own
 * per-event-type hardcoding) rather than a generic "pick some fields"
 * heuristic - a generic version picks ugly values just as often as good
 * ones (e.g. Encounter's own `class.system` is a bare code-system URI). */
function summarizeResource(resourceType: string, resource: Record<string, unknown>): string {
  switch (resourceType) {
    case 'Patient': {
      const given = getPath(resource, 'name.0.given.0');
      const family = getPath(resource, 'name.0.family');
      return [given, family].filter(Boolean).join(' ') || 'Patient';
    }
    case 'Encounter':
      return 'Encounter';
    case 'HealthcareService':
      return String(getPath(resource, 'name') ?? 'HealthcareService');
    case 'Schedule':
      return 'Schedule';
    case 'Slot':
      return formatShortDateTime(getPath(resource, 'start')) ?? 'Slot';
    case 'Appointment':
      return String(getPath(resource, 'comment') ?? getPath(resource, 'status') ?? 'Appointment');
    case 'Practitioner': {
      const given = getPath(resource, 'name.0.given.0');
      const family = getPath(resource, 'name.0.family');
      return ['Dr.', given, family].filter(Boolean).join(' ') || 'Practitioner';
    }
    default:
      return resourceType;
  }
}

/** The secondary info rows that make a node card actually informative -
 * same "small explicit switch per resourceType" reasoning as
 * summarizeResource above. */
function detailsFor(resourceType: string, resource: Record<string, unknown>): string[] {
  switch (resourceType) {
    case 'Patient': {
      const gender = getPath(resource, 'gender');
      const birth = formatDate(getPath(resource, 'birthDate'));
      const rows: string[] = [];
      if (typeof gender === 'string') rows.push(GENDER_LABELS[gender] ?? gender);
      if (birth) rows.push(`geb. ${birth}`);
      return rows;
    }
    case 'Encounter': {
      const status = getPath(resource, 'status');
      const start = formatShortDateTime(getPath(resource, 'period.start'));
      const rows: string[] = [];
      if (typeof status === 'string') rows.push(ENCOUNTER_STATUS_LABELS[status] ?? status);
      if (start) rows.push(`Aufnahme ${start}`);
      return rows;
    }
    case 'HealthcareService':
      return ['Fachabteilung / Klinikressource'];
    case 'Schedule': {
      const start = formatShortDateTime(getPath(resource, 'planningHorizon.start'));
      const end = formatShortDateTime(getPath(resource, 'planningHorizon.end'));
      return start && end ? [`${start} – ${end}`] : [];
    }
    case 'Slot': {
      const status = getPath(resource, 'status');
      const end = formatShortDateTime(getPath(resource, 'end'));
      const rows: string[] = [];
      if (typeof status === 'string') rows.push(SLOT_STATUS_LABELS[status] ?? status);
      if (end) rows.push(`bis ${end}`);
      return rows;
    }
    case 'Appointment': {
      const status = getPath(resource, 'status');
      const start = formatShortDateTime(getPath(resource, 'start'));
      const rows: string[] = [];
      if (typeof status === 'string') rows.push(APPOINTMENT_STATUS_LABELS[status] ?? status);
      if (start) rows.push(start);
      return rows;
    }
    case 'Practitioner': {
      const qualification = getPath(resource, 'qualification.0.code.text');
      return typeof qualification === 'string' ? [qualification] : [];
    }
    default:
      return [];
  }
}

const CAPABILITY_LABELS: Record<string, string> = {
  anamnesis: 'Anamnese',
  'vital-signs': 'Vitalzeichen',
};

async function entityToNode(deps: ScenarioEngineDeps, entity: EntityRecord, shared: boolean): Promise<{ node: JourneyGraphNode; resource: Record<string, unknown> }> {
  const resource = await deps.hip.get(entity.resourceType, entity.hipResourceId);
  return {
    resource,
    node: {
      id: entity.scenarioKey,
      kind: entity.resourceType === 'Patient' ? 'patient' : 'fhir',
      resourceType: entity.resourceType,
      label: summarizeResource(entity.resourceType, resource),
      details: detailsFor(entity.resourceType, resource),
      provenance: entity.provenance,
      shared,
      createdAt: entity.createdAt,
    },
  };
}

/** One case's own full journey - every entity that belongs to it (its own
 * plus, via the FallbackEntityRegistry merge, the shared clinic entities it
 * actually used), with every reference between them resolved into a real
 * edge. */
export async function buildJourneyGraph(deps: ScenarioEngineDeps, clinicDeps: ScenarioEngineDeps): Promise<JourneyGraph> {
  const registry = new FallbackEntityRegistry(deps.registry, clinicDeps.registry);
  const entities = registry.list();

  const byHipRef = new Map<string, string>(); // "ResourceType/id" -> scenarioKey
  for (const entity of entities) byHipRef.set(`${entity.resourceType}/${entity.hipResourceId}`, entity.scenarioKey);

  const nodes: JourneyGraphNode[] = [];
  const edges: JourneyGraphEdge[] = [];

  await Promise.all(entities.map(async (entity) => {
    const shared = !deps.registry.has(entity.scenarioKey) && clinicDeps.registry.has(entity.scenarioKey);
    const { node, resource } = await entityToNode(deps, entity, shared);
    nodes.push(node);

    const form = deps.forms.getByResourceType(entity.resourceType);
    if (!form) return;
    for (const field of form.fields) {
      if (field.type !== 'reference') continue;
      const rawRef = getPath(resource, field.path);
      if (typeof rawRef !== 'string') continue;
      const targetKey = byHipRef.get(rawRef);
      if (!targetKey) continue; // points at something outside this workbench's own entity set
      edges.push({ id: `${entity.scenarioKey}::${field.path}`, from: entity.scenarioKey, to: targetKey, label: field.label });
    }
  }));

  // The patient's own current ward, surfaced as a detail row on their own
  // node (not a separate node here - the per-case view is already rich;
  // the Klinik view is where wards get their own nodes/edges).
  const currentLocation = deps.locationLog.current();
  if (currentLocation) {
    const location = clinicDeps.locations.get(currentLocation.locationScenarioKey);
    const patientNode = nodes.find((n) => n.kind === 'patient');
    if (patientNode && location) patientNode.details.push(`Aktueller Ort: ${location.name}`);
  }

  for (const capability of deps.capabilities.list()) {
    if (capability.kind !== 'openEHR') continue;
    const nodeId = `capability:${capability.capability}`;
    nodes.push({
      id: nodeId,
      kind: 'openEHR',
      capability: capability.capability,
      label: CAPABILITY_LABELS[capability.capability] ?? capability.capability,
      details: [],
      shared: false,
      createdAt: capability.createdAt,
    });
    if (capability.patientScenarioKey) {
      edges.push({ id: `capability-edge:${capability.capability}`, from: capability.patientScenarioKey, to: nodeId, label: CAPABILITY_LABELS[capability.capability] ?? capability.capability });
      nodes[nodes.length - 1].patientScenarioKey = capability.patientScenarioKey;
    }
  }

  // Resolve each node's owning patient generically from the edges just
  // built, rather than a second per-resourceType switch: a Patient owns
  // itself; anything else owns whichever Patient it has a DIRECT reference
  // edge to (Encounter.subject, Appointment.participant, ...). A node with
  // no such edge (HealthcareService/Schedule/Location - shared, not
  // patient-specific) is left without one, and the frontend hides the
  // "open patient" shortcut accordingly.
  const patientNodeIds = new Set(nodes.filter((n) => n.kind === 'patient').map((n) => n.id));
  for (const node of nodes) {
    if (node.patientScenarioKey) continue;
    if (patientNodeIds.has(node.id)) { node.patientScenarioKey = node.id; continue; }
    const toPatient = edges.find((edge) => edge.from === node.id && patientNodeIds.has(edge.to));
    if (toPatient) node.patientScenarioKey = toPatient.to;
  }

  return { nodes, edges };
}

export interface ClinicGraphRun {
  scenarioRunId: string;
  deps: ScenarioEngineDeps;
  eventsCompleted: number;
  eventsTotal: number;
}

/** The bird's-eye "Klinik" view: the shared clinic's own standing capacity
 * (HealthcareService/Schedule, ...) as the hub, with every real case's own
 * Patient hung off it - connected via a real edge only when that case's own
 * capability record shows it actually used a piece of that shared capacity
 * (spec's "new patients reuse the same clinic" correction, made visible).
 * Deliberately shallow (just the Patient per case, not every one of their
 * own resources) - that level of detail is what `buildJourneyGraph`'s own
 * per-case view is for; this one is about clinic-wide load, not one
 * patient's story. */
export async function buildClinicGraph(clinicDeps: ScenarioEngineDeps, runs: ClinicGraphRun[]): Promise<JourneyGraph> {
  const nodes: JourneyGraphNode[] = [];
  const edges: JourneyGraphEdge[] = [];
  const movements: MovementMoment[] = [];

  await Promise.all(clinicDeps.registry.list().map(async (entity) => {
    const { node } = await entityToNode(clinicDeps, entity, true);
    nodes.push(node);
  }));

  // The local (non-FHIR) ward roster - see localLocations.ts's own doc
  // comment for why these aren't real FHIR Location resources. Staff
  // (`staffScenarioKeys`) are REAL FHIR Practitioner entities - already
  // picked up as their own nodes by the clinicDeps.registry loop above -
  // this just draws the "Station -> Mitarbeitende" edge between them.
  // Patient-count detail is filled in below, once every run's current
  // location is known.
  for (const location of clinicDeps.locations.list()) {
    nodes.push({
      id: location.scenarioKey,
      kind: 'location',
      label: location.name,
      details: [location.description],
      shared: true,
      createdAt: location.createdAt ?? new Date(0).toISOString(),
    });
    for (const staffKey of location.staffScenarioKeys) {
      edges.push({ id: `staff-edge:${location.scenarioKey}:${staffKey}`, from: location.scenarioKey, to: staffKey, label: 'Mitarbeitende' });
    }
  }

  await Promise.all(runs.map(async (run) => {
    const patientEntity = run.deps.registry.list().find((entity) => entity.resourceType === 'Patient');
    if (!patientEntity) return; // a scenario run with no patient yet is not shown - nothing to hang off the clinic
    const { node, resource } = await entityToNode(run.deps, patientEntity, false);
    const given = getPath(resource, 'name.0.given.0');
    const family = getPath(resource, 'name.0.family');
    // The Patient's own scenarioKey (e.g. "patient-maria") is fixed by the
    // scenario definition, NOT unique per run - two runs of the same
    // scenario file share it. Only this clinic-wide graph mixes multiple
    // runs' data together, so only here the node id must be namespaced by
    // scenarioRunId to avoid two different patients colliding on one node.
    const clinicNodeId = `${run.scenarioRunId}::${patientEntity.scenarioKey}`;
    nodes.push({
      ...node,
      id: clinicNodeId,
      label: [given, family].filter(Boolean).join(' ') || run.scenarioRunId,
      details: [...node.details, `${run.eventsCompleted}/${run.eventsTotal} Schritte`],
      scenarioRunId: run.scenarioRunId,
    });

    for (const capability of run.deps.capabilities.list()) {
      if (capability.kind !== 'fhir' || !capability.resourceRefs?.healthcareService) continue;
      edges.push({
        id: `clinic-edge:${run.scenarioRunId}:${capability.capability}`,
        from: clinicNodeId,
        to: capability.resourceRefs.healthcareService,
        label: CAPABILITY_LABELS[capability.capability] ?? capability.capability,
      });
    }

    // This patient's own real, timestamped ward history - feeds both the
    // "where are they right now" edge below and the frontend's time-
    // scrubber (which replays `movements` directly, never re-deriving it).
    const log = run.deps.locationLog.list();
    for (const entry of log) {
      movements.push({ scenarioRunId: run.scenarioRunId, patientNodeId: clinicNodeId, locationScenarioKey: entry.locationScenarioKey, eventId: entry.eventId, timestamp: entry.timestamp });
    }
    const current = log[log.length - 1];
    if (current) {
      edges.push({ id: `location-edge:${run.scenarioRunId}`, from: clinicNodeId, to: current.locationScenarioKey, label: 'aktuell' });
    }
  }));

  movements.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // "Station mit Daten" - once every patient's current location is known
  // (the `location-edge:` entries just built), each Station's own card
  // shows real load: how many staff, how many patients right now. This is
  // deliberately the LAST thing computed, and never touches a Patient's
  // own card - the Station is the primary, data-rich node here; patients
  // are only ever a small edge hanging off it.
  const currentPatientCountByLocation = new Map<string, number>();
  for (const edge of edges) {
    if (!edge.id.startsWith('location-edge:')) continue;
    currentPatientCountByLocation.set(edge.to, (currentPatientCountByLocation.get(edge.to) ?? 0) + 1);
  }
  for (const node of nodes) {
    if (node.kind !== 'location') continue;
    const staffCount = edges.filter((e) => e.id.startsWith('staff-edge:') && e.from === node.id).length;
    const patientCount = currentPatientCountByLocation.get(node.id) ?? 0;
    node.details.push(`${staffCount} Mitarbeitende · ${patientCount} Patient${patientCount === 1 ? '' : 'en'} aktuell`);
  }

  return { nodes, edges, movements };
}
