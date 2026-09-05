const assert = require('node:assert/strict');
const test = require('node:test');
const { createInitialRuntimeValues, validateRuntimeValues } = require('../dist');

// Nested repeats ("Repeat innerhalb Repeat", P0.2 audit, 2026-09-05) - a
// real, confirmed architecture gap before this: RuntimeGroupDescriptor had
// no way to know a repeatable group was itself nested inside another one,
// so both createInitialRuntimeValues and validateRuntimeValues always
// looked at `values[group.id]`/`values[field.repeatableGroupId]` directly
// at the TOP level, regardless of nesting. A nested group's own rows
// actually live inside each of its parent's row objects
// (parentRow[nestedGroupId]) - every outer-row instance sharing/colliding
// on one single top-level array was the concrete, live consequence (see
// [[p02-repeatables-audit-and-first-fixes]]). This file covers the
// validation-engine half of the fix - see that memory for what's
// deliberately still NOT done (FormRuntime.tsx's own add/edit/remove UI
// for a nested group, and openehr-engine's FLAT/canonical serialization).
//
// Shape: "Medikament" (outer, repeatable) containing "Einnahmezeitpunkt"
// (inner, repeatable) - a real clinical shape (one medication, several
// scheduled administration times each).
function medicationForm({ outerMin = 0, outerMax = -1, innerMin = 0, innerMax = -1 } = {}) {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container', id: 'medications', label: 'Medikamente', repeatable: true, repeatMin: outerMin, repeatMax: outerMax,
        children: [
          { type: 'input-text', id: 'medication_name', label: 'Name', required: true },
          {
            type: 'container', id: 'schedule', label: 'Einnahmezeitpunkt', repeatable: true, repeatMin: innerMin, repeatMax: innerMax,
            children: [
              { type: 'input-time', id: 'time', label: 'Uhrzeit', required: true },
            ],
          },
        ],
      }],
    },
  };
}

test('createInitialRuntimeValues nests the inner group\'s default rows inside each outer row, not at the top level', () => {
  const form = {
    layout: {
      type: 'form',
      children: [{
        type: 'container', id: 'medications', repeatable: true, repeatMin: 2,
        children: [
          { type: 'input-text', id: 'medication_name', defaultValue: 'Unbekannt' },
          {
            type: 'container', id: 'schedule', repeatable: true, repeatMin: 1,
            children: [{ type: 'input-time', id: 'time', defaultValue: '08:00' }],
          },
        ],
      }],
    },
  };
  const values = createInitialRuntimeValues(form);
  assert.equal(values.medications.length, 2);
  // Never a stray top-level `values.schedule` - that would be exactly the
  // pre-fix bug (a global, un-scoped array every outer row would collide on).
  assert.equal(values.schedule, undefined);
  assert.equal(values.medications[0].schedule.length, 1);
  assert.equal(values.medications[0].schedule[0].time, '08:00');
  assert.equal(values.medications[1].schedule.length, 1);
  // Each outer row's own inner array must be its own instance, same
  // reasoning as the pre-existing shallow-copy fix for repeatable sub-fields.
  assert.notEqual(values.medications[0].schedule, values.medications[1].schedule);
  values.medications[0].schedule.push({ time: '20:00' });
  assert.equal(values.medications[0].schedule.length, 2);
  assert.equal(values.medications[1].schedule.length, 1, 'mutating row 0\'s inner group must never affect row 1\'s');
});

test('two outer rows can independently have a DIFFERENT number of inner rows with no cross-row interference - the core bug this fixes', () => {
  const values = {
    medications: [
      { medication_name: 'Metformin', schedule: [{ time: '08:00' }, { time: '20:00' }] },
      { medication_name: 'Ibuprofen', schedule: [{ time: '12:00' }] },
    ],
  };
  const result = validateRuntimeValues(medicationForm(), values);
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('an outer-group repeatMin/repeatMax violation is reported at the outer group\'s own path', () => {
  const result = validateRuntimeValues(medicationForm({ outerMin: 2 }), {
    medications: [{ medication_name: 'Metformin', schedule: [] }],
  });
  assert.ok(result.issues.some((i) => i.path === 'medications' && i.code === 'repeat-min'));
});

test('an inner-group repeatMin violation is reported at the correctly nested path, scoped to its own outer row', () => {
  const result = validateRuntimeValues(medicationForm({ innerMin: 1 }), {
    medications: [
      { medication_name: 'Metformin', schedule: [] },
      { medication_name: 'Ibuprofen', schedule: [{ time: '12:00' }] },
    ],
  });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].path, 'medications[0].schedule');
  assert.equal(result.issues[0].code, 'repeat-min');
  assert.equal(result.valid, false);
});

test('a required field inside a nested group\'s row is validated at the fully nested path, not silently skipped', () => {
  const result = validateRuntimeValues(medicationForm(), {
    medications: [{ medication_name: 'Metformin', schedule: [{ time: '' }] }],
  });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].path, 'medications[0].schedule[0].time');
  assert.equal(result.issues[0].code, 'required');
});

test('a malformed (non-object) inner row produces exactly one "requires object entries" issue, not one per field in that group', () => {
  const result = validateRuntimeValues(medicationForm(), {
    medications: [{ medication_name: 'Metformin', schedule: ['not-an-object'] }],
  });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].path, 'medications[0].schedule[0]');
  assert.equal(result.issues[0].code, 'type');
});

test('a missing inner group array on one outer row (undefined, never touched) is treated as zero entries, not an error, when innerMin is 0', () => {
  const result = validateRuntimeValues(medicationForm(), {
    medications: [{ medication_name: 'Metformin' }],
  });
  assert.deepEqual(result.issues, []);
});

test('an outer field required check still fires correctly alongside independent inner-group validation on the same row', () => {
  const result = validateRuntimeValues(medicationForm(), {
    medications: [{ medication_name: '', schedule: [{ time: '08:00' }] }],
  });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].path, 'medications[0].medication_name');
  assert.equal(result.issues[0].code, 'required');
});

test('three levels of nesting (group > group > group) resolve every path correctly, not just one level deep', () => {
  const form = {
    layout: {
      type: 'form',
      children: [{
        type: 'container', id: 'a', repeatable: true,
        children: [{
          type: 'container', id: 'b', repeatable: true,
          children: [{
            type: 'container', id: 'c', repeatable: true,
            children: [{ type: 'input-text', id: 'leaf', required: true }],
          }],
        }],
      }],
    },
  };
  const result = validateRuntimeValues(form, {
    a: [{ b: [{ c: [{ leaf: '' }] }] }],
  });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].path, 'a[0].b[0].c[0].leaf');
  assert.equal(result.issues[0].code, 'required');
});
