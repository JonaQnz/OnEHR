const assert = require('node:assert/strict');
const test = require('node:test');
const { canTransitionFormSession } = require('../dist');

test('enforces the form-session lifecycle', () => {
  assert.equal(canTransitionFormSession('draft', 'in_progress'), true);
  assert.equal(canTransitionFormSession('in_progress', 'ready'), true);
  assert.equal(canTransitionFormSession('ready', 'submitted'), true);
  assert.equal(canTransitionFormSession('draft', 'submitted'), false);
  assert.equal(canTransitionFormSession('submitted', 'in_progress'), false);
});
