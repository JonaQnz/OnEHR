const assert = require('node:assert/strict');
const test = require('node:test');
const { N8nDataProvider } = require('../dist/dataProvider');

function definition() {
  return {
    id: 'vitals-form',
    name: 'Vitals',
    version: '1.0.0',
    sourceTemplates: [{ alias: 'vitals', id: 'vitals.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    settings: { submission: { mode: 'workflow', providerId: 'n8n', workflow: { engine: 'n8n', webhookUrl: 'http://n8n.test/webhook/vitals' } } },
    layout: { type: 'form', children: [] },
    locales: { en: {} },
    bindings: { weight: { openehr: { flatPath: 'vitals/weight', rmType: 'DV_QUANTITY' } } },
  };
}

test('n8n provider sends the complete standardized submission payload', async () => {
  const calls = [];
  const provider = new N8nDataProvider(() => ({}), {
    http: {
      async post(url, body, options) {
        calls.push({ url, body, options });
        return { status: 200, data: { protocol: 'formbuilder.plugin-hook.v1', executionId: 'execution-1', data: {}, notices: [], errors: [] }, headers: {} };
      },
    },
  });
  const result = await provider.submit({
    context: { patientId: 'patient-1', patientNamespace: 'demo', sessionId: 'session-1', userId: 'alice', authMode: 'hip' },
    form: { id: 'vitals-form', version: '1.0.0', definition: definition() },
    values: { weight: { magnitude: 63, unit: 'kg' } },
  });
  assert.equal(result.providerId, 'n8n');
  assert.equal(result.reference, 'execution-1');
  assert.equal(calls[0].url, 'http://n8n.test/webhook/vitals');
  assert.equal(calls[0].options.headers['X-Formbuilder-Protocol'], 'formbuilder.form-submission.v1');
  assert.equal(calls[0].body.protocol, 'formbuilder.form-submission.v1');
  assert.equal(calls[0].body.patient.id, 'patient-1');
  assert.equal(calls[0].body.session.id, 'session-1');
  assert.equal(calls[0].body.values.weight.magnitude, 63);
  assert.equal(calls[0].body.composition.values['vitals/weight|magnitude'], 63);
  assert.equal(calls[0].body.session.authMode, 'hip');
});

test('n8n provider turns workflow errors into a concrete stopped request', async () => {
  const provider = new N8nDataProvider(() => ({}), {
    http: { async post() { return { status: 200, data: { protocol: 'formbuilder.plugin-hook.v1', errors: [{ message: 'Freigabe fehlt.' }], stop: true }, headers: {} }; } },
  });
  await assert.rejects(
    provider.submit({
      context: { patientId: 'patient-1', sessionId: 'session-1', userId: 'alice', authMode: 'local' },
      form: { id: 'vitals-form', version: '1.0.0', definition: definition() },
      values: {},
    }),
    (error) => error.code === 'N8N_WORKFLOW_STOPPED' && error.status === 422 && /Freigabe fehlt/.test(error.message),
  );
});

// New coverage (this refactor): the provider now reads apiUrl/apiKey through
// an injected getSettings() instead of reaching into apps/api's own
// configService by a hardcoded plugin id - see the
// `[[n8n-provider-moved-into-plugin]]` memory.
test('n8n provider reads apiUrl/apiKey from the injected getSettings(), not a hardcoded host lookup', async () => {
  const withWorkflowId = {
    ...definition(),
    settings: { submission: { mode: 'workflow', providerId: 'n8n', workflow: { engine: 'n8n', workflowId: 'workflow-1', webhookUrl: 'http://n8n.test/webhook/vitals' } } },
  };
  const calls = [];
  const provider = new N8nDataProvider(() => ({ apiUrl: 'http://n8n.internal/api/v1', apiKey: 'secret-key' }), {
    http: { async post(url, body, options) {
      calls.push({ url, body, options });
      return { status: 200, data: { protocol: 'formbuilder.plugin-hook.v1', data: {}, notices: [], errors: [] }, headers: {} };
    } },
  });
  const originalFetch = global.fetch;
  const preflightCalls = [];
  global.fetch = async (url, options) => {
    preflightCalls.push({ url, headers: options.headers });
    return { ok: true, json: async () => ({ active: true }) };
  };
  try {
    await provider.submit({
      context: { patientId: 'patient-1', sessionId: 'session-1', userId: 'alice', authMode: 'local' },
      form: { id: 'vitals-form', version: '1.0.0', definition: withWorkflowId },
      values: {},
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(preflightCalls.length, 1);
  assert.equal(preflightCalls[0].url, 'http://n8n.internal/api/v1/workflows/workflow-1');
  assert.equal(preflightCalls[0].headers['X-N8N-API-KEY'], 'secret-key');
  assert.equal(calls.length, 1, 'the actual submission still goes to the workflow webhook, not the preflight URL');
});

test('n8n provider rejects the preflight check when getSettings() has no apiUrl/apiKey configured at all', async () => {
  const withWorkflowId = {
    ...definition(),
    settings: { submission: { mode: 'workflow', providerId: 'n8n', workflow: { engine: 'n8n', workflowId: 'workflow-1', webhookUrl: 'http://n8n.test/webhook/vitals' } } },
  };
  const provider = new N8nDataProvider(() => ({}), { http: { async post() { throw new Error('should never be called'); } } });
  await assert.rejects(
    provider.submit({
      context: { patientId: 'patient-1', sessionId: 'session-1', userId: 'alice', authMode: 'local' },
      form: { id: 'vitals-form', version: '1.0.0', definition: withWorkflowId },
      values: {},
    }),
    (error) => error.code === 'N8N_PREFLIGHT_NOT_CONFIGURED',
  );
});
