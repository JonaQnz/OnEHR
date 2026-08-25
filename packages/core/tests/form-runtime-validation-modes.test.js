const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRuntimeValues } = require('../dist');

function form() {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [
          { type: 'input-text', id: 'name', label: 'Name', required: true },
          { type: 'input-quantity', id: 'weight', label: 'Gewicht', required: true },
        ],
      }],
    },
  };
}

// Test 1/2 from Epic 2's spec: a real openEHR draft (lifecycle_state=
// incomplete) is explicitly allowed to have missing required fields, but
// never an invalid typed value.
test('draft mode allows a missing required field but still rejects an invalid typed value', () => {
  const missingRequired = validateRuntimeValues(form(), {}, { mode: 'draft' });
  assert.equal(missingRequired.valid, true, 'missing required fields must not block a draft save');
  assert.deepEqual(missingRequired.issues, []);

  const invalidQuantity = validateRuntimeValues(form(), { name: 'Ada', weight: 'abc' }, { mode: 'draft' });
  assert.equal(invalidQuantity.valid, false, 'an invalid DV_QUANTITY value must still block a draft save');
  assert.equal(invalidQuantity.issues.length, 1);
  assert.equal(invalidQuantity.issues[0].code, 'type');
  assert.equal(invalidQuantity.issues[0].path, 'weight');
});

test('final mode (the default) still requires every required field', () => {
  const missingRequired = validateRuntimeValues(form(), { name: 'Ada' });
  assert.equal(missingRequired.valid, false);
  assert.equal(missingRequired.issues[0].code, 'required');
  assert.equal(missingRequired.issues[0].path, 'weight');

  const explicitFinal = validateRuntimeValues(form(), { name: 'Ada' }, { mode: 'final' });
  assert.deepEqual(explicitFinal, missingRequired);

  const complete = validateRuntimeValues(form(), { name: 'Ada', weight: { magnitude: 63, unit: 'kg' } }, { mode: 'final' });
  assert.equal(complete.valid, true);
});

test('draft mode never masks a repeat-group entry that is itself invalid, only missing entries', () => {
  const grouped = {
    layout: {
      type: 'form',
      children: [{
        type: 'container', id: 'meds', label: 'Medications', repeatable: true, repeatMin: 1, repeatMax: -1,
        children: [{ type: 'input-quantity', id: 'dose', label: 'Dose', required: true, repeatableGroupId: 'meds' }],
      }],
    },
  };
  // No entries at all - repeat-min is exempt in draft mode.
  const empty = validateRuntimeValues(grouped, { meds: [] }, { mode: 'draft' });
  assert.equal(empty.valid, true);

  // One entry, but with an invalid value - not exempt, draft mode still catches it.
  const invalidEntry = validateRuntimeValues(grouped, { meds: [{ dose: 'not-a-number' }] }, { mode: 'draft' });
  assert.equal(invalidEntry.valid, false);
  assert.ok(invalidEntry.issues.some((issue) => issue.code === 'type'));
});
