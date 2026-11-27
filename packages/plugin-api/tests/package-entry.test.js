const assert = require('node:assert/strict');
const test = require('node:test');

const EXPECTED_RUNTIME_EXPORTS = [
  'PLUGIN_API_VERSION',
  'PLUGIN_EXTENSION_POINTS',
  'PLUGIN_HOST_INFO',
  'PLUGIN_PERMISSIONS',
  'PluginRegistry',
  'defineFunctionPackage',
  'withTimeout',
];

test('package entry exposes exactly the documented runtime exports', () => {
  const keys = Object.keys(require('plugin-api')).filter((key) => key !== '__esModule');
  assert.deepEqual(keys.sort(), [...EXPECTED_RUNTIME_EXPORTS].sort());
});

test('deep dist imports are rejected by the exports map', () => {
  assert.throws(
    () => require('plugin-api/dist/registry'),
    (error) => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  );
});

test('internal modules are not the public contract', () => {
  const manifest = require('../dist/manifest');
  assert.equal(manifest.PluginRegistry, undefined);
  assert.equal(manifest.withTimeout, undefined);
  const registry = require('../dist/registry');
  assert.equal(registry.validateManifest, undefined);
});

test('plugin lifecycle works through the package entry', async () => {
  const { PluginRegistry } = require('plugin-api');
  const registry = new PluginRegistry();
  await registry.register({
    manifest: { id: 'test.entry', version: '1.0.0', apiVersion: '1.0', name: 'T', extensionPoints: ['lifecycle'] },
    activate(context) {
      context.registerHook('beforeSave', () => ({ data: { ok: true } }));
    },
  });
  const result = await registry.runHook('beforeSave', { form: {} });
  assert.deepEqual(result.data, { ok: true });
  assert.equal(registry.getManifests().length, 1);
});
