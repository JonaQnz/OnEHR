const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canTransitionFormSession,
  validateRuntimeValues,
} = require('core');

function form() {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [{ type: 'input-text', id: 'name', label: 'Name', required: true }],
      }],
    },
  };
}

test('a draft session can be validated using the shared runtime rules', () => {
  const invalid = validateRuntimeValues(form(), { name: '' });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.issues[0].code, 'required');

  const valid = validateRuntimeValues(form(), { name: 'Ada' });
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.issues, []);
});

test('form-session state transitions prevent direct submission', () => {
  assert.equal(canTransitionFormSession('draft', 'in_progress'), true);
  assert.equal(canTransitionFormSession('in_progress', 'ready'), true);
  assert.equal(canTransitionFormSession('ready', 'submitted'), true);
  assert.equal(canTransitionFormSession('draft', 'submitted'), false);
  assert.equal(canTransitionFormSession('submitted', 'in_progress'), false);
});
