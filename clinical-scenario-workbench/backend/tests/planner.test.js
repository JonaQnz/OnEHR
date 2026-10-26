const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BlueprintLoader } = require('../dist/fhir/blueprint');
const { ResourceFormStore } = require('../dist/fhir/resourceFormStore');
const { EntityRegistry } = require('../dist/entity/registry');
const { ActivityLog } = require('../dist/activity/log');
const { ensureFhirResource, updateFhirResourceEntity, PlannerValidationError } = require('../dist/agent/planner');

const blueprintsDir = path.join(__dirname, '..', 'src', 'fhir', 'blueprints');

function tempDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csw-planner-'));
  const scenarioRunId = 'run-1';
  const blueprints = new BlueprintLoader(blueprintsDir);
  const forms = new ResourceFormStore(dataDir, scenarioRunId, blueprints);
  const registry = new EntityRegistry(dataDir, scenarioRunId);
  const activity = new ActivityLog(dataDir, scenarioRunId);
  return { dataDir, scenarioRunId, blueprints, forms, registry, activity };
}

/** Records every call and simulates a real FHIR CDR's create/get/update
 * behavior closely enough for the planner's own logic to be tested without a
 * live HIP - assigns an id on create, serves it back on get, applies a PUT
 * in place on update. */
function fakeHip() {
  const store = new Map();
  let nextId = 1;
  return {
    calls: [],
    async create(resourceType, resource) {
      const id = String(nextId += 1);
      const stored = { ...resource, id, meta: { versionId: '1' } };
      store.set(`${resourceType}/${id}`, stored);
      this.calls.push({ op: 'create', resourceType, resource });
      return stored;
    },
    async get(resourceType, id) {
      this.calls.push({ op: 'get', resourceType, id });
      const found = store.get(`${resourceType}/${id}`);
      if (!found) throw new Error(`not found: ${resourceType}/${id}`);
      return found;
    },
    async update(resourceType, id, resource) {
      const previous = store.get(`${resourceType}/${id}`);
      const nextVersion = String(Number(previous?.meta?.versionId ?? '0') + 1);
      const stored = { ...resource, id, meta: { versionId: nextVersion } };
      store.set(`${resourceType}/${id}`, stored);
      this.calls.push({ op: 'update', resourceType, id, resource });
      return stored;
    },
    async search() { throw new Error('not used in these tests'); },
  };
}

const validPatientValues = {
  'name.0.family': 'Schneider',
  'name.0.given.0': 'Maria',
  gender: 'female',
  birthDate: '1959-03-01',
};

test('ensureFhirResource creates, reads back, and registers a new entity with per-field provenance', async () => {
  const deps = tempDeps();
  const hip = fakeHip();
  const result = await ensureFhirResource({ ...deps, hip }, {
    resourceType: 'Patient', scenarioKey: 'patient-maria', values: validPatientValues, provenance: 'SOURCE',
  });

  assert.equal(result.created, true);
  assert.equal(result.entity.resourceType, 'Patient');
  assert.equal(result.entity.provenance, 'SOURCE');
  assert.equal(result.entity.fieldProvenance['name.0.family'], 'SOURCE');
  assert.equal(result.resource.name[0].family, 'Schneider');
  assert.deepEqual(hip.calls.map((c) => c.op), ['create', 'get']);

  const activity = deps.activity.list();
  assert.equal(activity.length, 1);
  assert.equal(activity[0].result, 'success');
});

test('ensureFhirResource is idempotent - calling it again for the same scenario key never creates a duplicate', async () => {
  const deps = tempDeps();
  const hip = fakeHip();
  const first = await ensureFhirResource({ ...deps, hip }, { resourceType: 'Patient', scenarioKey: 'patient-maria', values: validPatientValues, provenance: 'SOURCE' });
  const second = await ensureFhirResource({ ...deps, hip }, { resourceType: 'Patient', scenarioKey: 'patient-maria', values: validPatientValues, provenance: 'SOURCE' });

  assert.equal(second.created, false);
  assert.equal(second.entity.hipResourceId, first.entity.hipResourceId);
  assert.deepEqual(hip.calls.map((c) => c.op), ['create', 'get', 'get']);
});

test('ensureFhirResource refuses to write when a simulationRequired field is missing, and logs the failure', async () => {
  const deps = tempDeps();
  const hip = fakeHip();
  await assert.rejects(
    () => ensureFhirResource({ ...deps, hip }, { resourceType: 'Patient', scenarioKey: 'patient-maria', values: { 'name.0.family': 'Schneider' }, provenance: 'SOURCE' }),
    PlannerValidationError,
  );
  assert.equal(hip.calls.length, 0, 'no HIP call should happen when validation fails');
  const activity = deps.activity.list();
  assert.equal(activity.length, 1);
  assert.equal(activity[0].result, 'error');
});

test('ensureFhirResource creating a form for the first time registers a v1 FhirResourceForm', async () => {
  const deps = tempDeps();
  assert.equal(deps.forms.getByResourceType('Patient'), undefined);
  await ensureFhirResource({ ...deps, hip: fakeHip() }, { resourceType: 'Patient', scenarioKey: 'patient-maria', values: validPatientValues, provenance: 'SOURCE' });
  const form = deps.forms.getByResourceType('Patient');
  assert.equal(form.version, 1);
  assert.equal(form.fields.length, 4);
});

test('updateFhirResourceEntity applies a USER edit and re-reads the merged resource from HIP', async () => {
  const deps = tempDeps();
  const hip = fakeHip();
  await ensureFhirResource({ ...deps, hip }, { resourceType: 'Patient', scenarioKey: 'patient-maria', values: validPatientValues, provenance: 'SOURCE' });

  const result = await updateFhirResourceEntity({ ...deps, hip }, {
    scenarioKey: 'patient-maria', values: { 'name.0.family': 'Schneider-Weber' }, provenance: 'USER',
  });

  assert.deepEqual(result.refused, []);
  assert.equal(result.resource.name[0].family, 'Schneider-Weber');
  assert.equal(deps.registry.get('patient-maria').fieldProvenance['name.0.family'], 'USER');
});

test('updateFhirResourceEntity refuses to let a lower-priority write clobber an already-USER field, while still applying an equal-priority re-derivation to an untouched field', async () => {
  const deps = tempDeps();
  const hip = fakeHip();
  // Every field starts at SOURCE provenance (from the initial scenario-driven creation).
  await ensureFhirResource({ ...deps, hip }, { resourceType: 'Patient', scenarioKey: 'patient-maria', values: validPatientValues, provenance: 'SOURCE' });
  await updateFhirResourceEntity({ ...deps, hip }, { scenarioKey: 'patient-maria', values: { 'name.0.family': 'Schneider-Weber' }, provenance: 'USER' });

  // A GENERATED attempt is refused for BOTH fields here: name.0.family is now
  // USER (strictly higher), and gender is still at its original SOURCE
  // (strictly higher than GENERATED too) - GENERATED may only ever touch a
  // field nothing has claimed at SOURCE-or-above yet.
  const generatedAttempt = await updateFhirResourceEntity({ ...deps, hip }, {
    scenarioKey: 'patient-maria', values: { 'name.0.family': 'Regenerated', gender: 'male' }, provenance: 'GENERATED',
  });
  assert.deepEqual(generatedAttempt.refused, ['name.0.family', 'gender']);
  assert.equal(generatedAttempt.resource.name[0].family, 'Schneider-Weber', 'the USER-set surname must survive a lower-priority write');
  assert.equal(generatedAttempt.resource.gender, 'female', 'the original SOURCE value must survive a lower-priority write too');

  // A same-priority (SOURCE) re-derivation of gender is allowed - equal rank
  // is not a downgrade - but the USER-owned surname is still off-limits to it.
  const sourceAttempt = await updateFhirResourceEntity({ ...deps, hip }, {
    scenarioKey: 'patient-maria', values: { 'name.0.family': 'Rewritten', gender: 'male' }, provenance: 'SOURCE',
  });
  assert.deepEqual(sourceAttempt.refused, ['name.0.family']);
  assert.equal(sourceAttempt.resource.name[0].family, 'Schneider-Weber');
  assert.equal(sourceAttempt.resource.gender, 'male');
});
