const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EntityRegistry } = require('../dist/entity/registry');
const { ActivityLog } = require('../dist/activity/log');
const { ensureScenarioPatient } = require('../dist/agent/patientBridge');

function tempDeps() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csw-patientbridge-'));
  const registry = new EntityRegistry(dataDir, 'run-1');
  const activity = new ActivityLog(dataDir, 'run-1');
  return { dataDir, registry, activity };
}

function fakeApi(response) {
  const calls = [];
  return {
    calls,
    post: async (path, body) => { calls.push({ path, body }); return response; },
  };
}

const input = {
  scenarioKey: 'patient-maria', patientId: 'lae-e2e-maria', firstName: 'Maria', lastName: 'Schneider',
  birthDate: '1959-03-01', gender: 'female', provenance: 'SOURCE',
};

test('ensureScenarioPatient posts to /api/patients with the Person Form field names and registers the ehrId/formsPatientId', async () => {
  const deps = tempDeps();
  const api = fakeApi({ patient: { id: 'forms-1', ehrId: 'ehr-1', fhirPatientId: 'fhir-1' } });
  const result = await ensureScenarioPatient({ ...deps, api }, input);

  assert.equal(result.created, true);
  assert.equal(result.formsPatientId, 'forms-1');
  assert.equal(result.ehrId, 'ehr-1');
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].path, '/api/patients');
  assert.deepEqual(api.calls[0].body.personFormValues['vg_person.v1.1.1_vorname'], ['Maria']);
  assert.equal(api.calls[0].body.personFormValues['vg_person.v1.1.1_familienname'], 'Schneider');

  const entity = deps.registry.get('patient-maria');
  assert.equal(entity.resourceType, 'Patient');
  assert.equal(entity.ehrId, 'ehr-1');
  assert.equal(entity.formsPatientId, 'forms-1');
  assert.equal(entity.hipResourceId, 'fhir-1');
});

test('ensureScenarioPatient is idempotent - a second call for the same scenario key never posts again', async () => {
  const deps = tempDeps();
  const api = fakeApi({ patient: { id: 'forms-1', ehrId: 'ehr-1', fhirPatientId: 'fhir-1' } });
  await ensureScenarioPatient({ ...deps, api }, input);
  const second = await ensureScenarioPatient({ ...deps, api }, input);

  assert.equal(second.created, false);
  assert.equal(second.formsPatientId, 'forms-1');
  assert.equal(api.calls.length, 1, 'no second POST /api/patients call');
});

test('a failed create is logged to Activity as an error and the error propagates', async () => {
  const deps = tempDeps();
  const api = { post: async () => { throw new Error('HIP unreachable'); } };
  await assert.rejects(() => ensureScenarioPatient({ ...deps, api }, input), /HIP unreachable/);
  const activity = deps.activity.list();
  assert.equal(activity.length, 1);
  assert.equal(activity[0].result, 'error');
});

test('falls back to the internal Forms id as hipResourceId when fhirPatientId is absent (non-HIP/ehrbase-mode connections)', async () => {
  const deps = tempDeps();
  const api = fakeApi({ patient: { id: 'forms-1', ehrId: 'ehr-1' } });
  const result = await ensureScenarioPatient({ ...deps, api }, input);
  assert.equal(result.fhirPatientId, undefined);
  assert.equal(deps.registry.get('patient-maria').hipResourceId, 'forms-1');
});
