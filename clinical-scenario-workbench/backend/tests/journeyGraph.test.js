const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BlueprintLoader } = require('../dist/fhir/blueprint');
const { ResourceFormStore } = require('../dist/fhir/resourceFormStore');
const { EntityRegistry } = require('../dist/entity/registry');
const { CapabilityRegistry } = require('../dist/capability/registry');
const { ActivityLog } = require('../dist/activity/log');
const { ScenarioProgressStore } = require('../dist/scenario/progress');
const { GeneratedValuesStore } = require('../dist/scenario/generatedValues');
const { LocalLocationRegistry } = require('../dist/world/localLocations');
const { LocationLog } = require('../dist/world/locationLog');
const { TaskStore } = require('../dist/critic/taskStore');
const { EntityStatusStore } = require('../dist/activity/entityStatus');
const { PendingTaskStore } = require('../dist/activity/pendingTasks');
const { runScenario } = require('../dist/scenario/engine');
const { buildJourneyGraph, buildClinicGraph } = require('../dist/graph/build');

const blueprintsDir = path.join(__dirname, '..', 'src', 'fhir', 'blueprints');
const CLINIC_NAMESPACE = '_clinic';

const scenario = {
  scenarioId: 'test-scenario',
  patient: { key: 'patient-maria', firstName: 'Maria', lastName: 'Schneider', sex: 'female', age: 67 },
  events: [
    { id: 'arrival', type: 'patient-arrival', at: '0m' },
    { id: 'anamnesis', type: 'anamnesis', at: '5m', data: { diagnosis: 'Verdacht auf Lungenembolie' } },
    { id: 'vitals', type: 'vital-signs', at: '10m', data: { heartRate: 108, spo2: 91 } },
    { id: 'ctpa-request', type: 'request-imaging', at: '15m', data: { service: 'ct-pulmonary-angiography' } },
  ],
};

// Mirrors tests/scenarioEngine.test.js's own testWorld/fakeHip/fakeApi -
// same shape, so this test exercises the real engine's output, not a
// hand-rolled world state that might not match what buildJourneyGraph
// actually receives in production.
function testWorld() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csw-graph-'));
  const blueprints = new BlueprintLoader(blueprintsDir);
  const forms = new ResourceFormStore(dataDir, CLINIC_NAMESPACE, blueprints);
  const locations = new LocalLocationRegistry(dataDir, CLINIC_NAMESPACE);
  const depsFor = (scenarioRunId) => ({
    blueprints,
    forms,
    locations,
    registry: new EntityRegistry(dataDir, scenarioRunId),
    capabilities: new CapabilityRegistry(dataDir, scenarioRunId),
    locationLog: new LocationLog(dataDir, scenarioRunId),
    tasks: new TaskStore(dataDir, scenarioRunId),
    entityStatus: new EntityStatusStore(dataDir, scenarioRunId),
    pendingTasks: new PendingTaskStore(dataDir, scenarioRunId),
    activity: new ActivityLog(dataDir, scenarioRunId),
    progressStore: new ScenarioProgressStore(dataDir, scenarioRunId, scenario.scenarioId),
    generatedValues: new GeneratedValuesStore(dataDir, scenarioRunId),
  });
  return { depsFor, clinicDeps: depsFor(CLINIC_NAMESPACE) };
}

function fakeHip() {
  const store = new Map();
  let nextId = 1;
  return {
    async create(resourceType, resource) {
      const id = String(nextId += 1);
      const stored = { ...resource, id, meta: { versionId: '1' } };
      store.set(`${resourceType}/${id}`, stored);
      return stored;
    },
    async get(resourceType, id) {
      const found = store.get(`${resourceType}/${id}`);
      if (!found) throw new Error(`not found: ${resourceType}/${id}`);
      return found;
    },
    // request-imaging now transfers the patient's Encounter to a new
    // Location via updateFhirResourceEntity.
    async update(resourceType, id, resource) {
      const stored = { ...resource, id, meta: { versionId: '2' } };
      store.set(`${resourceType}/${id}`, stored);
      return stored;
    },
    async search() { throw new Error('not used in this test'); },
  };
}

// Real HIP genuinely stores the Patient created via Forms' own /api/patients
// (that's the whole point of ensureScenarioPatient - see agent/patientBridge.ts) -
// so unlike fakeHip's other entries, the Patient must ALSO land in the same
// fake HIP store for buildJourneyGraph's later `deps.hip.get('Patient', ...)`
// to find it, exactly as it would against the real FHIR CDR.
function fakeApi(hip) {
  let nextSessionId = 1;
  let nextPatientId = 1;
  return {
    post: async (requestPath) => {
      if (requestPath === '/api/patients') {
        const n = nextPatientId += 1;
        const created = await hip.create('Patient', { resourceType: 'Patient', name: [{ family: 'Schneider', given: ['Maria'] }] });
        return { patient: { id: `forms-patient-${n}`, ehrId: `ehr-${n}`, fhirPatientId: created.id } };
      }
      if (requestPath === '/api/composition-sessions') return { id: `comp-session-${nextSessionId += 1}` };
      if (requestPath === '/api/form-sessions') return { id: `form-session-${nextSessionId += 1}` };
      if (requestPath.endsWith('/provider/submit')) return { providerReference: `provider-ref-${nextSessionId}` };
      throw new Error(`unexpected POST ${requestPath}`);
    },
    put: async () => ({}),
  };
}

test('buildJourneyGraph reflects the real, full LAE scenario run as nodes + real reference edges', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const api = fakeApi(hip);
  const runDeps = { ...deps, hip, api };
  const clinicDeps = { ...world.clinicDeps, hip, api };

  await runScenario('run-1', runDeps, clinicDeps, scenario, deps.progressStore);

  const graph = await buildJourneyGraph(runDeps, clinicDeps);

  const nodeIds = graph.nodes.map((n) => n.id);
  assert.ok(nodeIds.includes('patient-maria'));
  assert.ok(nodeIds.includes('encounter-arrival'));
  assert.ok(nodeIds.includes('service-ct-imaging'));
  assert.ok(nodeIds.includes('schedule-ct-today'));
  assert.ok(nodeIds.includes('slot-ctpa-request'));
  assert.ok(nodeIds.includes('appointment-ctpa-request'));
  assert.ok(nodeIds.includes('capability:anamnesis'));
  assert.ok(nodeIds.includes('capability:vital-signs'));

  const patientNode = graph.nodes.find((n) => n.id === 'patient-maria');
  assert.equal(patientNode.kind, 'patient');
  assert.equal(patientNode.label, 'Maria Schneider');

  const serviceNode = graph.nodes.find((n) => n.id === 'service-ct-imaging');
  assert.equal(serviceNode.shared, true, 'clinic-level entities must be flagged shared');
  const encounterNode = graph.nodes.find((n) => n.id === 'encounter-arrival');
  assert.equal(encounterNode.shared, false, 'a run-owned entity must not be flagged shared');

  const hasEdge = (from, to) => graph.edges.some((e) => e.from === from && e.to === to);
  assert.ok(hasEdge('encounter-arrival', 'patient-maria'), 'Encounter.subject.reference must resolve to the Patient');
  assert.ok(hasEdge('slot-ctpa-request', 'schedule-ct-today'), 'Slot.schedule.reference must resolve to the Schedule');
  assert.ok(hasEdge('schedule-ct-today', 'service-ct-imaging'), 'Schedule.actor.0.reference must resolve to the HealthcareService');
  assert.ok(hasEdge('appointment-ctpa-request', 'patient-maria'), 'Appointment.participant.0.actor.reference must resolve to the Patient');
  assert.ok(hasEdge('appointment-ctpa-request', 'slot-ctpa-request'), 'Appointment.slot.0.reference must resolve to the Slot');
  assert.ok(hasEdge('patient-maria', 'capability:anamnesis'), 'the anamnesis capability must be linked to its patient');
});

test('buildClinicGraph hangs two different runs of the SAME scenario off the one shared clinic without id collisions', async () => {
  const world = testWorld();
  const hip = fakeHip();

  const runOneDeps = { ...world.depsFor('run-1'), hip, api: fakeApi(hip) };
  const clinicForRunOne = { ...world.clinicDeps, hip, api: fakeApi(hip) };
  await runScenario('run-1', runOneDeps, clinicForRunOne, scenario, runOneDeps.progressStore);

  const runTwoDeps = { ...world.depsFor('run-2'), hip, api: fakeApi(hip) };
  const clinicForRunTwo = { ...world.clinicDeps, hip, api: fakeApi(hip) };
  await runScenario('run-2', runTwoDeps, clinicForRunTwo, scenario, runTwoDeps.progressStore);

  const clinicDeps = { ...world.clinicDeps, hip, api: fakeApi(hip) };
  const graph = await buildClinicGraph(clinicDeps, [
    { scenarioRunId: 'run-1', deps: runOneDeps, eventsCompleted: 4, eventsTotal: 4 },
    { scenarioRunId: 'run-2', deps: runTwoDeps, eventsCompleted: 4, eventsTotal: 4 },
  ]);

  const patientNodes = graph.nodes.filter((n) => n.kind === 'patient');
  assert.equal(patientNodes.length, 2, 'both runs use the scenario-fixed scenarioKey "patient-maria" - the clinic graph must still produce two distinct nodes');
  assert.notEqual(patientNodes[0].id, patientNodes[1].id, 'patient node ids must be namespaced by scenarioRunId in the clinic-wide graph');
  assert.deepEqual(new Set(patientNodes.map((n) => n.scenarioRunId)), new Set(['run-1', 'run-2']));
  patientNodes.forEach((n) => assert.equal(n.label, 'Maria Schneider'));

  // Only ONE HealthcareService node - both patients' edges point at the
  // exact same shared clinic entity, not one each.
  const serviceNodes = graph.nodes.filter((n) => n.resourceType === 'HealthcareService');
  assert.equal(serviceNodes.length, 1);
  const serviceId = serviceNodes[0].id;
  assert.ok(serviceNodes[0].shared);

  patientNodes.forEach((patientNode) => {
    assert.ok(
      graph.edges.some((e) => e.from === patientNode.id && e.to === serviceId),
      `patient node ${patientNode.id} must have an edge to the shared HealthcareService`,
    );
  });

  // The local (non-FHIR) ward roster is shared - one "location-radiologie"
  // node, not one per run.
  const locationNodes = graph.nodes.filter((n) => n.kind === 'location');
  assert.deepEqual(new Set(locationNodes.map((n) => n.id)), new Set(['location-notaufnahme', 'location-radiologie']));
  locationNodes.forEach((n) => assert.equal(n.shared, true));

  // Each patient currently sits at Radiologie (the scenario's last real
  // transfer) - one "aktuell" edge per patient, to the SAME shared node.
  const radiologie = locationNodes.find((n) => n.id === 'location-radiologie').id;
  patientNodes.forEach((patientNode) => {
    assert.ok(graph.edges.some((e) => e.from === patientNode.id && e.to === radiologie && e.label === 'aktuell'));
  });

  // The full, real, timestamped movement history for BOTH patients is
  // present, in chronological order, and never mixed up between the two.
  assert.equal(graph.movements.length, 4, '2 transfers each, for 2 patients');
  for (let i = 1; i < graph.movements.length; i += 1) {
    assert.ok(graph.movements[i - 1].timestamp <= graph.movements[i].timestamp, 'movements must be sorted oldest first');
  }
  patientNodes.forEach((patientNode) => {
    const own = graph.movements.filter((m) => m.patientNodeId === patientNode.id);
    assert.deepEqual(own.map((m) => m.locationScenarioKey), ['location-notaufnahme', 'location-radiologie']);
  });

  // Station-centric ask: each Station has real staff (a Practitioner FHIR
  // node, shared - not one per patient) hanging directly off it, and its
  // own card shows real load data, not just a bare name.
  const practitionerNodes = graph.nodes.filter((n) => n.resourceType === 'Practitioner');
  assert.equal(practitionerNodes.length, 2, 'one shared Practitioner per station, not one per patient');
  practitionerNodes.forEach((p) => assert.ok(p.shared));
  locationNodes.forEach((location) => {
    assert.ok(
      graph.edges.some((e) => e.id.startsWith('staff-edge:') && e.from === location.id),
      `station ${location.id} must have at least one staff edge`,
    );
  });
  const radiologieNode = locationNodes.find((n) => n.id === 'location-radiologie');
  assert.ok(radiologieNode.details.some((d) => d.includes('Mitarbeitende')), 'a station detail row must report staff/patient counts');
  assert.ok(radiologieNode.details.some((d) => d.includes('2 Patient')), 'both patients ended up at Radiologie - the station must report 2 current patients');
});
