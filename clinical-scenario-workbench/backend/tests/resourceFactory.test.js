const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFhirResource } = require('../dist/fhir/resourceFactory');

const fields = [
  { path: 'name.0.family', label: 'Family', type: 'text', required: true, editable: true, sourcePolicy: 'scenario' },
  { path: 'gender', label: 'Gender', type: 'select', required: true, editable: true, sourcePolicy: 'scenario' },
  { path: 'participant.0.actor.reference', label: 'Patient', type: 'reference', required: true, editable: true, sourcePolicy: 'scenario', referenceResourceTypes: ['Patient'] },
];

function fakeRegistry(entities) {
  return { get: (key) => entities[key] };
}

test('nested dotted paths build the correct object/array structure', () => {
  const resource = buildFhirResource('Patient', fields.slice(0, 2), { 'name.0.family': 'Schneider', gender: 'female' }, fakeRegistry({}));
  assert.deepEqual(resource, { resourceType: 'Patient', name: [{ family: 'Schneider' }], gender: 'female' });
});

test('a reference field resolves a scenario key to a real FHIR reference via the registry', () => {
  const registry = fakeRegistry({ 'patient-maria': { resourceType: 'Patient', hipResourceId: '4711' } });
  const resource = buildFhirResource('Appointment', [fields[2]], { 'participant.0.actor.reference': 'patient-maria' }, registry);
  assert.deepEqual(resource, { resourceType: 'Appointment', participant: [{ actor: { reference: 'Patient/4711' } }] });
});

test('an unresolvable reference throws rather than writing a broken reference', () => {
  assert.throws(
    () => buildFhirResource('Appointment', [fields[2]], { 'participant.0.actor.reference': 'nope' }, fakeRegistry({})),
    /scenario key "nope" is not registered/,
  );
});

test('with an existingResource, unmanaged fields (e.g. meta) survive; managed fields get overwritten', () => {
  const existingResource = { resourceType: 'Patient', id: 'p1', meta: { versionId: '1' }, name: [{ family: 'Old' }], gender: 'male' };
  const resource = buildFhirResource('Patient', fields.slice(0, 1), { 'name.0.family': 'New' }, fakeRegistry({}), { existingResource });
  assert.equal(resource.id, 'p1');
  assert.deepEqual(resource.meta, { versionId: '1' });
  assert.deepEqual(resource.name, [{ family: 'New' }]);
  assert.equal(resource.gender, 'male');
});

test('mutating the returned resource never mutates the existingResource passed in', () => {
  const existingResource = { resourceType: 'Patient', name: [{ family: 'Old' }] };
  const resource = buildFhirResource('Patient', fields.slice(0, 1), { 'name.0.family': 'New' }, fakeRegistry({}), { existingResource });
  assert.equal(existingResource.name[0].family, 'Old');
  assert.equal(resource.name[0].family, 'New');
});
