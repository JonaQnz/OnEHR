const assert = require('node:assert/strict');
const test = require('node:test');
const { withTimeout } = require('../dist');

test('withTimeout resolves with the original value when the promise settles first', async () => {
  const result = await withTimeout(Promise.resolve('done'), 50, () => 'op');
  assert.equal(result, 'done');
});

test('withTimeout rejects with the original error when the promise rejects first', async () => {
  await assert.rejects(
    withTimeout(Promise.reject(new Error('boom')), 50, () => 'op'),
    /boom/,
  );
});

test('withTimeout rejects on its own once the deadline passes, even if the promise never settles', async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    withTimeout(never, 20, () => 'the hung operation'),
    /the hung operation timed out after 20ms/,
  );
});
