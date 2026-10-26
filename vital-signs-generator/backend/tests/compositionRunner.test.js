const assert = require('node:assert/strict');
const test = require('node:test');
const { runGeneration } = require('../dist/backend/src/engine/submission/compositionRunner');

const scenario = {
  id: 's', startTime: '2026-01-01T00:00:00.000Z', durationIso: 'PT30M', defaultSamplingInterval: 'PT15M', seed: 1,
  tracks: [{ id: 't1', type: 'heartRate', signalModel: { kind: 'constant', value: 70 } }],
};

const adapter = {
  formSectionId: 'form-1', compositionFormId: 'comp-1', blockId: 'vitals_block',
  toFormSessionValues: (tp) => ({ context_start_time: tp.timestamp, hr_rate: { magnitude: 70, unit: '/min' } }),
};

function fakeApi(calls, { failOn } = {}) {
  let compositionCounter = 0;
  let sessionCounter = 0;
  return {
    post: async (path, body) => {
      calls.push({ method: 'POST', path, body });
      if (path === '/api/composition-sessions') return { id: `comp-session-${compositionCounter++}` };
      if (path === '/api/form-sessions') return { id: `form-session-${sessionCounter++}` };
      if (path.endsWith('/provider/submit') && failOn && path.includes(failOn)) throw new Error('simulated submit failure');
      return {};
    },
    put: async (path, body) => { calls.push({ method: 'PUT', path, body }); return {}; },
    patch: async (path, body) => { calls.push({ method: 'PATCH', path, body }); return {}; },
    get: async (path) => { calls.push({ method: 'GET', path }); return {}; },
  };
}

test('one fresh composition-session + form-session pair per timepoint, never a shared/reused session', async () => {
  const calls = [];
  const results = await runGeneration(fakeApi(calls), adapter, scenario, { patientId: 'p1', ehrId: 'ehr1' });

  assert.equal(results.length, 3); // 00:00, 00:15, 00:30
  assert.ok(results.every((r) => r.status === 'ok'));
  const compositionSessionIds = results.map((r) => r.compositionSessionId);
  assert.equal(new Set(compositionSessionIds).size, 3, 'every timepoint must get its own composition session');
  const formSessionIds = results.map((r) => r.formSessionId);
  assert.equal(new Set(formSessionIds).size, 3, 'every timepoint must get its own form session');

  // Each timepoint used forceNew:true.
  const compositionPosts = calls.filter((c) => c.path === '/api/composition-sessions');
  assert.equal(compositionPosts.length, 3);
  for (const call of compositionPosts) assert.equal(call.body.forceNew, true);
});

test('a failed timepoint (after one retry) is recorded and the loop continues, not aborted', async () => {
  const calls = [];
  // Fail every submit call - simulates a persistently broken timepoint (e.g. always the 2nd one).
  const api = fakeApi(calls, { failOn: '/provider/submit' });
  const results = await runGeneration(api, adapter, scenario, { patientId: 'p1', ehrId: 'ehr1' });

  assert.equal(results.length, 3, 'all 3 timepoints must still be attempted despite failures');
  assert.ok(results.every((r) => r.status === 'error'));
  for (const r of results) assert.ok(r.error && r.error.includes('simulated submit failure'));
});

test('progress callback reports completed/total incrementally', async () => {
  const calls = [];
  const progressSnapshots = [];
  await runGeneration(fakeApi(calls), adapter, scenario, { patientId: 'p1', ehrId: 'ehr1' }, (progress) => {
    progressSnapshots.push({ completed: progress.completed, total: progress.total });
  });
  assert.deepEqual(progressSnapshots, [{ completed: 1, total: 3 }, { completed: 2, total: 3 }, { completed: 3, total: 3 }]);
});
