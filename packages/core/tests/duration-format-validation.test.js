const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRuntimeValues } = require('../dist');

// DV_DURATION.value is "ISO8601 duration" (RM Data Types IM §6.3) - until
// now, input-duration had no dedicated validation branch at all (it falls
// through to whatever the generic text-ish checks are, none of which check
// duration shape), so a clinician typing "3 days" or "72h" reached EHRbase
// unvalidated. See docs/features/rm-type-spec-conformance.md #3.
function form() {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [{ type: 'input-duration', id: 'total_duration', label: 'Total duration' }],
      }],
    },
  };
}

test('a plain days-only duration is valid', () => {
  const result = validateRuntimeValues(form(), { total_duration: 'P3D' });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('a combined date+time duration is valid', () => {
  const result = validateRuntimeValues(form(), { total_duration: 'P1Y2M3DT4H5M6S' });
  assert.deepEqual(result.issues, []);
});

test('a time-only duration (PT...) is valid', () => {
  const result = validateRuntimeValues(form(), { total_duration: 'PT4H30M' });
  assert.deepEqual(result.issues, []);
});

test('a fractional seconds component is valid', () => {
  const result = validateRuntimeValues(form(), { total_duration: 'PT1.5S' });
  assert.deepEqual(result.issues, []);
});

// The RM's own documented deviation from strict ISO 8601: "the 'W'
// designator [may be] mixed with other designators" - strict ISO 8601 only
// allows P<n>W on its own. A regex copied verbatim from a generic ISO-8601
// library would wrongly reject this.
test('the W (week) designator mixed with other designators is valid - the RM\'s own documented ISO 8601 deviation', () => {
  const result = validateRuntimeValues(form(), { total_duration: 'P1Y2W3D' });
  assert.deepEqual(result.issues, []);
});

test('a week-only duration is valid', () => {
  const result = validateRuntimeValues(form(), { total_duration: 'P2W' });
  assert.deepEqual(result.issues, []);
});

test('free-text nonsense is a blocking (not warning) format error', () => {
  const result = validateRuntimeValues(form(), { total_duration: '3 days' });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'duration-format');
  assert.equal(result.issues[0].severity, undefined, 'no severity field means the default hard-error, not a warning');
  assert.equal(result.valid, false);
});

test('a bare unit shorthand like "72h" is rejected (missing the P prefix)', () => {
  const result = validateRuntimeValues(form(), { total_duration: '72h' });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'duration-format');
  assert.equal(result.valid, false);
});

test('"P" alone (no designators at all) is rejected', () => {
  const result = validateRuntimeValues(form(), { total_duration: 'P' });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'duration-format');
});

test('"PT" alone (T with nothing after it) is rejected', () => {
  const result = validateRuntimeValues(form(), { total_duration: 'PT' });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'duration-format');
});

test('lowercase designators are rejected - ISO 8601 designators are uppercase-only', () => {
  const result = validateRuntimeValues(form(), { total_duration: 'p3d' });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'duration-format');
});

test('an empty value is caught by the ordinary required/empty check, not duration-format', () => {
  const result = validateRuntimeValues(form(), { total_duration: '' });
  assert.deepEqual(result.issues, [], 'field is not required, so an empty value produces no issue at all');
});

test('a required, empty duration field still reports "required", not "duration-format"', () => {
  const required = {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [{ type: 'input-duration', id: 'total_duration', label: 'Total duration', required: true }],
      }],
    },
  };
  const result = validateRuntimeValues(required, {});
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'required');
});
