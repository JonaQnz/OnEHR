const assert = require('node:assert/strict');
const test = require('node:test');
const { ensureOpenEhrCapability } = require('../dist/openehr/capabilityBridge');

function fakeApi() {
  const calls = [];
  return {
    calls,
    post: async (path, body) => {
      calls.push({ method: 'POST', path, body });
      if (path === '/api/composition-sessions') return { id: 'comp-session-1' };
      if (path === '/api/form-sessions') return { id: 'form-session-1' };
      if (path.endsWith('/provider/submit')) return { providerReference: 'composition-uid::123::1' };
      throw new Error(`unexpected POST ${path}`);
    },
    put: async (path, body) => {
      calls.push({ method: 'PUT', path, body });
      return { blocks: { 'vitals_block': { childSessionId: body.childSessionId } } };
    },
  };
}

const config = {
  compositionFormId: 'composition-form-1',
  blockId: 'vitals_block',
  formSectionFormId: 'form-section-1',
  forceNewComposition: true,
};

test('runs start-composition -> create-form-session (with compositionContext) -> attach-block -> submit, in order', async () => {
  const api = fakeApi();
  const result = await ensureOpenEhrCapability(api, config, { id: 'patient-1' }, { hr_rate: { magnitude: 108, unit: '/min' } });

  assert.deepEqual(api.calls.map((c) => `${c.method} ${c.path}`), [
    'POST /api/composition-sessions',
    'POST /api/form-sessions',
    'PUT /api/composition-sessions/comp-session-1/blocks/vitals_block',
    'POST /api/form-sessions/form-session-1/provider/submit',
  ]);
  assert.equal(result.compositionSessionId, 'comp-session-1');
  assert.equal(result.formSessionId, 'form-session-1');
  assert.equal(result.providerReference, 'composition-uid::123::1');
});

test('the form session is created with the right compositionContext and pre-filled values', async () => {
  const api = fakeApi();
  await ensureOpenEhrCapability(api, config, { id: 'patient-1' }, { hr_rate: { magnitude: 108, unit: '/min' } });
  const createFormSessionCall = api.calls.find((c) => c.path === '/api/form-sessions');
  assert.equal(createFormSessionCall.body.formId, 'form-section-1');
  assert.equal(createFormSessionCall.body.patientId, 'patient-1');
  assert.deepEqual(createFormSessionCall.body.compositionContext, { compositionSessionId: 'comp-session-1', blockId: 'vitals_block' });
  assert.deepEqual(createFormSessionCall.body.values, { hr_rate: { magnitude: 108, unit: '/min' } });
});

test('forceNewComposition is passed straight through to start_composition_session', async () => {
  const api = fakeApi();
  await ensureOpenEhrCapability(api, { ...config, forceNewComposition: false }, { id: 'patient-1' }, {});
  const startCompositionCall = api.calls.find((c) => c.path === '/api/composition-sessions');
  assert.equal(startCompositionCall.body.forceNew, false);
});

test('a submit failure (e.g. validation) propagates without attempting anything further', async () => {
  const api = fakeApi();
  const originalPost = api.post;
  api.post = async (path, body) => {
    if (path.endsWith('/provider/submit')) throw new Error('Validation failed: Uhrzeit is required.');
    return originalPost(path, body);
  };
  await assert.rejects(
    () => ensureOpenEhrCapability(api, config, { id: 'patient-1' }, {}),
    /Validation failed/,
  );
});
