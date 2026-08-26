const assert = require('node:assert/strict');
const test = require('node:test');
const { mapLifecycleState, mapChangeType, parseVersionNumber, summarizeDiff, LIFECYCLE_STATE_LABELS, CHANGE_TYPE_LABELS } = require('../dist');

// Test 3 - Lifecycle Mapping
test('mapLifecycleState normalizes by value first, falls back to code, and never throws on an unknown code', () => {
  assert.equal(mapLifecycleState('incomplete', '553'), 'incomplete');
  assert.equal(mapLifecycleState('complete', '532'), 'complete');
  assert.equal(mapLifecycleState('deleted', '523'), 'deleted');
  assert.equal(mapLifecycleState(undefined, '553'), 'incomplete');
  assert.equal(mapLifecycleState('something-unrecognized', '999999'), 'unknown');
  assert.equal(mapLifecycleState(undefined, undefined), 'unknown');
  assert.equal(LIFECYCLE_STATE_LABELS.incomplete, 'Entwurf');
  assert.equal(LIFECYCLE_STATE_LABELS.complete, 'Finalisiert');
  assert.equal(LIFECYCLE_STATE_LABELS.deleted, 'Zurückgezogen');
});

// Test 4 - Change Type Mapping
test('mapChangeType normalizes the documented set and degrades unknown codes without throwing', () => {
  assert.equal(mapChangeType('creation', '249'), 'creation');
  assert.equal(mapChangeType('modification', '251'), 'modification');
  assert.equal(mapChangeType('amendment', '250'), 'amendment');
  assert.equal(mapChangeType('deleted', '523'), 'deleted');
  assert.equal(mapChangeType(undefined, '251'), 'modification');
  assert.equal(mapChangeType('totally-unknown-value', '424242'), 'unknown');
  assert.doesNotThrow(() => mapChangeType(undefined, undefined));
  assert.equal(CHANGE_TYPE_LABELS.creation, 'Erstellt');
  assert.equal(CHANGE_TYPE_LABELS.modification, 'Aktualisiert');
  assert.equal(CHANGE_TYPE_LABELS.amendment, 'Korrigiert');
});

test('parseVersionNumber reads only the trailing ::N, keeping the full versionUid untouched elsewhere', () => {
  assert.equal(parseVersionNumber('7a8ff565-781e-456a-93e4-64f4361ed308::my-system::4'), 4);
  assert.equal(parseVersionNumber(undefined), undefined);
  assert.equal(parseVersionNumber('not-a-version-uid'), undefined);
});

test('summarizeDiff counts each bucket independently', () => {
  const diff = {
    added: [{ path: 'a', change: 'added' }],
    removed: [{ path: 'b', change: 'removed' }, { path: 'c', change: 'removed' }],
    changed: [{ path: 'd', change: 'changed' }, { path: 'e', change: 'changed' }, { path: 'f', change: 'changed' }],
  };
  assert.deepEqual(summarizeDiff(diff), { changed: 3, added: 1, removed: 2 });
});
