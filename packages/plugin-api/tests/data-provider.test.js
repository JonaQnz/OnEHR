const assert = require('node:assert/strict');
const test = require('node:test');
const { PluginRegistry } = require('../dist');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function fakeProvider(id, overrides = {}) {
  return {
    id,
    displayName: `Provider ${id}`,
    capabilities: ['submit'],
    async load() { throw new Error('not supported'); },
    async submit() { return { providerId: id }; },
    ...overrides,
  };
}

test('registerFormDataProvider makes the provider reachable via getDataProvider, and derives its metadata contribution automatically', async () => {
  const registry = new PluginRegistry(silentLogger);
  await registry.register({
    manifest: { id: 'org.test.provider', version: '1.0.0', apiVersion: '1.0', name: 'Test Provider', extensionPoints: ['dataProvider'] },
    activate(context) { context.registerFormDataProvider(fakeProvider('acme')); },
  });
  const provider = registry.getDataProvider('acme');
  assert.equal(provider.id, 'acme');
  assert.equal(registry.listDataProviders().length, 1);
  const contribution = registry.getContributions().find((entry) => entry.extensionPoint === 'dataProvider' && entry.key === 'acme');
  assert.equal(contribution.providerId, 'acme');
  assert.equal(contribution.label, 'Provider acme');
  assert.deepEqual(contribution.capabilities, ['submit']);
});

test('registerFormDataProvider requires the dataProvider extension point to be declared, same as any other contribution', async () => {
  const registry = new PluginRegistry(silentLogger);
  await assert.rejects(
    registry.register({
      manifest: { id: 'org.test.noext', version: '1.0.0', apiVersion: '1.0', name: 'No Extension Point', extensionPoints: ['settings'] },
      activate(context) { context.registerFormDataProvider(fakeProvider('acme')); },
    }),
    /has not declared dataProvider/,
  );
});

test('registerFormDataProvider rejects a duplicate provider id, whether from the same or a different plugin', async () => {
  const registry = new PluginRegistry(silentLogger);
  await registry.register({
    manifest: { id: 'org.test.first', version: '1.0.0', apiVersion: '1.0', name: 'First', extensionPoints: ['dataProvider'] },
    activate(context) { context.registerFormDataProvider(fakeProvider('acme')); },
  });
  await assert.rejects(
    registry.register({
      manifest: { id: 'org.test.second', version: '1.0.0', apiVersion: '1.0', name: 'Second', extensionPoints: ['dataProvider'] },
      activate(context) { context.registerFormDataProvider(fakeProvider('acme')); },
    }),
    /already registered/,
  );
});

test('unregister removes a plugin\'s own data providers, not another plugin\'s', async () => {
  const registry = new PluginRegistry(silentLogger);
  await registry.register({
    manifest: { id: 'org.test.a', version: '1.0.0', apiVersion: '1.0', name: 'A', extensionPoints: ['dataProvider'] },
    activate(context) { context.registerFormDataProvider(fakeProvider('a-provider')); },
  });
  await registry.register({
    manifest: { id: 'org.test.b', version: '1.0.0', apiVersion: '1.0', name: 'B', extensionPoints: ['dataProvider'] },
    activate(context) { context.registerFormDataProvider(fakeProvider('b-provider')); },
  });
  registry.unregister('org.test.a');
  assert.equal(registry.getDataProvider('a-provider'), undefined);
  assert.equal(registry.getDataProvider('b-provider').id, 'b-provider');
});

test('getSettings() reads this plugin\'s own persisted settings by its own manifest id, generically - not one hardcoded plugin', async () => {
  const settingsByPlugin = { 'org.test.one': { apiKey: 'one-key' }, 'org.test.two': { apiKey: 'two-key' } };
  const registry = new PluginRegistry(silentLogger, undefined, (pluginId) => settingsByPlugin[pluginId] || {});
  const seen = {};
  await registry.register({
    manifest: { id: 'org.test.one', version: '1.0.0', apiVersion: '1.0', name: 'One', extensionPoints: ['lifecycle'] },
    activate(context) {
      context.registerHook('beforeLoad', () => { seen.one = context.getSettings(); return {}; });
    },
  });
  await registry.register({
    manifest: { id: 'org.test.two', version: '1.0.0', apiVersion: '1.0', name: 'Two', extensionPoints: ['lifecycle'] },
    activate(context) {
      context.registerHook('beforeLoad', () => { seen.two = context.getSettings(); return {}; });
    },
  });
  await registry.runHook('beforeLoad', { form: {} });
  assert.deepEqual(seen.one, { apiKey: 'one-key' });
  assert.deepEqual(seen.two, { apiKey: 'two-key' });
});

test('getSettings() returns {} when the registry was constructed with no settings source at all', async () => {
  const registry = new PluginRegistry(silentLogger);
  let observed;
  await registry.register({
    manifest: { id: 'org.test.none', version: '1.0.0', apiVersion: '1.0', name: 'None', extensionPoints: ['lifecycle'] },
    activate(context) {
      context.registerHook('beforeLoad', () => { observed = context.getSettings(); return {}; });
    },
  });
  await registry.runHook('beforeLoad', { form: {} });
  assert.deepEqual(observed, {});
});
