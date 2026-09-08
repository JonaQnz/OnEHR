const assert = require('node:assert/strict');
const test = require('node:test');
const { PluginRegistry } = require('plugin-api');
const plugin = require('../dist').default;

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('lifecycle-only n8n workflow runs while EHRbase remains the submission provider', async () => {
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url, headers: options.headers, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ protocol: 'formbuilder.plugin-hook.v1', data: { checked: true }, notices: [], errors: [] }),
    };
  };

  try {
    const registry = new PluginRegistry(silentLogger, undefined, () => ({ apiKey: 'test-key' }));
    await registry.register(plugin);
    const result = await registry.runHook('beforeSave', {
      form: {
        id: 'form-1',
        settings: {
          submission: {
            providerId: 'ehrbase',
            workflow: {
              engine: 'n8n',
              hooks: { beforeSave: 'http://n8n.test/webhook/form-1/beforeSave' },
              enabledHooks: { beforeSave: true, submit: false },
            },
          },
        },
      },
      data: { checked: false },
      patientId: 'patient-1',
      sessionId: 'session-1',
      userId: 'alice',
    });

    assert.deepEqual(result.data, { checked: true });
    assert.equal(result.errors.length, 0);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://n8n.test/webhook/form-1/beforeSave');
    assert.equal(requests[0].headers['X-N8N-API-KEY'], 'test-key');
    assert.equal(requests[0].body.hook, 'beforeSave');
  } finally {
    global.fetch = originalFetch;
  }
});
