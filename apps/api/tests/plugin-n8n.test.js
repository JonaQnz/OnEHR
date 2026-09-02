const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { PluginRegistry } = require('plugin-api');
const plugin = require('formbuilder-example-n8n-plugin').default;

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('n8n example plugin provisions a webhook + protocol-adapter workflow from form settings', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : {} });
      const responseBody = req.method === 'GET' && req.url.includes('/workflows/workflow-1')
        ? { id: 'workflow-1', active: true }
        : req.url.includes('/webhook/')
          ? { protocol: 'formbuilder.plugin-hook.v1', data: {}, notices: [], errors: [] }
          : { id: 'workflow-1' };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(responseBody));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const previous = {
    api: process.env.N8N_API_URL,
    key: process.env.N8N_API_KEY,
    public: process.env.N8N_PUBLIC_URL,
  };
  process.env.N8N_API_URL = `http://127.0.0.1:${address.port}/api/v1`;
  process.env.N8N_API_KEY = 'test-key';
  process.env.N8N_PUBLIC_URL = 'http://n8n.test';
  try {
    // The plugin now reads its own settings via `context.getSettings()`
    // (backed by this function, keyed by the plugin's own id) instead of a
    // host-injected `metadata.pluginSettings` - see the
    // `[[hardcoded-example-plugin-settings-fix]]` memory for why.
    const registry = new PluginRegistry(silentLogger, undefined, (pluginId) => (
      pluginId === 'org.example.n8n'
        ? { webhooks: {
          beforeLoad: true, afterLoad: true, beforeSave: true, afterSave: true,
          beforeValidate: true, afterValidate: true, beforeSubmit: true, afterSubmit: true, submit: true,
        } }
        : {}
    ));
    await registry.register(plugin);
    assert.equal(registry.getDataProvider('n8n')?.id, 'n8n', 'the plugin registers its own n8n FormDataProvider, not apps/api');
    const result = await registry.runAction('org.example.n8n', 'org.example.n8n.provision', {
      form: {
        id: 'form-1',
        name: 'Vitals',
        sourceTemplates: [{ id: 'vitals.v1' }],
        settings: { submission: { workflow: { enabledHooks: {
          beforeLoad: true, afterLoad: true, beforeSave: true, afterSave: true,
          beforeValidate: true, afterValidate: true, beforeSubmit: true, afterSubmit: true, submit: true,
        } } } },
      },
      metadata: {},
    });
    assert.equal(result.errors, undefined);
    assert.match(result.message, /erstellt/);
    assert.equal(result.data.settings.submission.mode, 'workflow');
    assert.equal(result.data.settings.submission.providerId, 'n8n');
    assert.equal(result.data.settings.submission.workflow.workflowId, 'workflow-1');
    assert.equal(result.data.settings.submission.workflow.webhookUrl, `http://127.0.0.1:${address.port}/webhook/formbuilder-form-1/submit`);
    assert.equal(result.data.settings.submission.workflow.publicWebhookUrl, 'http://n8n.test/webhook/formbuilder-form-1/submit');
    assert.equal(Object.keys(result.data.settings.submission.workflow.hooks).length, 9);
    assert.equal(result.data.settings.submission.workflow.enabledHooks.submit, true);
    assert.equal(requests.length, 4);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].headers['x-n8n-api-key'], 'test-key');
    assert.equal(requests[0].body.nodes[0].name, 'Form Webhook');
    assert.equal(requests[0].body.nodes.at(-1).name, 'Submit Hook Response');
    assert.equal(requests[0].body.nodes[0].parameters.responseMode, 'lastNode');
    assert.equal(requests[1].method, 'POST');
    assert.equal(requests[1].url, '/api/v1/workflows/workflow-1/activate');
    assert.equal(requests[1].headers['x-n8n-api-key'], 'test-key');
    assert.equal(requests[2].method, 'GET');
    assert.equal(requests[3].method, 'POST');
    assert.match(requests[3].url, /\/webhook\/formbuilder-form-1\/submit$/);
    assert.equal(registry.unregister('org.example.n8n'), true);
  } finally {
    for (const [name, value] of Object.entries({ N8N_API_URL: previous.api, N8N_API_KEY: previous.key, N8N_PUBLIC_URL: previous.public })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
