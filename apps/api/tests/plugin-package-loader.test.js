const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'formbuilder-plugin-test-'));
process.env.DATA_DIR = dataDir;
process.env.FORM_BUILDER_PLUGINS = 'formbuilder-example-vitals-plugin,formbuilder-missing-plugin';

const {
  pluginRegistry,
  loadPluginPackage,
  unloadPluginPackage,
  getPluginPackageStatuses,
} = require('../dist/plugins/pluginRegistry');

test.after(() => {
  delete process.env.FORM_BUILDER_PLUGINS;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('loads the example npm plugin and unloads its contributions', async () => {
  const manifest = await loadPluginPackage('formbuilder-example-vitals-plugin');
  assert.equal(manifest.id, 'org.example.vitals');
  assert.equal(pluginRegistry.snapshot().contributions.length, 7);
  assert.deepEqual(pluginRegistry.snapshot().contributions.filter((item) => ['designer', 'runtime', 'dataProvider'].includes(item.extensionPoint)).map((item) => item.extensionPoint).sort(), ['dataProvider', 'designer', 'runtime']);
  assert.equal(getPluginPackageStatuses()[0].enabled, true);
  const widgetPackage = pluginRegistry.snapshot().contributions.find((item) => item.extensionPoint === 'widget');
  assert.equal(widgetPackage.packageId, 'clinical');
  assert.equal(widgetPackage.widgets[0].aqlFunction.packageName, 'laboratory');

  const result = await pluginRegistry.runHook('beforeFormSave', { form: {}, data: {} });
  assert.equal(result.data.extensions['org.example.vitals'].checked, true);

  assert.equal(unloadPluginPackage('formbuilder-example-vitals-plugin'), true);
  assert.equal(pluginRegistry.snapshot().contributions.length, 0);
  assert.equal(getPluginPackageStatuses()[0].enabled, false);
});

test('unloading a plugin package clears it from require.cache so a reload re-requires it, not the stale cached module', async () => {
  await loadPluginPackage('formbuilder-example-vitals-plugin');
  // package.json itself is never require.cache'd (Node reads it directly off
  // disk while resolving, not through the module-cache path) - the entry
  // file require(normalizedName) actually loaded is what to check.
  const entryPath = require.resolve('formbuilder-example-vitals-plugin');
  assert.ok(require.cache[entryPath], 'expected the package entry module to be require-cached after loading');

  assert.equal(unloadPluginPackage('formbuilder-example-vitals-plugin'), true);
  assert.equal(require.cache[entryPath], undefined, 'expected unload to clear the package entry module from require.cache');

  // A reload after unload must still work end-to-end, not just leave the
  // cache empty - this is the actual point of clearing it.
  const manifest = await loadPluginPackage('formbuilder-example-vitals-plugin');
  assert.equal(manifest.id, 'org.example.vitals');
  assert.equal(pluginRegistry.snapshot().contributions.length, 7);
  assert.equal(unloadPluginPackage('formbuilder-example-vitals-plugin'), true);
});

test('keeps a missing configured package visible as an error', async () => {
  await assert.rejects(loadPluginPackage('formbuilder-missing-plugin'), /Unable to load plugin/);
  const status = getPluginPackageStatuses().find((item) => item.packageName === 'formbuilder-missing-plugin');
  assert.equal(status.enabled, false);
  assert.match(status.error, /Unable to load plugin/);
});
