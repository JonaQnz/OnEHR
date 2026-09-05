const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRuntimeValues } = require('../dist');

// DV_INTERVAL<DV_QUANTITY> support, added 2026-09-05 (P0.1 openEHR
// Constraint Completeness audit). Before this, DV_INTERVAL was a total gap
// across the whole pipeline - the WebTemplate parser registered a field for
// it in its flat catalog but never built an actual layout widget
// (getDataType had no case for the full generic string
// "DV_INTERVAL<DV_QUANTITY>"), confirmed live on the real, published
// "Medikationsabgleich" form's dose-range fields (openEHR-EHR-CLUSTER.
// dosage.v2's dose/alternate_dose, at0144/at0176): registered but
// unrepresentable, so nobody could enter a dose range through the Designer
// at all. Runtime value: {lower?: {magnitude, unit}, upper?: {magnitude,
// unit}} - mirrors input-quantity's own {magnitude, unit} shape, twice.
function form(unitOptions, required) {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [{ type: 'input-interval', id: 'dose_range', label: 'Dosisbereich', unitOptions, ...(required ? { required: true } : {}) }],
      }],
    },
  };
}

const DOSE_UNITS = [{ unit: 'mg', min: 0, minexclusive: true, precision: 1 }, { unit: 'ml', min: 0, minexclusive: true, precision: 2 }];

test('a closed range with both bounds valid produces no issues at all', () => {
  const result = validateRuntimeValues(form(DOSE_UNITS), { dose_range: { lower: { magnitude: 1, unit: 'mg' }, upper: { magnitude: 2, unit: 'mg' } } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('an open-ended interval (only upper given) is valid RM, not an error by itself', () => {
  const result = validateRuntimeValues(form(DOSE_UNITS), { dose_range: { upper: { magnitude: 5, unit: 'mg' } } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('an open-ended interval (only lower given) is likewise valid', () => {
  const result = validateRuntimeValues(form(DOSE_UNITS), { dose_range: { lower: { magnitude: 1, unit: 'mg' } } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('required + neither bound present at all is a genuine required error', () => {
  const result = validateRuntimeValues(form(DOSE_UNITS, true), { dose_range: {} });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'required');
  assert.equal(result.valid, false);
});

test('a bound that only picked up a unit (no magnitude yet - the shared unit selector writes it to both bounds unconditionally) is treated as untouched, not invalid', () => {
  const result = validateRuntimeValues(form(DOSE_UNITS), { dose_range: { lower: { unit: 'mg' }, upper: { unit: 'mg' } } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('lower greater than upper is a blocking interval-order error', () => {
  const result = validateRuntimeValues(form(DOSE_UNITS), { dose_range: { lower: { magnitude: 5, unit: 'mg' }, upper: { magnitude: 2, unit: 'mg' } } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'interval-order');
  assert.equal(result.valid, false);
});

test('lower equal to upper is valid (a degenerate, single-point range)', () => {
  const result = validateRuntimeValues(form(DOSE_UNITS), { dose_range: { lower: { magnitude: 2, unit: 'mg' }, upper: { magnitude: 2, unit: 'mg' } } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('mismatched units between lower and upper is a blocking error', () => {
  const result = validateRuntimeValues(form(DOSE_UNITS), { dose_range: { lower: { magnitude: 1, unit: 'mg' }, upper: { magnitude: 2, unit: 'ml' } } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'interval-unit-mismatch');
  assert.equal(result.valid, false);
});

test('each bound independently gets the archetype\'s own per-unit range/precision checks', () => {
  const result = validateRuntimeValues(form(DOSE_UNITS), { dose_range: { lower: { magnitude: 0, unit: 'mg' }, upper: { magnitude: 1.25, unit: 'mg' } } });
  assert.equal(result.issues.length, 2, 'lower fails min-exclusive-0, upper fails precision 1');
  assert.ok(result.issues.some((i) => i.code === 'quantity-range'));
  assert.ok(result.issues.some((i) => i.code === 'quantity-precision'));
  assert.equal(result.valid, false);
});

test('a non-numeric magnitude on a bound is a type error, same family as input-quantity\'s own', () => {
  const result = validateRuntimeValues(form(DOSE_UNITS), { dose_range: { lower: { magnitude: 'abc', unit: 'mg' } } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'type');
  assert.equal(result.valid, false);
});

test('a field with no unitOptions at all is completely unaffected by the unit checks, only magnitude order/type matter', () => {
  const result = validateRuntimeValues(form(undefined), { dose_range: { lower: { magnitude: 3 }, upper: { magnitude: 1 } } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'interval-order');
});
