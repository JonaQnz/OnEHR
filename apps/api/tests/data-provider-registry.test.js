const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'formbuilder-data-provider-test-'));
process.env.DATA_DIR = dataDir;

const { loadPluginPackage, unloadPluginPackage } = require('../dist/plugins/pluginRegistry');
const { dataProviderRegistry, getDataProvider } = require('../dist/services/dataProviderRegistry');

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// This is the exact regression this refactor fixes: n8n submission support
// used to be a core, always-registered provider (`n8nDataProvider.ts`) that
// only worked when this "example" plugin happened to be loaded - which it
// isn't by default. Now the provider is only reachable when the plugin
// providing it is actually installed, exactly like any other plugin
// capability. See the `[[n8n-provider-moved-into-plugin]]` memory.
test('a data provider registered by a plugin is not reachable before the plugin loads, and is reachable (and gone again) around its lifecycle', async () => {
  assert.throws(() => getDataProvider('n8n'), /Unknown data provider: n8n/);
  assert.equal(dataProviderRegistry.list().some((provider) => provider.id === 'n8n'), false);

  await loadPluginPackage('formbuilder-example-n8n-plugin');
  try {
    const provider = getDataProvider('n8n');
    assert.equal(provider.id, 'n8n');
    assert.equal(provider.displayName, 'n8n Workflow');
    assert.deepEqual(dataProviderRegistry.list().find((entry) => entry.id === 'n8n'), { id: 'n8n', displayName: 'n8n Workflow', capabilities: ['submit'] });
    // The always-on built-in provider is unaffected either way.
    assert.equal(getDataProvider('ehrbase').id, 'ehrbase');
  } finally {
    unloadPluginPackage('formbuilder-example-n8n-plugin');
  }

  assert.throws(() => getDataProvider('n8n'), /Unknown data provider: n8n/);
});
