const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FacilityRegistry } = require('../dist/world/facilities');
const { clinicNamespaceFor, facilityIdForClinicNamespace, DEFAULT_FACILITY_ID, CLINIC_NAMESPACE } = require('../dist/context');

// User's own ask: "dass wir ein zweites Haus eröffnen können" - see
// context.ts's own doc comment for why the default facility keeps the
// legacy bare "_clinic" namespace (zero data migration for existing runs).

function freshRegistry() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csw-facilities-'));
  return new FacilityRegistry(dataDir);
}

test('open() creates a facility, listed by list()/get()', () => {
  const registry = freshRegistry();
  const facility = registry.open('rehazentrum', 'Rehazentrum Sonnenberg', 'Anschlussheilbehandlung.');
  assert.equal(facility.id, 'rehazentrum');
  assert.equal(registry.get('rehazentrum')?.name, 'Rehazentrum Sonnenberg');
  assert.equal(registry.list().length, 1);
});

test('open() is idempotent - a second call for the same id returns the original unchanged', () => {
  const registry = freshRegistry();
  const first = registry.open('rehazentrum', 'Rehazentrum Sonnenberg', 'Original.');
  const second = registry.open('rehazentrum', 'Different Name', 'Different description.');
  assert.equal(second.name, first.name);
  assert.equal(second.createdAt, first.createdAt);
  assert.equal(registry.list().length, 1);
});

test('get() returns undefined for an unknown facility', () => {
  const registry = freshRegistry();
  assert.equal(registry.get('does-not-exist'), undefined);
});

test('clinicNamespaceFor: the default facility keeps the legacy bare "_clinic" namespace', () => {
  assert.equal(clinicNamespaceFor(DEFAULT_FACILITY_ID), '_clinic');
  assert.equal(clinicNamespaceFor(DEFAULT_FACILITY_ID), CLINIC_NAMESPACE);
});

test('clinicNamespaceFor: any other facility gets its own "_clinic:<id>" namespace', () => {
  assert.equal(clinicNamespaceFor('rehazentrum'), '_clinic:rehazentrum');
});

test('facilityIdForClinicNamespace is the exact inverse of clinicNamespaceFor', () => {
  assert.equal(facilityIdForClinicNamespace('_clinic'), DEFAULT_FACILITY_ID);
  assert.equal(facilityIdForClinicNamespace('_clinic:rehazentrum'), 'rehazentrum');
});

test('facilityIdForClinicNamespace returns undefined for a real (non-clinic) scenarioRunId', () => {
  assert.equal(facilityIdForClinicNamespace('offener-fall-live-2026-09-17'), undefined);
});
