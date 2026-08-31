const assert = require('node:assert/strict');
const test = require('node:test');
const { createInitialRuntimeValues } = require('../dist');

function formWithRepeatGroup({ repeatMin }) {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container', id: 'meds', repeatable: true, repeatMin, repeatMax: 5,
        children: [
          { type: 'input-text', id: 'dose', repeatable: true, defaultValue: 'once daily' },
        ],
      }],
    },
  };
}

// QA review finding: `values[group.id] = Array.from({ length: repeatMin },
// () => ({ ...itemDefaults }))` only shallow-copies `itemDefaults` per
// row - a repeatable sub-field's default is itself an array
// (`[field.defaultValue]`), so every generated row ended up sharing the
// exact same array *instance* for that field. Editing one row's
// repeatable sub-field silently mutated every other row's too.
test('each row of a repeat-min>1 group gets its own independent array for a repeatable sub-field default, not a shared reference', () => {
  const values = createInitialRuntimeValues(formWithRepeatGroup({ repeatMin: 2 }));
  assert.equal(values.meds.length, 2);
  assert.deepEqual(values.meds[0].dose, ['once daily']);
  assert.deepEqual(values.meds[1].dose, ['once daily']);
  // The actual regression: must not be the same array instance.
  assert.notEqual(values.meds[0].dose, values.meds[1].dose);

  values.meds[0].dose.push('as needed');
  assert.deepEqual(values.meds[0].dose, ['once daily', 'as needed']);
  assert.deepEqual(values.meds[1].dose, ['once daily'], 'mutating row 0 must never affect row 1');
});

test('a repeatMin of 0 produces no rows at all', () => {
  const values = createInitialRuntimeValues(formWithRepeatGroup({ repeatMin: 0 }));
  assert.deepEqual(values.meds, []);
});
