const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskStore } = require('../dist/critic/taskStore');

// Real bug found live wiring the pregnancy-status capability:
// resolveStale reconciles against critiqueScenario's own code set, so a
// manually-filed task (request_missing_form's "missing-form", or
// report_system_critique's "system-critique") whose code that function
// never produces got silently marked resolved on the very next Step,
// regardless of whether the underlying gap was actually addressed.

function freshStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csw-taskstore-'));
  return new TaskStore(dataDir, 'run-1');
}

test('ensure defaults to source "critic" when not specified', () => {
  const tasks = freshStore();
  const { record } = tasks.ensure({ id: 'missing-x:e1', code: 'missing-x', anchorEventId: 'e1', description: 'x' });
  assert.equal(record.source, 'critic');
});

test('resolveStale resolves an open "critic"-source task whose code is no longer current', () => {
  const tasks = freshStore();
  tasks.ensure({ id: 'missing-x:e1', code: 'missing-x', anchorEventId: 'e1', description: 'x' });
  tasks.resolveStale(new Set());
  assert.equal(tasks.list().find((t) => t.id === 'missing-x:e1').status, 'resolved');
});

test('resolveStale NEVER touches a "manual"-source task, even when its code is not in the current set', () => {
  const tasks = freshStore();
  tasks.ensure({ id: 'missing-form:pregnancy-status', code: 'missing-form', anchorEventId: 'capability:pregnancy-status', description: 'x', source: 'manual' });
  tasks.resolveStale(new Set()); // "missing-form" is never a critic code - would have wrongly closed this before the fix
  assert.equal(tasks.list().find((t) => t.id === 'missing-form:pregnancy-status').status, 'open');
});

test('resolve(id) explicitly closes a manual task, and is a no-op for an unknown or already-resolved id', () => {
  const tasks = freshStore();
  tasks.ensure({ id: 'missing-form:x', code: 'missing-form', anchorEventId: 'capability:x', description: 'x', source: 'manual' });
  const resolved = tasks.resolve('missing-form:x');
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolvedAt);
  assert.equal(tasks.resolve('does-not-exist'), undefined);
  const resolvedAgain = tasks.resolve('missing-form:x');
  assert.equal(resolvedAgain.resolvedAt, resolved.resolvedAt, 'resolving an already-resolved task must not bump resolvedAt again');
});
