const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EntityRegistry } = require('../dist/entity/registry');

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'csw-entity-'));
}

test('upsert registers a new entity and persists it across a fresh instance', () => {
  const dataDir = tempDataDir();
  const registry = new EntityRegistry(dataDir, 'run-1');
  registry.upsert('patient-maria', { resourceType: 'Patient', hipResourceId: 'abc123', provenance: 'SOURCE' });

  const reloaded = new EntityRegistry(dataDir, 'run-1');
  const entity = reloaded.get('patient-maria');
  assert.equal(entity.resourceType, 'Patient');
  assert.equal(entity.hipResourceId, 'abc123');
  assert.equal(entity.provenance, 'SOURCE');
  assert.deepEqual(entity.fieldProvenance, {});
  assert.ok(entity.createdAt);
  assert.equal(entity.createdAt, entity.updatedAt);
});

test('a second upsert on the same key preserves createdAt but bumps updatedAt', async () => {
  const dataDir = tempDataDir();
  const registry = new EntityRegistry(dataDir, 'run-1');
  const first = registry.upsert('patient-maria', { resourceType: 'Patient', hipResourceId: 'abc123', provenance: 'SOURCE' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = registry.upsert('patient-maria', { resourceType: 'Patient', hipResourceId: 'abc123', fhirVersionId: '2', provenance: 'SOURCE' });
  assert.equal(second.createdAt, first.createdAt);
  assert.notEqual(second.updatedAt, first.updatedAt);
  assert.equal(second.fhirVersionId, '2');
});

test('setFieldProvenance merges into the per-field map without touching other fields', () => {
  const dataDir = tempDataDir();
  const registry = new EntityRegistry(dataDir, 'run-1');
  registry.upsert('appt-1', { resourceType: 'Appointment', hipResourceId: 'x', provenance: 'GENERATED', fieldProvenance: { start: 'GENERATED', end: 'GENERATED' } });
  registry.setFieldProvenance('appt-1', { start: 'USER' });
  const entity = registry.get('appt-1');
  assert.equal(entity.fieldProvenance.start, 'USER');
  assert.equal(entity.fieldProvenance.end, 'GENERATED');
});

test('two different scenario runs never see each other\'s entities', () => {
  const dataDir = tempDataDir();
  new EntityRegistry(dataDir, 'run-1').upsert('patient-maria', { resourceType: 'Patient', hipResourceId: 'abc', provenance: 'SOURCE' });
  const runTwo = new EntityRegistry(dataDir, 'run-2');
  assert.equal(runTwo.get('patient-maria'), undefined);
});
