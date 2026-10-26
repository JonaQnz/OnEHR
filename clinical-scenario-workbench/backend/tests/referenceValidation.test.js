const assert = require('node:assert/strict');
const test = require('node:test');
const { validateReferences } = require('../dist/validation/referenceValidation');

function blueprint(references) {
  return { resourceType: 'Test', simulationRequired: [], recommended: [], references, llmMayGenerate: [], llmMayNotGenerate: [], dependencies: [], mayTrigger: [], fields: [] };
}

function fakeRegistry(entities) {
  return { get: (key) => entities[key] };
}

test('a reference to an unregistered scenario key is reported', () => {
  const issues = validateReferences(blueprint({ patient: { target: ['Patient'] } }), { patient: 'patient-maria' }, fakeRegistry({}));
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /has no registered entity yet/);
});

test('a reference to a registered entity of the wrong resourceType is reported', () => {
  const registry = fakeRegistry({ 'patient-maria': { resourceType: 'Practitioner' } });
  const issues = validateReferences(blueprint({ patient: { target: ['Patient'] } }), { patient: 'patient-maria' }, registry);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /must reference one of \[Patient\]/);
});

test('a correctly-typed, registered reference passes cleanly', () => {
  const registry = fakeRegistry({ 'patient-maria': { resourceType: 'Patient' } });
  const issues = validateReferences(blueprint({ patient: { target: ['Patient'] } }), { patient: 'patient-maria' }, registry);
  assert.deepEqual(issues, []);
});

test('an absent reference field is not this pass\'s concern (required-ness belongs to Form/Blueprint Validation)', () => {
  const issues = validateReferences(blueprint({ patient: { target: ['Patient'] } }), {}, fakeRegistry({}));
  assert.deepEqual(issues, []);
});
