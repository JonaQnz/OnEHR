/**
 * Talks ONLY to this workbench's own backend (never the Forms apps/api
 * directly - same rule vital-signs-generator/frontend follows, see its
 * README.md) - avoids any CORS/cookie complexity for the Forms session,
 * which stays entirely server-side in backend/src/apiClient.ts.
 */
const API_BASE = import.meta.env.VITE_WORKBENCH_API_URL || 'http://localhost:4500';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

export interface EntityRecord {
  scenarioKey: string;
  resourceType: string;
  hipResourceId: string;
  fhirVersionId?: string;
  ehrId?: string;
  formsPatientId?: string;
  provenance: 'SOURCE' | 'DERIVED' | 'GENERATED' | 'USER';
  fieldProvenance: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CapabilityRecord {
  capability: string;
  kind: 'fhir' | 'openEHR';
  formId?: string;
  compositionFormId?: string;
  blockId?: string;
  patientScenarioKey?: string;
  compositionSessionId?: string;
  formSessionId?: string;
  providerReference?: string;
}

export interface ActivityEntry {
  id: string;
  timestamp: string;
  reason: string;
  action: string;
  tool?: string;
  result: 'success' | 'error';
  message?: string;
}

export interface FhirFormField {
  path: string;
  label: string;
  type: string;
  required: boolean;
  editable: boolean;
  sourcePolicy: string;
  referenceResourceTypes?: string[];
  options?: Array<{ value: string; label: string }>;
}

export interface FhirResourceForm {
  id: string;
  resourceType: string;
  version: number;
  fields: FhirFormField[];
  createdBy?: string;
  editable?: boolean;
}

export interface WorldState {
  scenarioRunId: string;
  entities: EntityRecord[];
  capabilities: CapabilityRecord[];
  fhirResourceForms: FhirResourceForm[];
  activityLog: ActivityEntry[];
}

export interface ScenarioEvent {
  id: string;
  type: string;
  at: string;
  data?: Record<string, unknown>;
}

export interface Facility {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

/** User's own ask: "dass wir ein zweites Haus eröffnen können" - each
 * facility has its own independent stations/staff/booking capacity (backend
 * context.ts's `clinicNamespaceFor`); a scenario run belongs to exactly one. */
export function listFacilities(): Promise<{ facilities: Facility[] }> {
  return request('/api/facilities');
}

export function openFacility(id: string, name: string, description?: string): Promise<Facility> {
  return request('/api/facilities', { method: 'POST', body: JSON.stringify({ id, name, description }) });
}

export function listScenarios(facilityId?: string): Promise<{ scenarioIds: string[] }> {
  return request(`/api/scenarios${facilityId ? `?facilityId=${encodeURIComponent(facilityId)}` : ''}`);
}

export function listScenarioRuns(facilityId?: string): Promise<{ scenarioRunIds: string[] }> {
  return request(`/api/scenario-runs${facilityId ? `?facilityId=${encodeURIComponent(facilityId)}` : ''}`);
}

export function createScenarioRun(scenarioRunId: string, scenarioId: string): Promise<unknown> {
  return request('/api/scenario-runs', { method: 'POST', body: JSON.stringify({ scenarioRunId, scenarioId }) });
}

export function resetScenarioRun(scenarioRunId: string): Promise<void> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}`, { method: 'DELETE' });
}

export function stepScenario(scenarioRunId: string): Promise<{ event: ScenarioEvent | null; finished: boolean }> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/step`, { method: 'POST' });
}

export function playScenario(scenarioRunId: string, maxEvents?: number): Promise<{ executed: ScenarioEvent[]; finished: boolean }> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/play`, { method: 'POST', body: JSON.stringify({ maxEvents }) });
}

export function getWorldState(scenarioRunId: string): Promise<WorldState> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/world-state`);
}

export function getEntityDetail(scenarioRunId: string, scenarioKey: string): Promise<{ entity: EntityRecord; resource: Record<string, unknown>; form?: FhirResourceForm }> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/entities/${encodeURIComponent(scenarioKey)}`);
}

export function getCapabilityEmbedUrl(scenarioRunId: string, capability: string): Promise<{ launchUrl: string; webUrl: string }> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/capabilities/${encodeURIComponent(capability)}/embed`);
}

export interface UpdateEntityResult {
  entity: EntityRecord;
  resource: Record<string, unknown>;
  refused: string[];
}

/** Always a USER-provenance edit (spec section 37/38) - `values` only needs
 * to carry the fields actually being changed, keyed by FhirFormField.path;
 * the backend merges them with the resource's current values before
 * re-validating (see agent/planner.ts's updateFhirResourceEntity). Any
 * field already owned by an equal-or-higher-priority value is silently
 * skipped server-side and reported back in `refused`, never applied. */
export function updateEntity(scenarioRunId: string, scenarioKey: string, values: Record<string, unknown>): Promise<UpdateEntityResult> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/entities/${encodeURIComponent(scenarioKey)}`, {
    method: 'PUT',
    body: JSON.stringify({ values }),
  });
}

// Spec section 30 - FhirResourceForms are global (one "appointment" form
// shared across every scenario run), so these are deliberately NOT scoped
// by scenarioRunId.
export function listResourceForms(): Promise<{ forms: FhirResourceForm[] }> {
  return request('/api/resource-forms');
}

export function addResourceFormField(formId: string, field: FhirFormField): Promise<FhirResourceForm> {
  return request(`/api/resource-forms/${encodeURIComponent(formId)}/fields`, { method: 'POST', body: JSON.stringify(field) });
}

export function updateResourceFormField(formId: string, path: string, patch: Partial<FhirFormField>): Promise<FhirResourceForm> {
  return request(`/api/resource-forms/${encodeURIComponent(formId)}/fields/${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify(patch) });
}

export interface JourneyGraphNode {
  id: string;
  kind: 'patient' | 'fhir' | 'openEHR' | 'location';
  resourceType?: string;
  capability?: string;
  label: string;
  details: string[];
  provenance?: string;
  shared: boolean;
  /** Clinic-graph nodes only - which case this Patient belongs to. */
  scenarioRunId?: string;
  /** Case-graph nodes only - the scenarioKey of the Patient this node
   * belongs to (itself, for a Patient node) - drives the "open patient"
   * shortcut on every node, not just the Patient's own card. */
  patientScenarioKey?: string;
  createdAt: string;
}

export interface JourneyGraphEdge {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface MovementMoment {
  scenarioRunId: string;
  patientNodeId: string;
  locationScenarioKey: string;
  eventId: string;
  timestamp: string;
}

export interface JourneyGraph {
  nodes: JourneyGraphNode[];
  edges: JourneyGraphEdge[];
  /** Clinic graph only - see backend graph/build.ts's own doc comment. */
  movements?: MovementMoment[];
}

export function getJourneyGraph(scenarioRunId: string): Promise<JourneyGraph> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/graph`);
}

/** The bird's-eye "Klinik" view - every real case's own Patient hung off
 * ONE facility's shared clinic capacity (default: the original hospital). */
export function getClinicGraph(facilityId?: string): Promise<JourneyGraph> {
  return request(`/api/clinic-graph${facilityId ? `?facilityId=${encodeURIComponent(facilityId)}` : ''}`);
}

export interface TimelineEntry {
  event: ScenarioEvent;
  completed: boolean;
  completedAt?: string;
}

export function getTimeline(scenarioRunId: string): Promise<{ timeline: TimelineEntry[] }> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/timeline`);
}

export type EntityActivityStatus = 'idle' | 'thinking' | 'filling-form' | 'blocked-needs-form' | 'moving' | 'talking';

export interface EntityStatusRecord {
  scenarioKey: string;
  status: EntityActivityStatus;
  reason?: string;
  updatedAt: string;
}

export interface LocalLocation {
  scenarioKey: string;
  name: string;
  description: string;
  staffScenarioKeys: string[];
  createdAt: string;
}

export interface LocationLogEntry {
  eventId: string;
  locationScenarioKey: string;
  timestamp: string;
  bedLabel?: string;
}

export interface HospitalState {
  stations: LocalLocation[];
  entityStatus: EntityStatusRecord[];
  locationHistory: LocationLogEntry[];
}

/** The visual-sim snapshot for one run - the shared clinic's own station
 * roster plus this run's own current per-patient status and real transfer
 * history. Backs HospitalSimulation.tsx; the route itself already existed
 * (activity/entityStatus.ts + world/locationLog.ts), this is just its first
 * frontend wrapper. */
export function getHospitalState(scenarioRunId: string): Promise<HospitalState> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/hospital-state`);
}

export function getGeneratedValues(scenarioRunId: string, eventId: string): Promise<Record<string, unknown>> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/events/${encodeURIComponent(eventId)}/generated-values`);
}

export function setGeneratedValues(scenarioRunId: string, eventId: string, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  return request(`/api/scenario-runs/${encodeURIComponent(scenarioRunId)}/events/${encodeURIComponent(eventId)}/generated-values`, {
    method: 'POST',
    body: JSON.stringify(values),
  });
}
