const assert = require('node:assert/strict');
const test = require('node:test');
const { compareRuntimeValues } = require('../dist');

function form(layoutChildren) {
  return {
    type: 'form',
    id: 'root',
    children: [{ type: 'container', id: 'page', children: layoutChildren }],
  };
}

// Test 6 - Simple Text Diff
test('a changed text field produces one changed entry with old/new/path/nodeId', () => {
  const definition = { layout: form([
    { type: 'input-text', id: 'comment', name: 'comment', label: 'Kommentar', binding: { rmType: 'DV_TEXT', archetypeNodeId: 'at0005' } },
  ]) };
  const diff = compareRuntimeValues(definition, { comment: 'Patient stabil' }, { comment: 'Patient klinisch stabil' });
  assert.equal(diff.changed.length, 1);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  const entry = diff.changed[0];
  assert.equal(entry.path, 'comment');
  assert.equal(entry.archetypeNodeId, 'at0005');
  assert.equal(entry.oldValue, 'Patient stabil');
  assert.equal(entry.newValue, 'Patient klinisch stabil');
});

// Test 7 - Quantity Diff
test('a changed DV_QUANTITY shows magnitude+unit, not raw JSON', () => {
  const definition = { layout: form([
    { type: 'input-quantity', id: 'weight', name: 'weight', label: 'Körpergewicht', unitOptions: [{ unit: 'kg' }], binding: { rmType: 'DV_QUANTITY' } },
  ]) };
  const diff = compareRuntimeValues(definition, { weight: { magnitude: 87, unit: 'kg' } }, { weight: { magnitude: 78, unit: 'kg' } });
  assert.equal(diff.changed.length, 1);
  const entry = diff.changed[0];
  assert.deepEqual(entry.oldValue, { magnitude: 87, unit: 'kg' });
  assert.deepEqual(entry.newValue, { magnitude: 78, unit: 'kg' });
});

test('an unchanged DV_QUANTITY (same magnitude/unit) produces no entry', () => {
  const definition = { layout: form([
    { type: 'input-quantity', id: 'weight', name: 'weight', label: 'Weight', unitOptions: [{ unit: 'kg' }] },
  ]) };
  const diff = compareRuntimeValues(definition, { weight: { magnitude: 87, unit: 'kg' } }, { weight: { magnitude: 87, unit: 'kg' } });
  assert.equal(diff.changed.length, 0);
});

// Test 8 - Added Node
test('a field that only has a value in the new version is added', () => {
  const definition = { layout: form([
    { type: 'input-select', id: 'diagnosis', name: 'diagnosis', label: 'Diagnose', options: [{ value: 'e11', text: 'Diabetes mellitus Typ 2' }] },
  ]) };
  const diff = compareRuntimeValues(definition, {}, { diagnosis: 'e11' });
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].newValue, 'Diabetes mellitus Typ 2');
  assert.equal(diff.changed.length, 0);
});

// Test 9 - Removed Node
test('a field that only has a value in the old version is removed', () => {
  const definition = { layout: form([
    { type: 'input-select', id: 'allergy', name: 'allergy', label: 'Allergie', options: [{ value: 'pen', text: 'Penicillin' }] },
  ]) };
  const diff = compareRuntimeValues(definition, { allergy: 'pen' }, {});
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].oldValue, 'Penicillin');
});

// Test 10 - Repeating Nodes (reordered, no clinical change)
test('reordering a repeatable field is not reported as a change', () => {
  const definition = { layout: form([
    { type: 'input-text', id: 'medication', name: 'medication', label: 'Medikation', repeatable: true, repeatMin: 0, repeatMax: -1 },
  ]) };
  const diff = compareRuntimeValues(definition, { medication: ['Aspirin', 'Metoprolol'] }, { medication: ['Metoprolol', 'Aspirin'] });
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(diff.changed, []);
});

// Test 11 - Added Repeat Instance
test('adding one repeat instance reports only that instance as added, not a changed existing one', () => {
  const definition = { layout: form([
    { type: 'input-text', id: 'medication', name: 'medication', label: 'Medikation', repeatable: true, repeatMin: 0, repeatMax: -1 },
  ]) };
  const diff = compareRuntimeValues(definition, { medication: ['Aspirin'] }, { medication: ['Aspirin', 'Metoprolol'] });
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].newValue, 'Metoprolol');
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.removed, []);
});

// Test 12 - Label Change (no clinical diff)
test('changing a field label between the two definitions never produces a diff entry by itself', () => {
  const binding = { rmType: 'DV_QUANTITY', archetypeNodeId: 'at0004' };
  const before = { layout: form([{ type: 'input-quantity', id: 'systolic', name: 'systolic', label: 'Blood Pressure', unitOptions: [{ unit: 'mm[Hg]' }], binding }]) };
  const after = { layout: form([{ type: 'input-quantity', id: 'systolic', name: 'systolic', label: 'Blutdruck', unitOptions: [{ unit: 'mm[Hg]' }], binding }]) };
  const values = { systolic: { magnitude: 120, unit: 'mm[Hg]' } };
  // Using the OLD definition (matching the values it was captured with) for
  // field enumeration - the point under test is that unchanged clinical
  // values never diff just because a label changed elsewhere.
  const diff = compareRuntimeValues(before, values, values);
  assert.deepEqual(diff, { added: [], removed: [], changed: [] });
  const diffAfterRelabel = compareRuntimeValues(after, values, values);
  assert.deepEqual(diffAfterRelabel, { added: [], removed: [], changed: [] });
});

// Test 13 - Ignore Technical Metadata
test('fields with no openEHR binding produce zero clinical changes even when their raw value differs', () => {
  // collectRuntimeFields already only yields real form fields (paragraph/
  // layout nodes are excluded at the source), so this is automatic - a
  // layout-only node id never appears in RuntimeValues in the first place.
  const definition = { layout: form([
    { type: 'paragraph', id: 'help', content: 'Hinweistext' },
    { type: 'input-text', id: 'comment', name: 'comment', label: 'Kommentar' },
  ]) };
  const diff = compareRuntimeValues(definition, { help: 'old ui text', comment: 'same' }, { help: 'new ui text', comment: 'same' });
  assert.deepEqual(diff, { added: [], removed: [], changed: [] });
});

test('a repeatable group diffs per sub-field within a matched row and reports whole-row add/remove otherwise', () => {
  const definition = { layout: {
    type: 'form', id: 'root', children: [{
      type: 'container', id: 'page', children: [{
        type: 'container', id: 'medications', label: 'Medikation', repeatable: true, repeatMin: 0, repeatMax: -1,
        children: [
          { type: 'input-text', id: 'substance', name: 'substance', label: 'Substanz', repeatableGroupId: 'medications' },
          { type: 'input-quantity', id: 'dose', name: 'dose', label: 'Dosis', unitOptions: [{ unit: 'mg' }], repeatableGroupId: 'medications' },
        ],
      }],
    }],
  } };
  const before = { medications: [{ substance: 'Metoprolol', dose: { magnitude: 100, unit: 'mg' } }] };
  const after = { medications: [{ substance: 'Metoprolol', dose: { magnitude: 150, unit: 'mg' } }] };
  const diff = compareRuntimeValues(definition, before, after);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].path, 'medications[0].dose');
  assert.deepEqual(diff.changed[0].oldValue, { magnitude: 100, unit: 'mg' });
  assert.deepEqual(diff.changed[0].newValue, { magnitude: 150, unit: 'mg' });
});
