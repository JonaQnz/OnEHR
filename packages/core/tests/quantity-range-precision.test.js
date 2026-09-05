const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRuntimeValues } = require('../dist');

// A DV_QUANTITY field's unitOptions can carry per-unit min/max/precision
// straight from the archetype's own range/precision validation (see
// webTemplateParser.ts and formGenerator.ts - both used to silently drop
// this onto the floor, keeping only the bare unit string). Live example:
// vg_MedicationAdministration's "Frequenz" constrains "1/d" to min 1,
// precision 0 (a whole number of doses per day).
function form(unitOptions) {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [{ type: 'input-quantity', id: 'frequenz', label: 'Frequenz', unitOptions }],
      }],
    },
  };
}

const FREQUENZ_UNITS = [{ unit: '1/d', min: 1, precision: 0 }, { unit: '1/h', min: 1, max: 24, precision: 0 }];

test('a magnitude within range and precision produces no issues at all', () => {
  const result = validateRuntimeValues(form(FREQUENZ_UNITS), { frequenz: { magnitude: 3, unit: '1/d' } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('a magnitude below the unit\'s min is a blocking, template-sourced issue', () => {
  const result = validateRuntimeValues(form(FREQUENZ_UNITS), { frequenz: { magnitude: 0, unit: '1/d' } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'quantity-range');
  assert.equal(result.issues[0].severity, 'error');
  assert.equal(result.issues[0].source, 'template');
  assert.equal(result.valid, false, 'a real archetype range constraint describes valid data and must block - see isBlockingIssue\'s doc comment');
});

test('a magnitude above the unit\'s max blocks too', () => {
  const result = validateRuntimeValues(form(FREQUENZ_UNITS), { frequenz: { magnitude: 30, unit: '1/h' } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'quantity-range');
  assert.equal(result.valid, false);
});

test('a magnitude with more decimal places than the unit\'s precision allows blocks', () => {
  const result = validateRuntimeValues(form(FREQUENZ_UNITS), { frequenz: { magnitude: 2.5, unit: '1/d' } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'quantity-precision');
  assert.equal(result.issues[0].severity, 'error');
  assert.equal(result.valid, false);
});

test('an inclusive min (the default) accepts the boundary value itself', () => {
  const result = validateRuntimeValues(form(FREQUENZ_UNITS), { frequenz: { magnitude: 1, unit: '1/d' } });
  assert.deepEqual(result.issues, []);
});

test('minexclusive rejects the boundary value itself, not just values below it', () => {
  const exclusive = [{ unit: 'mg/kg', min: 0, minexclusive: true }];
  const atBoundary = validateRuntimeValues(form(exclusive), { frequenz: { magnitude: 0, unit: 'mg/kg' } });
  assert.equal(atBoundary.issues.length, 1);
  assert.equal(atBoundary.issues[0].code, 'quantity-range');
  const aboveBoundary = validateRuntimeValues(form(exclusive), { frequenz: { magnitude: 0.1, unit: 'mg/kg' } });
  assert.deepEqual(aboveBoundary.issues, []);
});

test('a range/precision violation still combines correctly with another blocking issue in the same submission', () => {
  const withUnrelatedError = validateRuntimeValues(
    { layout: { type: 'form', children: [{ type: 'container', children: [
      { type: 'input-text', id: 'name', label: 'Name', required: true },
      { type: 'input-quantity', id: 'frequenz', label: 'Frequenz', unitOptions: FREQUENZ_UNITS },
    ] }] } },
    { frequenz: { magnitude: 0, unit: '1/d' } }, // name missing (required) + frequenz below min (also blocking now)
  );
  assert.equal(withUnrelatedError.valid, false, 'both a required-field violation and an archetype range violation must block');
  assert.equal(withUnrelatedError.issues.length, 2);
  assert.ok(withUnrelatedError.issues.some((entry) => entry.code === 'required'));
  assert.ok(withUnrelatedError.issues.some((entry) => entry.code === 'quantity-range' && entry.severity === 'error' && entry.source === 'template'));
});

test('a field with no unitOptions at all (archetype specifies no constraint) is completely unaffected', () => {
  const result = validateRuntimeValues(form(undefined), { frequenz: { magnitude: 123.456, unit: 'anything' } });
  assert.deepEqual(result.issues, []);
});

test('a value in an unrecognized unit is flagged by the existing "unit" check, not double-flagged by range/precision', () => {
  const result = validateRuntimeValues(form(FREQUENZ_UNITS), { frequenz: { magnitude: 0, unit: 'bogus' } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'unit');
});

// Found while adding DV_PROPORTION support alongside this file: numericValue()
// returns NaN, not undefined, for a non-numeric magnitude STRING wrapped in
// an otherwise-valid-looking object - the old `magnitude === undefined`
// guard missed this entirely (only a bare non-object value, or an object
// with magnitude truly absent, was ever caught). A malformed-but-object-
// shaped quantity silently produced zero validation issues.
test('a non-numeric magnitude string inside an otherwise well-formed object is still a type error, not silently accepted', () => {
  const result = validateRuntimeValues(form(FREQUENZ_UNITS), { frequenz: { magnitude: 'not-a-number', unit: '1/d' } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'type');
});
