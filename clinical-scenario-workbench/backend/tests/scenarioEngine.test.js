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
const { DynamicCapabilityRegistry } = require('../dist/capability/dynamicRegistry');
const { DynamicEventsStore } = require('../dist/scenario/dynamicEvents');
const { executeNextEvent, runScenario } = require('../dist/scenario/engine');

const blueprintsDir = path.join(__dirname, '..', 'src', 'fhir', 'blueprints');

// Matches context.ts's own CLINIC_NAMESPACE constant - not imported here so
// these tests stay independent of the full WorkbenchContext (which needs a
// real .env/config), same reasoning as fakeHip/fakeApi below.
const CLINIC_NAMESPACE = '_clinic';

function scenarioFor(id = 'test-scenario') {
  return {
    scenarioId: id,
    patient: { key: 'patient-maria', firstName: 'Maria', lastName: 'Schneider', sex: 'female', age: 67 },
    events: [
      { id: 'arrival', type: 'patient-arrival', at: '0m' },
      { id: 'anamnesis', type: 'anamnesis', at: '5m', data: { diagnosis: 'Verdacht auf Lungenembolie' } },
      { id: 'vitals', type: 'vital-signs', at: '10m', data: { heartRate: 108, spo2: 91 } },
      { id: 'ctpa-request', type: 'request-imaging', at: '15m', data: { service: 'ct-pulmonary-angiography' } },
    ],
  };
}
const scenario = scenarioFor();

/** Mirrors the real WorkbenchContext (context.ts): one shared, global
 * ResourceFormStore (`forms`), one dataDir several runs (and the shared
 * "clinic" pseudo-run) all live under - so these tests exercise the exact
 * same sharing shape production code does. */
function testWorld() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csw-engine-'));
  const blueprints = new BlueprintLoader(blueprintsDir);
  const forms = new ResourceFormStore(dataDir, CLINIC_NAMESPACE, blueprints);
  const locations = new LocalLocationRegistry(dataDir, CLINIC_NAMESPACE);
  const dynamicCapabilities = new DynamicCapabilityRegistry(dataDir, CLINIC_NAMESPACE);
  const depsFor = (scenarioRunId) => ({
    dataDir,
    blueprints,
    forms,
    locations,
    dynamicCapabilities,
    registry: new EntityRegistry(dataDir, scenarioRunId),
    capabilities: new CapabilityRegistry(dataDir, scenarioRunId),
    locationLog: new LocationLog(dataDir, scenarioRunId),
    tasks: new TaskStore(dataDir, scenarioRunId),
    entityStatus: new EntityStatusStore(dataDir, scenarioRunId),
    pendingTasks: new PendingTaskStore(dataDir, scenarioRunId),
    dynamicEvents: new DynamicEventsStore(dataDir, scenarioRunId),
    activity: new ActivityLog(dataDir, scenarioRunId),
    progressStore: new ScenarioProgressStore(dataDir, scenarioRunId, scenario.scenarioId),
    generatedValues: new GeneratedValuesStore(dataDir, scenarioRunId),
  });
  return { dataDir, depsFor, clinicDeps: depsFor(CLINIC_NAMESPACE) };
}

/** Mirrors tests/planner.test.js's own fakeHip - a generic in-memory FHIR
 * CDR stand-in good enough for the engine's own orchestration logic. Shared
 * across runs (passed the same instance) since it stands in for the one
 * real HIP every run actually writes to. */
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
    // Location via updateFhirResourceEntity - needs a real (if minimal)
    // update to work against this fake store.
    async update(resourceType, id, resource) {
      const stored = { ...resource, id, meta: { versionId: '2' } };
      store.set(`${resourceType}/${id}`, stored);
      return stored;
    },
    async search() { throw new Error('not used in these tests'); },
  };
}

/** A minimal fake of the Forms API surface agent/patientBridge.ts and
 * openehr/capabilityBridge.ts call directly. */
function fakeApi() {
  const calls = [];
  let nextSessionId = 1;
  let nextPatientId = 1;
  return {
    calls,
    post: async (requestPath, body) => {
      calls.push({ path: requestPath, body });
      if (requestPath === '/api/patients') {
        const n = nextPatientId += 1;
        return { patient: { id: `forms-patient-${n}`, ehrId: `ehr-${n}`, fhirPatientId: `fhir-patient-${n}` } };
      }
      if (requestPath === '/api/composition-sessions') return { id: `comp-session-${nextSessionId += 1}` };
      if (requestPath === '/api/form-sessions') return { id: `form-session-${nextSessionId += 1}` };
      if (requestPath.endsWith('/provider/submit')) return { providerReference: `provider-ref-${nextSessionId}` };
      throw new Error(`unexpected POST ${requestPath}`);
    },
    put: async (requestPath, body) => { calls.push({ path: requestPath, body }); return {}; },
  };
}

test('executeNextEvent runs exactly one event per call, in scenario order, and marks progress', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const runDeps = { ...deps, hip, api: fakeApi() };
  const clinicDeps = { ...world.clinicDeps, hip, api: fakeApi() };

  const first = await executeNextEvent('run-1', runDeps, clinicDeps, scenario, deps.progressStore);
  assert.equal(first.event.id, 'arrival');
  assert.equal(first.finished, false);
  assert.deepEqual(deps.progressStore.get().completedEventIds, ['arrival']);
  assert.ok(deps.registry.get('patient-maria'), 'the patient must be registered after patient-arrival');
  assert.ok(deps.registry.get('encounter-arrival'), 'the encounter must be registered after patient-arrival');

  const second = await executeNextEvent('run-1', runDeps, clinicDeps, scenario, deps.progressStore);
  assert.equal(second.event.id, 'anamnesis');
  assert.deepEqual(deps.progressStore.get().completedEventIds, ['arrival', 'anamnesis']);
  assert.ok(deps.capabilities.get('anamnesis'), 'the anamnesis capability must be registered');
});

test('runScenario with no maxEvents runs the entire scenario to completion, in order, exactly once each', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const runDeps = { ...deps, hip, api: fakeApi() };
  const clinicDeps = { ...world.clinicDeps, hip, api: fakeApi() };

  const executed = await runScenario('run-1', runDeps, clinicDeps, scenario, deps.progressStore);

  assert.deepEqual(executed.map((event) => event.id), ['arrival', 'anamnesis', 'vitals', 'ctpa-request']);
  assert.deepEqual(deps.progressStore.get().completedEventIds, ['arrival', 'anamnesis', 'vitals', 'ctpa-request']);

  // The full CT-imaging chain must exist, correctly referencing the patient.
  const appointment = deps.registry.get('appointment-ctpa-request');
  assert.ok(appointment);
  assert.ok(deps.capabilities.get('ct-imaging'));
  assert.ok(deps.capabilities.get('vital-signs'));
  // HealthcareService/Schedule are clinic-level, not run-level.
  assert.equal(deps.registry.get('service-ct-imaging'), undefined);
  assert.ok(world.clinicDeps.registry.get('service-ct-imaging'), 'the HealthcareService must be in the shared clinic registry');
  assert.ok(world.clinicDeps.registry.get('schedule-ct-today'), 'the Schedule must be in the shared clinic registry');

  // A further call is a genuine no-op - the scenario is already finished.
  const afterEnd = await executeNextEvent('run-1', runDeps, clinicDeps, scenario, deps.progressStore);
  assert.equal(afterEnd.event, null);
  assert.equal(afterEnd.finished, true);

  // Visual-sim groundwork: with nothing left queued, the patient's own
  // entity status is "thinking" (waiting on the next live decision), not
  // stuck at whatever the last real dispatch left it as.
  assert.equal(deps.entityStatus.get('patient-maria').status, 'thinking');
});

test('runScenario with maxEvents stops after that many events, leaving the rest for a later call (Step semantics)', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const runDeps = { ...deps, hip, api: fakeApi() };
  const clinicDeps = { ...world.clinicDeps, hip, api: fakeApi() };

  const executed = await runScenario('run-1', runDeps, clinicDeps, scenario, deps.progressStore, 2);
  assert.deepEqual(executed.map((event) => event.id), ['arrival', 'anamnesis']);
  assert.equal(world.clinicDeps.registry.get('service-ct-imaging'), undefined, 'the imaging chain must not have run yet');
});

test('vital-signs event maps scenario data (heartRate/spo2) onto the real Vitalzeichen field ids', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const api = fakeApi();
  const runDeps = { ...deps, hip, api };
  const clinicDeps = { ...world.clinicDeps, hip, api };
  await runScenario('run-1', runDeps, clinicDeps, scenario, deps.progressStore, 3);

  const vitalsFormSessionCall = api.calls.find((c) => c.path === '/api/form-sessions' && c.body.values.hr_rate);
  assert.deepEqual(vitalsFormSessionCall.body.values.hr_rate, { magnitude: 108, unit: '/min' });
  assert.deepEqual(vitalsFormSessionCall.body.values.spo2_value, { numerator: 91 });
});

test('vital-signs maps systolic/diastolic onto the real bp_systolic/bp_diastolic fields, and derives MAP/pulse pressure - found live building the severe-preeclampsia case, where blood pressure is the defining vital sign', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const api = fakeApi();
  const runDeps = { ...deps, hip, api };
  const clinicDeps = { ...world.clinicDeps, hip, api };
  const bpScenario = {
    ...scenarioFor(),
    events: [
      { id: 'arrival', type: 'patient-arrival', at: '0m' },
      { id: 'vitals', type: 'vital-signs', at: '5m', data: { systolic: 162, diastolic: 108 } },
    ],
  };
  await runScenario('run-1', runDeps, clinicDeps, bpScenario, deps.progressStore);

  const vitalsFormSessionCall = api.calls.find((c) => c.path === '/api/form-sessions' && c.body.values.bp_systolic);
  assert.deepEqual(vitalsFormSessionCall.body.values.bp_systolic, { magnitude: 162, unit: 'mm[Hg]' });
  assert.deepEqual(vitalsFormSessionCall.body.values.bp_diastolic, { magnitude: 108, unit: 'mm[Hg]' });
  assert.deepEqual(vitalsFormSessionCall.body.values.bp_map, { magnitude: 126, unit: 'mm[Hg]' }); // 108 + (162-108)/3 = 126
  assert.deepEqual(vitalsFormSessionCall.body.values.bp_pulse_pressure, { magnitude: 54, unit: 'mm[Hg]' });
});

test('generatedValues overrides win over the engine\'s own deterministic defaults for request-imaging', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const api = fakeApi();
  const runDeps = { ...deps, hip, api };
  const clinicDeps = { ...world.clinicDeps, hip, api };

  deps.generatedValues.set('ctpa-request', {
    healthcareServiceName: 'Radiologisches Zentrum Ost',
    slotStart: '2026-09-15T15:30:00.000Z',
    slotEnd: '2026-09-15T16:00:00.000Z',
    appointmentComment: 'Dringende CTPA laut Dr. Weber',
  });

  await runScenario('run-1', runDeps, clinicDeps, scenario, deps.progressStore);

  const service = world.clinicDeps.registry.get('service-ct-imaging');
  const serviceResource = await hip.get('HealthcareService', service.hipResourceId);
  assert.equal(serviceResource.name, 'Radiologisches Zentrum Ost');

  const appointment = deps.registry.get('appointment-ctpa-request');
  const appointmentResource = await hip.get('Appointment', appointment.hipResourceId);
  assert.equal(appointmentResource.start, '2026-09-15T15:30:00.000Z');
  assert.equal(appointmentResource.end, '2026-09-15T16:00:00.000Z');
  assert.equal(appointmentResource.comment, 'Dringende CTPA laut Dr. Weber');
});

test('a second scenario run reuses the SAME clinic HealthcareService/Schedule instead of creating new ones', async () => {
  const world = testWorld();
  const hip = fakeHip();

  const runOneDeps = world.depsFor('run-1');
  const clinicDepsForRunOne = { ...world.clinicDeps, hip, api: fakeApi() };
  await runScenario('run-1', { ...runOneDeps, hip, api: fakeApi() }, clinicDepsForRunOne, scenarioFor('scenario-a'), runOneDeps.progressStore);

  const runTwoDeps = world.depsFor('run-2');
  const clinicDepsForRunTwo = { ...world.clinicDeps, hip, api: fakeApi() };
  await runScenario('run-2', { ...runTwoDeps, hip, api: fakeApi() }, clinicDepsForRunTwo, scenarioFor('scenario-b'), runTwoDeps.progressStore);

  const service = world.clinicDeps.registry.get('service-ct-imaging');
  const schedule = world.clinicDeps.registry.get('schedule-ct-today');
  assert.ok(service);
  assert.ok(schedule);

  // Each run still got its OWN Slot/Appointment (patient-specific), but
  // both reference the one shared Schedule/HealthcareService.
  const slotOne = runOneDeps.registry.get('slot-ctpa-request');
  const slotTwo = runTwoDeps.registry.get('slot-ctpa-request');
  assert.ok(slotOne);
  assert.ok(slotTwo);
  assert.notEqual(slotOne.hipResourceId, slotTwo.hipResourceId, 'each run must get its own Slot, not share one');

  // Only ONE HealthcareService/Schedule ever exist across both runs - not two.
  const allServiceEntities = [...runOneDeps.registry.list(), ...runTwoDeps.registry.list()].filter((e) => e.resourceType === 'HealthcareService');
  assert.equal(allServiceEntities.length, 0, 'HealthcareService must never be registered in a per-run registry');
});

test('the patient physically moves through the clinic - a local (non-FHIR) transfer log records the real move to Notaufnahme, then Radiologie', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const runDeps = { ...deps, hip, api: fakeApi() };
  const clinicDeps = { ...world.clinicDeps, hip, api: fakeApi() };

  // After just patient-arrival: the shared (local, not FHIR) Notaufnahme
  // ward must exist, and this patient's own transfer log must show it.
  await executeNextEvent('run-1', runDeps, clinicDeps, scenario, deps.progressStore);
  const notaufnahme = world.clinicDeps.locations.get('location-notaufnahme');
  assert.ok(notaufnahme, 'the Notaufnahme ward must be ensured on the shared clinic, locally');
  assert.equal(notaufnahme.name, 'Notaufnahme');
  assert.equal(deps.locationLog.current().locationScenarioKey, 'location-notaufnahme');
  assert.equal(deps.locationLog.current().eventId, 'arrival');

  // Run the rest of the scenario - request-imaging must transfer the same
  // patient to Radiologie, appending a SECOND log entry, not replacing the
  // first (the "asOf" time-scrubber needs the full history).
  await runScenario('run-1', runDeps, clinicDeps, scenario, deps.progressStore);
  const radiologie = world.clinicDeps.locations.get('location-radiologie');
  assert.ok(radiologie, 'the Radiologie ward must be ensured on the shared clinic, locally');
  const log = deps.locationLog.list();
  assert.equal(log.length, 2);
  assert.equal(log[0].locationScenarioKey, 'location-notaufnahme');
  assert.equal(log[1].locationScenarioKey, 'location-radiologie');
  assert.equal(log[1].eventId, 'ctpa-request');

  // asOf lookups must reflect the real chronology: before the first
  // transfer -> nothing yet; between the two -> Notaufnahme; after both ->
  // Radiologie.
  assert.equal(deps.locationLog.asOf(new Date(0).toISOString()), undefined);
  assert.equal(deps.locationLog.asOf(log[0].timestamp).locationScenarioKey, 'location-notaufnahme');
  assert.equal(deps.locationLog.asOf(log[1].timestamp).locationScenarioKey, 'location-radiologie');

  // The real Encounter resource on HIP is untouched by any of this - no
  // fabricated FHIR reference to a Location the tenant can't create.
  const encounter = deps.registry.get('encounter-arrival');
  const encounterResource = await hip.get('Encounter', encounter.hipResourceId);
  assert.equal(encounterResource.location, undefined);
});

// Regression: dynamicEvents.ts lets a scenario's own event list grow AFTER
// some events already completed (the "eigener Agent als Arzt" open-ended
// case). Live-discovered bug: the critic's own "at discharge" findings
// (missing-discharge-letter/...) got permanently recorded as true the
// moment they were first checked against whatever was the scenario's own
// LAST event at that point - even once a real, later discharge-letter
// event closed the gap, the stale Task never got corrected. Fixed by
// recomputing the whole critique fresh every step and reconciling
// (TaskStore.resolveStale) rather than a write-once check.
test('a critic finding that was true when its anchor was still the scenario\'s own last event gets resolved once a later event actually closes the gap', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const runDeps = { ...deps, hip, api: fakeApi() };
  const clinicDeps = { ...world.clinicDeps, hip, api: fakeApi() };

  const shortScenario = scenarioFor('open-case');
  shortScenario.events = [
    { id: 'arrival', type: 'patient-arrival', at: '0m' },
    { id: 'chief-complaint', type: 'anamnesis', at: '5m', data: { diagnosis: 'unklare Bauchschmerzen' } },
  ];
  await runScenario('run-1', runDeps, clinicDeps, shortScenario, deps.progressStore);

  const staleTask = deps.tasks.list().find((t) => t.code === 'missing-discharge-letter');
  assert.ok(staleTask, '"chief-complaint" was genuinely the scenario\'s own last event at this point - the finding is correct here');
  assert.equal(staleTask.status, 'open');
  assert.equal(staleTask.anchorEventId, 'chief-complaint');

  // The "doctor" appends a real discharge-letter event after the fact -
  // dynamicEvents.ts's own mechanism, simulated here by just growing the
  // same scenario object and calling executeNextEvent again.
  const longScenario = { ...shortScenario, events: [...shortScenario.events, { id: 'letter', type: 'discharge-letter', at: '1h', data: { synopsis: 'x' } }] };
  await executeNextEvent('run-1', runDeps, clinicDeps, longScenario, deps.progressStore);

  const resolvedTask = deps.tasks.list().find((t) => t.code === 'missing-discharge-letter');
  assert.equal(resolvedTask.status, 'resolved', 'a real discharge-letter event now exists - the earlier finding no longer reflects reality');
  assert.ok(resolvedTask.resolvedAt);
});

test('a ward-transfer completing sets entity status to "thinking" (handover - start from zero), not the generic "idle"', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const runDeps = { ...deps, hip, api: fakeApi() };
  const clinicDeps = { ...world.clinicDeps, hip, api: fakeApi() };
  const transferScenario = {
    ...scenarioFor(),
    events: [
      { id: 'arrival', type: 'patient-arrival', at: '0m' },
      { id: 'transfer', type: 'ward-transfer', at: '1h', data: { location: { key: 'loc-icu', name: 'ICU' } } },
    ],
  };

  // Stepped one event at a time (not runScenario/Play) so the assertion
  // below observes the state right after the transfer's OWN step - Playing
  // straight through would immediately overwrite it with the (also true,
  // but differently-worded) "no more events queued" thinking status from
  // the very next step.
  await executeNextEvent('run-1', runDeps, clinicDeps, transferScenario, deps.progressStore); // arrival
  await executeNextEvent('run-1', runDeps, clinicDeps, transferScenario, deps.progressStore); // transfer

  const status = deps.entityStatus.get('patient-maria');
  assert.equal(status.status, 'thinking');
  assert.match(status.reason, /bei null/);
  const handoffActivity = deps.activity.list().find((entry) => entry.action === 'thinking' && entry.tool === 'ward-transfer');
  assert.ok(handoffActivity, 'the handover pause must be a real, queryable Activity entry, not just a status flag');
});

test('a patient-conversation event logs a real "conversation" Activity entry, and folds newInfoLearned into the anamnesis capability', async () => {
  const world = testWorld();
  world.clinicDeps.dynamicCapabilities.register('progress-note', {
    role: 'basis', compositionFormId: 'comp-progress-note', blockId: 'block-1', formSectionFormId: 'form-progress-note', forceNewComposition: true,
  });
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const runDeps = { ...deps, hip, api: fakeApi() };
  const clinicDeps = { ...world.clinicDeps, hip, api: fakeApi() };
  const conversationScenario = {
    ...scenarioFor(),
    events: [
      { id: 'arrival', type: 'patient-arrival', at: '0m' },
      {
        id: 'talk', type: 'patient-conversation', at: '5m',
        data: { topic: 'Symptome', question: 'Seit wann bestehen die Schmerzen?', patientSays: 'Seit gestern Abend, plötzlich.', newInfoLearned: 'Akuter Beginn der Schmerzen seit gestern Abend.' },
      },
    ],
  };

  await runScenario('run-1', runDeps, clinicDeps, conversationScenario, deps.progressStore);

  const conversationEntry = deps.activity.list().find((entry) => entry.action === 'conversation');
  assert.ok(conversationEntry, 'a real conversation must produce its own Activity entry');
  assert.match(conversationEntry.message, /Seit gestern Abend/);
  assert.ok(deps.capabilities.get('anamnesis'), 'newInfoLearned must actually be written through the real anamnesis capability, not just logged');
  assert.ok(deps.capabilities.get('progress-note'), 'every conversation must ALSO land as a real Verlaufsnotiz entry, not just the internal ActivityLog');
});

test('a medication-order with pendingResult only writes medication-administration once a LATER nursing-round executes it - not at order time', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const api = fakeApi();
  const runDeps = { ...deps, hip, api };
  const clinicDeps = { ...world.clinicDeps, hip, api };
  const orderScenario = {
    ...scenarioFor(),
    events: [
      { id: 'arrival', type: 'patient-arrival', at: '0m' },
      {
        id: 'order', type: 'medication-order', at: '10m',
        data: {
          medicationName: 'Nifedipin retard 20mg', doseAndTiming: '20mg oral', route: 'oral',
          pendingResult: {
            kind: 'medication-administration', description: 'Nifedipin verabreichen',
            payload: { arzneimittel: 'Nifedipin retard 20mg', dosisbeschreibung: '20mg oral', verabreichungsweg: 'oral' },
          },
        },
      },
      { id: 'round', type: 'nursing-round', at: '30m', data: {} },
    ],
  };

  await executeNextEvent('run-1', runDeps, clinicDeps, orderScenario, deps.progressStore); // arrival
  await executeNextEvent('run-1', runDeps, clinicDeps, orderScenario, deps.progressStore); // order

  const medicationField = 'vg_medicationadministration.v1.0.2_arzneimittel';
  assert.equal(deps.pendingTasks.listPending('patient-maria').length, 1, 'the order must file a real pending task');
  assert.ok(!api.calls.some((c) => c.path === '/api/form-sessions' && c.body.values[medicationField]), 'medication-administration must NOT be written yet - nursing has not come');

  await executeNextEvent('run-1', runDeps, clinicDeps, orderScenario, deps.progressStore); // nursing-round

  assert.equal(deps.pendingTasks.listPending('patient-maria').length, 0, 'nursing-round must have consumed the pending task');
  const administrationCall = api.calls.find((c) => c.path === '/api/form-sessions' && c.body.values[medicationField]);
  assert.ok(administrationCall, 'nursing-round must have actually executed the order for real');
  assert.equal(administrationCall.body.values[medicationField], 'Nifedipin retard 20mg');

  // Regression for the real bug found live playing the appendicitis case:
  // executePendingTasks makes its synthetic execution event a real member
  // of scenario.events (via dynamicEvents.append) so the critic can see it
  // - but a scenario RELOAD (loader.ts's loadScenarioForRun) is exactly
  // when that becomes visible as a genuine, not-yet-completed event in
  // scenario.events. Without also marking it completed in progressStore
  // at the moment it's created, the very next executeNextEvent call after
  // a reload would find it "unclaimed" and execute (and re-submit!) the
  // same medication administration a second time.
  const reloadedEvents = [...orderScenario.events, ...deps.dynamicEvents.list()];
  const reloadedScenario = { ...orderScenario, events: reloadedEvents };
  const before = api.calls.length;
  const result = await executeNextEvent('run-1', runDeps, clinicDeps, reloadedScenario, deps.progressStore);
  assert.equal(result.finished, true, 'every event, including the synthetic one, must already be marked completed after a reload');
  assert.equal(api.calls.length, before, 'no new API call must happen - the synthetic execution must not run twice');
});

test('doctor-round reflects a real completed result in its own note instead of the canned fallback text, and marks it reviewed exactly once', async () => {
  const world = testWorld();
  const deps = world.depsFor('run-1');
  const hip = fakeHip();
  const api = fakeApi();
  const runDeps = { ...deps, hip, api };
  const clinicDeps = { ...world.clinicDeps, hip, api };
  const roundScenario = {
    ...scenarioFor(),
    events: [
      { id: 'arrival', type: 'patient-arrival', at: '0m' },
      {
        id: 'order', type: 'order-basis', at: '10m',
        data: {
          serviceName: '24h-Sammelurin auf Protein',
          pendingResult: { kind: 'lab-value', payload: { analyteName: 'Hämoglobin', value: 10.8, unit: 'g/dL', interpretation: 'L' } },
        },
      },
      { id: 'nursing', type: 'nursing-round', at: '30m', data: {} },
      { id: 'doctor', type: 'doctor-round', at: '1h', data: {} },
      { id: 'doctor-2', type: 'doctor-round', at: '2h', data: {} },
    ],
  };

  await runScenario('run-1', runDeps, clinicDeps, roundScenario, deps.progressStore);

  const doctorRoundCalls = api.calls.filter((c) => c.path === '/api/form-sessions' && c.body.values['vg_servicerequest.v1.1.1_service_name'] === 'Verlaufskontrolle');
  assert.equal(doctorRoundCalls.length, 2);
  assert.match(doctorRoundCalls[0].body.values['vg_servicerequest.v1.1.1_comment'], /Hämoglobin.*10\.8.*Niedrig/, 'the FIRST doctor-round must quote the real result, not the canned fallback');
  assert.equal(doctorRoundCalls[1].body.values['vg_servicerequest.v1.1.1_comment'], 'Weiter nach Standardprotokoll.', 'the SECOND doctor-round has nothing new to review - falls back to the original canned text, and must not re-quote the same result again');
});
