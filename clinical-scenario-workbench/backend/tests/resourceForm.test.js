const assert = require('node:assert/strict');
const test = require('node:test');
const { validateAgainstForm } = require('../dist/fhir/resourceForm');

function form(fields) {
  return { id: 'test', resourceType: 'Test', version: 1, fields, createdBy: 'system', editable: true };
}

test('a missing required field is reported, an empty optional one is not', () => {
  const f = form([
    { path: 'a', label: 'A', type: 'text', required: true, editable: true, sourcePolicy: 'scenario' },
    { path: 'b', label: 'B', type: 'text', required: false, editable: true, sourcePolicy: 'scenario' },
  ]);
  const issues = validateAgainstForm(f, { b: '' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].path, 'a');
});

test('type checks only run once a value is actually present', () => {
  const f = form([{ path: 'n', label: 'N', type: 'number', required: false, editable: true, sourcePolicy: 'scenario' }]);
  assert.deepEqual(validateAgainstForm(f, {}), []);
  assert.deepEqual(validateAgainstForm(f, { n: 5 }), []);
  assert.equal(validateAgainstForm(f, { n: 'five' }).length, 1);
});

test('a select field value must be one of its configured options', () => {
  const f = form([{
    path: 'gender', label: 'Gender', type: 'select', required: true, editable: true, sourcePolicy: 'scenario',
    options: [{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }],
  }]);
  assert.deepEqual(validateAgainstForm(f, { gender: 'male' }), []);
  assert.equal(validateAgainstForm(f, { gender: 'martian' }).length, 1);
});
