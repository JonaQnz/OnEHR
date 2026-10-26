const assert = require('node:assert/strict');
const test = require('node:test');
const { validateAgainstBlueprint } = require('../dist/validation/blueprintValidation');

function blueprint(overrides) {
  return {
    resourceType: 'Test', simulationRequired: ['a'], recommended: ['b'], references: {},
    llmMayGenerate: [], llmMayNotGenerate: [], dependencies: [], mayTrigger: [], fields: [],
    ...overrides,
  };
}

test('a missing simulationRequired field is a blocking error', () => {
  const issues = validateAgainstBlueprint(blueprint(), {});
  const error = issues.find((i) => i.field === 'a');
  assert.equal(error.severity, 'error');
});

test('a missing recommended field is only a warning, and does not block', () => {
  const issues = validateAgainstBlueprint(blueprint(), { a: 'x' });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'b');
  assert.equal(issues[0].severity, 'warning');
});

test('nothing is reported once every field is present', () => {
  assert.deepEqual(validateAgainstBlueprint(blueprint(), { a: 'x', b: 'y' }), []);
});
