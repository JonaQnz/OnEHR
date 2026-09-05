const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRuntimeValues } = require('../dist');

// DV_PROPORTION support, added 2026-09-02 after auditing the codebase
// against the openEHR RM Data Types spec - previously an 'input-proportion'
// field's runtime value was a bare number with no denominator/type
// semantics at all. Now {numerator, denominator?}, mirroring
// input-quantity's {magnitude, unit}. PROPORTION_KIND ('ratio'/'unitary'/
// 'percent'/'fraction'/'integer_fraction') per
// specifications.openehr.org/releases/RM/latest/data_types.html and the
// BaseTypes.xsd enumeration.
function form(proportionType) {
  return {
    layout: {
      type: 'form',
      children: [{ type: 'container', children: [
        { type: 'input-proportion', id: 'ratio_field', label: 'Verhältnis', ...(proportionType ? { proportionType } : {}) },
      ] }],
    },
  };
}

test('a plain {numerator, denominator} value with no proportionType is valid as long as denominator is not 0', () => {
  const result = validateRuntimeValues(form(undefined), { ratio_field: { numerator: 1, denominator: 128 } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('denominator 0 is a hard, blocking error - the one universal DV_PROPORTION invariant (RM amendment SPECRM-32)', () => {
  const result = validateRuntimeValues(form(undefined), { ratio_field: { numerator: 5, denominator: 0 } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'proportion-denominator');
  assert.equal(result.issues[0].severity, undefined, 'must be a real error, not a warning, unlike every other proportion check');
  assert.equal(result.valid, false);
});

test('type "ratio" with no denominator supplied at all is a genuine gap - required, not implied', () => {
  const result = validateRuntimeValues(form('ratio'), { ratio_field: { numerator: 1 } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'type');
  assert.equal(result.valid, false);
});

test('type "unitary" implies denominator 1 - a bare numerator alone is valid', () => {
  const result = validateRuntimeValues(form('unitary'), { ratio_field: { numerator: 0.35 } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('type "percent" implies denominator 100 - a bare numerator alone is valid', () => {
  const result = validateRuntimeValues(form('percent'), { ratio_field: { numerator: 45.2 } });
  assert.deepEqual(result.issues, []);
});

test('type "percent" with an explicit denominator that disagrees with 100 is a blocking, template-sourced issue', () => {
  const result = validateRuntimeValues(form('percent'), { ratio_field: { numerator: 45.2, denominator: 50 } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'proportion-type');
  assert.equal(result.issues[0].severity, 'error');
  assert.equal(result.issues[0].source, 'template');
  assert.equal(result.valid, false, 'PROPORTION_KIND is an archetype constraint and must block, like quantity-range/precision');
});

test('type "unitary" with an explicit denominator that disagrees with 1 blocks too', () => {
  const result = validateRuntimeValues(form('unitary'), { ratio_field: { numerator: 0.5, denominator: 2 } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'proportion-type');
  assert.equal(result.valid, false);
});

test('type "fraction" requires both numerator and denominator to be whole numbers - blocks when violated', () => {
  const result = validateRuntimeValues(form('fraction'), { ratio_field: { numerator: 1.5, denominator: 4 } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'proportion-type');
  assert.equal(result.issues[0].severity, 'error');
  assert.equal(result.valid, false);
});

test('type "integer_fraction" enforces the same whole-number rule as "fraction"', () => {
  const result = validateRuntimeValues(form('integer_fraction'), { ratio_field: { numerator: 3, denominator: 4.2 } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'proportion-type');
});

test('type "fraction" with two genuine whole numbers produces no issues at all', () => {
  const result = validateRuntimeValues(form('fraction'), { ratio_field: { numerator: 3, denominator: 4 } });
  assert.deepEqual(result.issues, []);
});

test('type "ratio" never enforces whole numbers - only the universal denominator ≠ 0 invariant applies', () => {
  const result = validateRuntimeValues(form('ratio'), { ratio_field: { numerator: 1.5, denominator: 3.7 } });
  assert.deepEqual(result.issues, []);
});

test('a non-numeric numerator is a plain type error, same message family as a malformed quantity', () => {
  const result = validateRuntimeValues(form('unitary'), { ratio_field: { numerator: 'abc' } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'type');
});

// An explicitly-present but garbage denominator (as opposed to a genuinely
// absent one, which 'unitary'/'percent' correctly imply a value for) must
// not silently fall through as if nothing were there - proportionDenominator()
// only treats a raw denominator as "absent" when it's literally undefined,
// never when it's present-but-unparseable.
test('an explicit non-numeric denominator is a type error even when the type would otherwise imply one', () => {
  const result = validateRuntimeValues(form('unitary'), { ratio_field: { numerator: 0.5, denominator: 'xyz' } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'type');
});

test('required still applies to a completely empty proportion field before any of the above ever runs', () => {
  const requiredForm = form('unitary');
  requiredForm.layout.children[0].children[0].required = true;
  const result = validateRuntimeValues(requiredForm, {});
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'required');
});
