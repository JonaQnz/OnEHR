const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PendingTaskStore } = require('../dist/activity/pendingTasks');

// The real order lifecycle (user's own ask: "Aufgaben des Arztes werden erst
// ausgeführt, wenn Pflege zu der Person kommt") - see scenario/engine.ts's
// filePendingResultIfRequested/executePendingTasks for how a doctor's order
// files one of these, and how a later nursing-round consumes it.

function freshStore() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csw-pendingtasks-'));
  return new PendingTaskStore(dataDir, 'run-1');
}

test('fileFor creates a pending task with the given payload, listed by listPending', () => {
  const store = freshStore();
  const task = store.fileFor({
    kind: 'lab-value', description: 'Hb-Kontrolle', orderedByRole: 'doctor', orderEventId: 'order-1',
    patientScenarioKey: 'patient-x', payload: { analyteName: 'Hämoglobin', value: 10.8, unit: 'g/dL' },
  });
  assert.equal(task.status, 'pending');
  assert.equal(task.reviewedByDoctor, false);
  const pending = store.listPending('patient-x');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, task.id);
});

test('listPending/listUnreviewedDone are scoped per patientScenarioKey', () => {
  const store = freshStore();
  store.fileFor({ kind: 'lab-value', description: 'x', orderedByRole: 'doctor', orderEventId: 'o1', patientScenarioKey: 'patient-a', payload: {} });
  store.fileFor({ kind: 'lab-value', description: 'y', orderedByRole: 'doctor', orderEventId: 'o2', patientScenarioKey: 'patient-b', payload: {} });
  assert.equal(store.listPending('patient-a').length, 1);
  assert.equal(store.listPending('patient-b').length, 1);
  assert.equal(store.listPending('patient-c').length, 0);
});

test('complete() moves a task from pending to done, and listUnreviewedDone picks it up', () => {
  const store = freshStore();
  const task = store.fileFor({ kind: 'medication-administration', description: 'x', orderedByRole: 'doctor', orderEventId: 'o1', patientScenarioKey: 'patient-x', payload: {} });
  assert.equal(store.listUnreviewedDone('patient-x').length, 0, 'not done yet - must not appear as reviewable');
  store.complete(task.id, 'execution-event-1');
  assert.equal(store.listPending('patient-x').length, 0);
  const unreviewed = store.listUnreviewedDone('patient-x');
  assert.equal(unreviewed.length, 1);
  assert.equal(unreviewed[0].completedByEventId, 'execution-event-1');
});

test('markReviewed removes a task from listUnreviewedDone permanently', () => {
  const store = freshStore();
  const task = store.fileFor({ kind: 'lab-value', description: 'x', orderedByRole: 'doctor', orderEventId: 'o1', patientScenarioKey: 'patient-x', payload: {} });
  store.complete(task.id, 'exec-1');
  store.markReviewed(task.id);
  assert.equal(store.listUnreviewedDone('patient-x').length, 0);
});
