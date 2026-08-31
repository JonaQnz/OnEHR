const assert = require('node:assert/strict');
const test = require('node:test');
const { mapWithConcurrency } = require('../dist/services/patientService');

test('runs fn for every item and reports no failures on the happy path', async () => {
  const seen = [];
  const { failures } = await mapWithConcurrency([1, 2, 3], 2, async (item) => { seen.push(item); });
  assert.deepEqual(seen.sort(), [1, 2, 3]);
  assert.deepEqual(failures, []);
});

// QA review finding this supports: syncPatientsFromEhrbase used to run
// fully sequentially with no partial-failure recovery - one flaky EHR
// threw, which aborted the entire batch. mapWithConcurrency isolates each
// item's own failure instead.
test('one item throwing does not abort the rest of the batch', async () => {
  const succeeded = [];
  const { failures } = await mapWithConcurrency([1, 2, 3, 4], 2, async (item) => {
    if (item === 2) throw new Error('EHRbase timeout for item 2');
    succeeded.push(item);
  });
  assert.deepEqual(succeeded.sort(), [1, 3, 4]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].item, 2);
  assert.equal(failures[0].error.message, 'EHRbase timeout for item 2');
});

test('multiple failures are all collected, not just the first', async () => {
  const { failures } = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async (item) => {
    if (item % 2 === 0) throw new Error(`failed on ${item}`);
  });
  assert.deepEqual(failures.map((f) => f.item).sort(), [2, 4]);
});

test('never runs more than `concurrency` callbacks at once', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 10 }, (_, i) => i);
  await mapWithConcurrency(items, 3, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  });
  assert.ok(maxInFlight <= 3, `expected at most 3 concurrent, saw ${maxInFlight}`);
});

test('an empty item list resolves immediately with no failures', async () => {
  const { failures } = await mapWithConcurrency([], 5, async () => { throw new Error('should never be called'); });
  assert.deepEqual(failures, []);
});

test('concurrency higher than the item count does not start extra idle workers', async () => {
  let calls = 0;
  await mapWithConcurrency([1, 2], 10, async () => { calls += 1; });
  assert.equal(calls, 2);
});
