const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRuntimeValues } = require('../dist');

// DV_COUNT/DV_INTEGER/DV_DECIMAL support (P0.1 audit, 2026-09-05). Unlike
// DV_QUANTITY, a plain number has no unit dimension - its archetype range/
// precision sits directly on FormElementLayout.numberRange, not per-unit.
// Was a total validation gap before this: an input-number field's own
// archetype constraint (confirmed real: "Dosierungsreihenfolge"/at0164 on
// vg_MedicationStatement.v1.1.0, `min: 1, minOp: '>='`) was never enforced -
// see quantity-range-precision.test.js's sibling DV_QUANTITY coverage.
function form(numberRange) {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [{ type: 'input-number', id: 'dosage_sequence', label: 'Dosierungsreihenfolge', numberRange }],
      }],
    },
  };
}

const SEQUENCE_RANGE = { min: 1, precision: 0 };

test('a value within range and precision produces no issues at all', () => {
  const result = validateRuntimeValues(form(SEQUENCE_RANGE), { dosage_sequence: 3 });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('a value below the archetype minimum is a blocking, template-sourced issue', () => {
  const result = validateRuntimeValues(form(SEQUENCE_RANGE), { dosage_sequence: 0 });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'number-range');
  assert.equal(result.issues[0].severity, 'error');
  assert.equal(result.issues[0].source, 'template');
  assert.equal(result.valid, false, 'a real archetype range constraint describes valid data and must block');
});

test('a value above the archetype maximum blocks too', () => {
  const result = validateRuntimeValues(form({ min: 1, max: 24 }), { dosage_sequence: 30 });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'number-range');
  assert.equal(result.valid, false);
});

test('a value with more decimal places than the archetype precision allows blocks', () => {
  const result = validateRuntimeValues(form(SEQUENCE_RANGE), { dosage_sequence: 2.5 });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'number-precision');
  assert.equal(result.issues[0].severity, 'error');
  assert.equal(result.valid, false);
});

test('an inclusive min (the default) accepts the boundary value itself', () => {
  const result = validateRuntimeValues(form(SEQUENCE_RANGE), { dosage_sequence: 1 });
  assert.deepEqual(result.issues, []);
});

test('minexclusive rejects the boundary value itself, not just values below it', () => {
  const exclusive = { min: 0, minexclusive: true };
  const atBoundary = validateRuntimeValues(form(exclusive), { dosage_sequence: 0 });
  assert.equal(atBoundary.issues.length, 1);
  assert.equal(atBoundary.issues[0].code, 'number-range');
  const aboveBoundary = validateRuntimeValues(form(exclusive), { dosage_sequence: 0.1 });
  assert.deepEqual(aboveBoundary.issues, []);
});

test('maxexclusive rejects the boundary value itself, not just values above it', () => {
  const exclusive = { max: 10, maxexclusive: true };
  const atBoundary = validateRuntimeValues(form(exclusive), { dosage_sequence: 10 });
  assert.equal(atBoundary.issues.length, 1);
  assert.equal(atBoundary.issues[0].code, 'number-range');
  const belowBoundary = validateRuntimeValues(form(exclusive), { dosage_sequence: 9.9 });
  assert.deepEqual(belowBoundary.issues, []);
});

test('a field with no numberRange at all (archetype specifies no constraint) is completely unaffected', () => {
  const result = validateRuntimeValues(form(undefined), { dosage_sequence: 123.456 });
  assert.deepEqual(result.issues, []);
});

test('the generic designer-configured field.validation.min/max rule (Block 1) is a completely separate mechanism, not conflated with numberRange', () => {
  const withDesignerRule = {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [{ type: 'input-number', id: 'dosage_sequence', label: 'Dosierungsreihenfolge', numberRange: SEQUENCE_RANGE, validation: { max: 5 } }],
      }],
    },
  };
  // 3 satisfies both the archetype's numberRange (min 1) and the designer's
  // own validation.max (5) - no issues from either mechanism.
  const ok = validateRuntimeValues(withDesignerRule, { dosage_sequence: 3 });
  assert.deepEqual(ok.issues, []);
  // 8 satisfies numberRange (no max there) but violates the designer's own
  // validation.max: 5 - a completely separate, still-independently-checked
  // issue code ('max'), proving neither mechanism silently absorbed the other.
  const overDesignerMax = validateRuntimeValues(withDesignerRule, { dosage_sequence: 8 });
  assert.equal(overDesignerMax.issues.length, 1);
  assert.equal(overDesignerMax.issues[0].code, 'max');
});

test('a non-numeric value is still the existing plain "type" error, not double-flagged by range/precision', () => {
  const result = validateRuntimeValues(form(SEQUENCE_RANGE), { dosage_sequence: 'not-a-number' });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'type');
});
