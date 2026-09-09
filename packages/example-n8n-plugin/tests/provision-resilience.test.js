const assert = require('node:assert/strict');
const test = require('node:test');
const { PluginRegistry } = require('plugin-api');
const plugin = require('../dist').default;

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function formWithWorkflow(workflowId) {
  return {
    id: 'form-1',
    settings: {
      submission: {
        providerId: 'ehrbase',
        workflow: {
          engine: 'n8n',
          workflowId,
          webhookUrl: 'http://n8n.test/webhook/formbuilder-form-1/submit',
          hooks: { submit: 'http://n8n.test/webhook/formbuilder-form-1/submit' },
          enabledHooks: { submit: true },
        },
      },
    },
  };
}

// Live-reported bug (2026-09-09): deleting a workflow directly in n8n left
// the Form Builder side unaware - "Als n8n Form konfigurieren" kept trying
// to PUT/update the now-gone workflowId, and n8n answered with a confusing
// "You do not have permission to update this workflow. Ask the owner to
// share it with you." 404 instead of anything actionable. Covers both the
// new read-only status check (org.example.n8n.status, backs the Designer's
// live toggle - see PluginHost.tsx) and the provision action's own
// resilience (transparently creating a fresh workflow instead of failing).
test('status: no workflowId configured at all reports inactive, not an error - the everyday "never configured" case', async () => {
  const registry = new PluginRegistry(silentLogger, undefined, () => ({ apiKey: 'test-key' }));
  await registry.register(plugin);
  const result = await registry.runAction('org.example.n8n', 'org.example.n8n.status', { form: { id: 'form-1', settings: {} } });
  assert.deepEqual(result.data, { active: false });
  assert.equal(result.errors, undefined);
});

test('status: a workflowId that still exists on n8n reports active', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(url, /\/workflows\/wf-123$/);
    return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'wf-123', active: true }) };
  };
  try {
    const registry = new PluginRegistry(silentLogger, undefined, () => ({ apiKey: 'test-key' }));
    await registry.register(plugin);
    const result = await registry.runAction('org.example.n8n', 'org.example.n8n.status', { form: formWithWorkflow('wf-123') });
    assert.deepEqual(result.data, { active: true });
  } finally { global.fetch = originalFetch; }
});

test('status: a workflowId that n8n no longer knows about (deleted directly in n8n) reports inactive', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ status: 404, ok: false, text: async () => '{"message":"Not Found"}' });
  try {
    const registry = new PluginRegistry(silentLogger, undefined, () => ({ apiKey: 'test-key' }));
    await registry.register(plugin);
    const result = await registry.runAction('org.example.n8n', 'org.example.n8n.status', { form: formWithWorkflow('wf-deleted') });
    assert.deepEqual(result.data, { active: false });
  } finally { global.fetch = originalFetch; }
});

test('status: a transient check failure (network error) never reports a real workflow as inactive', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('network unreachable'); };
  try {
    const registry = new PluginRegistry(silentLogger, undefined, () => ({ apiKey: 'test-key' }));
    await registry.register(plugin);
    const result = await registry.runAction('org.example.n8n', 'org.example.n8n.status', { form: formWithWorkflow('wf-123') });
    assert.equal(result.data.active, true, 'a check that could not complete must never flip a real workflowId to "off"');
    assert.match(result.data.checkError, /nicht geprüft werden/);
  } finally { global.fetch = originalFetch; }
});

// Both provision tests below also exercise verifyWorkflowPublished's own
// preflight (submit is enabled in formWithWorkflow) - a second GET on the
// (now-current) workflow id, plus a POST to the webhook itself - so the
// mock has to serve that whole real sequence, not just the create/update
// step, keyed by exact URL rather than broad method matching (both the
// resilience pre-check and the preflight re-check are parameterless GETs).
test('provision: a stored workflowId that n8n 404s on transparently creates a fresh workflow instead of failing', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const method = options?.method || 'GET';
    calls.push({ url, method });
    if (method === 'GET' && url.endsWith('/workflows/wf-deleted')) return { status: 404, ok: false, text: async () => '{"message":"Not Found"}' };
    if (method === 'PUT') return { status: 404, ok: false, text: async () => '{"message":"You do not have permission to update this workflow. Ask the owner to share it with you."}' };
    if (method === 'POST' && url.endsWith('/workflows')) return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'wf-new' }) };
    if (method === 'POST' && url.endsWith('/workflows/wf-new/activate')) return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'wf-new', active: true }) };
    if (method === 'GET' && url.endsWith('/workflows/wf-new')) return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'wf-new', active: true }) };
    if (method === 'POST' && url.includes('webhook')) return { status: 200, ok: true, text: async () => '{}' };
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  try {
    const registry = new PluginRegistry(silentLogger, undefined, () => ({ apiKey: 'test-key', webhooks: { submit: true } }));
    await registry.register(plugin);
    const result = await registry.runAction('org.example.n8n', 'org.example.n8n.provision', { form: formWithWorkflow('wf-deleted') });
    assert.equal(result.errors, undefined, JSON.stringify(result));
    assert.equal(result.data.settings.submission.workflow.workflowId, 'wf-new');
    assert.match(result.message, /erstellt/, 'must report this as a fresh creation, not an update, since the old workflow was gone');
    assert.ok(!calls.some((call) => call.method === 'PUT'), 'must never attempt to PUT/update a workflow already known to be deleted');
  } finally { global.fetch = originalFetch; }
});

test('provision: a workflowId that still genuinely exists is updated in place (PUT), unaffected by the resilience check', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const method = options?.method || 'GET';
    calls.push({ url, method });
    if (method === 'GET' && url.endsWith('/workflows/wf-123')) return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'wf-123', active: true }) };
    if (method === 'PUT') return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'wf-123' }) };
    if (method === 'POST' && url.endsWith('/workflows/wf-123/activate')) return { status: 200, ok: true, text: async () => JSON.stringify({ id: 'wf-123', active: true }) };
    if (method === 'POST' && url.includes('webhook')) return { status: 200, ok: true, text: async () => '{}' };
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  };
  try {
    const registry = new PluginRegistry(silentLogger, undefined, () => ({ apiKey: 'test-key', webhooks: { submit: true } }));
    await registry.register(plugin);
    const result = await registry.runAction('org.example.n8n', 'org.example.n8n.provision', { form: formWithWorkflow('wf-123') });
    assert.equal(result.errors, undefined, JSON.stringify(result));
    assert.equal(result.data.settings.submission.workflow.workflowId, 'wf-123');
    assert.match(result.message, /aktualisiert/);
    assert.ok(calls.some((call) => call.method === 'PUT'));
  } finally { global.fetch = originalFetch; }
});
