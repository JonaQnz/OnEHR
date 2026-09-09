const assert = require('node:assert/strict');
const test = require('node:test');
const { PluginRegistry } = require('plugin-api');
const plugin = require('../dist').default;

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

// Live request (2026-09-09): "Diagnose (Basis)" - a clinician hadn't typed
// anything into "Kommentar" yet, so its key was simply absent from `data`;
// n8n had no way to even know the field exists, let alone help fill it in.
// The outgoing webhook payload should carry every top-level field the form
// defines, defaulting untouched ones to null (and an untouched top-level
// repeatable group to []) - but this must NEVER leak into what gets
// persisted back to the session (see the "no data.data in the n8n
// response" fallback, which must still echo the ORIGINAL, unpadded data).

function formWithLayout() {
  return {
    id: 'diag-form',
    settings: {
      submission: {
        providerId: 'ehrbase',
        workflow: {
          engine: 'n8n',
          hooks: { beforeSave: 'http://n8n.test/webhook/diag-form/beforeSave' },
          enabledHooks: { beforeSave: true, submit: false },
        },
      },
    },
    layout: {
      type: 'form',
      children: [
        { id: 'diagnose_name', name: 'diagnose_name', type: 'input-text', label: 'Diagnose' },
        { id: 'diagnose_kommentar', name: 'diagnose_kommentar', type: 'input-text', label: 'Kommentar' },
        {
          id: 'nebendiagnosen', name: 'nebendiagnosen', type: 'container', label: 'Nebendiagnosen', repeatable: true, repeatMin: 0, repeatMax: -1,
          children: [
            { id: 'nebendiagnose_name', name: 'nebendiagnose_name', type: 'input-text', label: 'Diagnose' },
          ],
        },
      ],
    },
  };
}

test('the n8n webhook payload includes every top-level field the form defines, defaulting an untouched one to null', async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ protocol: 'formbuilder.plugin-hook.v1', notices: [], errors: [] }) };
  };
  try {
    const registry = new PluginRegistry(silentLogger, undefined, () => ({ apiKey: 'test-key' }));
    await registry.register(plugin);
    // "diagnose_kommentar" was never typed into - its key is genuinely
    // absent here, exactly like a real session's `values` column.
    await registry.runHook('beforeSave', {
      form: formWithLayout(),
      data: { diagnose_name: 'Test' },
      patientId: 'patient-1',
      sessionId: 'session-1',
      userId: 'alice',
    });

    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].body.data, {
      diagnose_name: 'Test',
      diagnose_kommentar: null,
      nebendiagnosen: [],
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('a value already present (including an explicit null/[] a plugin set) is never overridden by the placeholder', async () => {
  const originalFetch = global.fetch;
  let sentData;
  global.fetch = async (url, options) => {
    sentData = JSON.parse(options.body).data;
    return { ok: true, status: 200, text: async () => JSON.stringify({ protocol: 'formbuilder.plugin-hook.v1', notices: [], errors: [] }) };
  };
  try {
    const registry = new PluginRegistry(silentLogger, undefined, () => ({ apiKey: 'test-key' }));
    await registry.register(plugin);
    await registry.runHook('beforeSave', {
      form: formWithLayout(),
      data: { diagnose_name: 'Test', diagnose_kommentar: 'Bereits ausgefüllt', nebendiagnosen: [{ nebendiagnose_name: 'X' }] },
      patientId: 'patient-1',
      sessionId: 'session-1',
      userId: 'alice',
    });
    assert.equal(sentData.diagnose_kommentar, 'Bereits ausgefüllt');
    assert.deepEqual(sentData.nebendiagnosen, [{ nebendiagnose_name: 'X' }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('padding the outgoing payload never leaks into what gets persisted back to the session when n8n sends no data of its own', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ protocol: 'formbuilder.plugin-hook.v1', notices: [], errors: [] }) });
  try {
    const registry = new PluginRegistry(silentLogger, undefined, () => ({ apiKey: 'test-key' }));
    await registry.register(plugin);
    const original = { diagnose_name: 'Test' };
    const result = await registry.runHook('beforeSave', {
      form: formWithLayout(),
      data: original,
      patientId: 'patient-1',
      sessionId: 'session-1',
      userId: 'alice',
    });
    // Must echo back the ORIGINAL sparse data, not the padded wire payload -
    // padding is scoped to what n8n receives, not what formSessionService
    // persists as the session's new `values`.
    assert.deepEqual(result.data, original);
  } finally {
    global.fetch = originalFetch;
  }
});
