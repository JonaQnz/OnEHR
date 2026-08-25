const assert = require('node:assert/strict');
const test = require('node:test');
const { PluginRegistry } = require('plugin-api');

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function manifest(overrides = {}) {
  return {
    id: 'org.example.vitals',
    version: '1.0.0',
    apiVersion: '1.0',
    name: 'Vitals plugin',
    extensionPoints: ['field', 'settings', 'form', 'renderer', 'workflow', 'lifecycle'],
    ...overrides,
  };
}

test('registers declared extension points and exposes a serializable snapshot', async () => {
  const registry = new PluginRegistry(silentLogger);
  await registry.register({
    manifest: manifest(),
    activate(context) {
      context.registerFieldType({ key: 'vitals.quantity', fieldType: 'quantity', label: 'Vital quantity' });
      context.registerSettingsPanel({ panelId: 'vitals.settings', key: 'vitals.settings', label: 'Vitals settings' });
      context.registerFormAction({ actionId: 'vitals.calculate', key: 'vitals.calculate', label: 'Calculate', placement: 'toolbar' });
      context.registerRenderer({ rendererId: 'vitals.renderer', key: 'vitals.renderer', fieldTypes: ['quantity'] });
      context.registerWorkflow({ workflowId: 'vitals.workflow', key: 'vitals.workflow', label: 'Vitals workflow', trigger: 'beforeSave' });
    },
  });

  const snapshot = registry.snapshot();
  assert.equal(snapshot.apiVersion, '1.0');
  assert.equal(snapshot.plugins.length, 1);
  assert.equal(snapshot.contributions.length, 5);
  assert.equal(snapshot.contributions.find((item) => item.extensionPoint === 'field').pluginId, 'org.example.vitals');
  assert.doesNotThrow(() => JSON.stringify(snapshot));
});

test('exposes the host contract and permission helpers to plugins', async () => {
  const registry = new PluginRegistry(silentLogger);
  let activationContext;
  await registry.register({
    manifest: manifest({ id: 'org.example.permissions', extensionPoints: ['designer'], permissions: ['form:read'] }),
    activate(context) {
      activationContext = context;
    },
  });
  assert.ok(activationContext);
  assert.equal(activationContext.host.apiVersion, '1.0');
  assert.equal(activationContext.host.extensionPoints.includes('designer'), true);
  assert.equal(activationContext.host.extensionPoints.includes('runtime'), true);
  const hostPoints = [...activationContext.host.extensionPoints];
  try { activationContext.host.extensionPoints.push('malicious'); } catch {}
  assert.deepEqual(activationContext.host.extensionPoints, hostPoints);
  assert.equal(activationContext.hasPermission('form:read'), true);
  assert.equal(activationContext.hasPermission('form:write'), false);
  assert.deepEqual(activationContext.permissions, ['form:read']);
  assert.throws(() => activationContext.requirePermission('form:write'), /requires permission/);
  assert.doesNotThrow(() => activationContext.requirePermission('form:read'));
});
test('rejects duplicate manifest permissions', async () => {
  const registry = new PluginRegistry(silentLogger);
  await assert.rejects(
    registry.register({
      manifest: manifest({ id: 'org.example.duplicate-permission', permissions: ['form:read', 'form:read'] }),
      activate() {},
    }),
    /permissions must be unique/,
  );
});
test('runs lifecycle hooks in registration order and carries transformed data forward', async () => {
  const registry = new PluginRegistry(silentLogger);
  await registry.register({
    manifest: manifest({ id: 'org.example.first' }),
    activate(context) {
      context.registerHook('beforeFormSave', ({ data }) => ({ data: { ...data, first: true } }));
    },
  });
  await registry.register({
    manifest: manifest({ id: 'org.example.second' }),
    activate(context) {
      context.registerHook('beforeFormSave', ({ data }) => ({ data: { ...data, second: true } }));
    },
  });

  const result = await registry.runHook('beforeFormSave', { form: {}, data: { original: true } });
  assert.deepEqual(result.data, { original: true, first: true, second: true });
  assert.deepEqual(result.errors, []);
});

test('rejects contributions outside the manifest declaration', async () => {
  const registry = new PluginRegistry(silentLogger);
  await assert.rejects(
    registry.register({
      manifest: manifest({ id: 'org.example.undeclared', extensionPoints: ['field'] }),
      activate(context) {
        context.registerSettingsPanel({ panelId: 'settings', key: 'settings', label: 'Settings' });
      },
    }),
    /has not declared settings/,
  );
  assert.equal(registry.snapshot().plugins.length, 0);
});

test('rejects duplicate plugin ids, contribution keys, and unsupported API versions', async () => {
  const registry = new PluginRegistry(silentLogger);
  const plugin = {
    manifest: manifest({ id: 'org.example.duplicate', extensionPoints: ['field'] }),
    activate(context) {
      context.registerFieldType({ key: 'shared.field', fieldType: 'text', label: 'Shared' });
    },
  };
  await registry.register(plugin);
  await assert.rejects(registry.register(plugin), /already registered/);
  await assert.rejects(
    registry.register({
      manifest: manifest({ id: 'org.example.other', extensionPoints: ['field'] }),
      activate(context) {
        context.registerFieldType({ key: 'shared.field', fieldType: 'text', label: 'Duplicate' });
      },
    }),
    /already registered/,
  );
  assert.equal(registry.snapshot().contributions.length, 1);
  await assert.rejects(
    registry.register({ manifest: manifest({ id: 'org.example.future', apiVersion: '2.0' }), activate() {} }),
    /Plugin API version/,
  );
});

test('unregister removes contributions and lifecycle hooks', async () => {
  const registry = new PluginRegistry(silentLogger);
  await registry.register({
    manifest: manifest({ id: 'org.example.unload', extensionPoints: ['field', 'lifecycle'] }),
    activate(context) {
      context.registerFieldType({ key: 'unload.field', fieldType: 'text', label: 'Unload field' });
      context.registerHook('beforeFormSave', () => ({ data: { removed: true } }));
    },
  });

  assert.equal(registry.unregister('org.example.unload'), true);
  assert.equal(registry.unregister('org.example.unload'), false);
  assert.deepEqual(registry.snapshot().plugins, []);
  assert.deepEqual(registry.snapshot().contributions, []);
  const result = await registry.runHook('beforeFormSave', { form: {}, data: {} });
  assert.deepEqual(result.data, {});
  assert.deepEqual(result.errors, []);
});
test('isolates lifecycle hook failures and continues with later plugins', async () => {
  const registry = new PluginRegistry(silentLogger);
  await registry.register({
    manifest: manifest({ id: 'org.example.failing-hook', extensionPoints: ['lifecycle'] }),
    activate(context) {
      context.registerHook('beforeFormSave', () => {
        throw new Error('boom');
      });
    },
  });
  await registry.register({
    manifest: manifest({ id: 'org.example.following-hook', extensionPoints: ['lifecycle'] }),
    activate(context) {
      context.registerHook('beforeFormSave', ({ data }) => ({ data: { ...(data || {}), continued: true } }));
    },
  });
  const result = await registry.runHook('beforeFormSave', { form: {}, data: {} });
  assert.equal(result.data.continued, true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, 'plugin:org.example.failing-hook');
});

test('a hung activate() times out instead of blocking registration forever', async () => {
  const registry = new PluginRegistry(silentLogger, 20);
  await assert.rejects(
    registry.register({
      manifest: manifest({ id: 'org.example.hung-activate' }),
      activate: () => new Promise(() => {}),
    }),
    /activate\(\) timed out after 20ms/,
  );
  assert.equal(registry.snapshot().plugins.length, 0);
});

test('a hung lifecycle hook times out as a plugin error instead of blocking the hook chain forever', async () => {
  const registry = new PluginRegistry(silentLogger, 20);
  await registry.register({
    manifest: manifest({ id: 'org.example.hung-hook', extensionPoints: ['lifecycle'] }),
    activate(context) {
      context.registerHook('beforeFormSave', () => new Promise(() => {}));
    },
  });
  const result = await registry.runHook('beforeFormSave', { form: {}, data: {} });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, 'plugin:org.example.hung-hook');
});

test('a hung action times out as an error result instead of blocking the caller forever', async () => {
  const registry = new PluginRegistry(silentLogger, 20);
  await registry.register({
    manifest: manifest({ id: 'org.example.hung-action', extensionPoints: ['runtime'] }),
    activate(context) {
      context.registerAction('run', () => new Promise(() => {}));
    },
  });
  const result = await registry.runAction('org.example.hung-action', 'run', {});
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].path, 'plugin:org.example.hung-action');
});

test('aggregates plugin notices, transforms returned data, and stops the hook chain', async () => {
  const registry = new PluginRegistry(silentLogger);
  await registry.register({
    manifest: manifest({ id: 'org.example.notices' }),
    activate(context) {
      context.registerHook('beforeFormSave', () => ({
        data: { normalized: true },
        notices: [{ severity: 'warning', code: 'CHECK', message: 'Bitte prüfen.' }],
        stop: true,
        stopMessage: 'Workflow angehalten.',
      }));
    },
  });
  await registry.register({
    manifest: manifest({ id: 'org.example.after-stop' }),
    activate(context) { context.registerHook('beforeFormSave', () => ({ data: { shouldNotRun: true } })); },
  });
  const result = await registry.runHook('beforeFormSave', { form: {}, data: { original: true } });
  assert.deepEqual(result.data, { normalized: true });
  assert.equal(result.stop, true);
  assert.equal(result.stopMessage, 'Workflow angehalten.');
  assert.deepEqual(result.notices, [{ severity: 'warning', code: 'CHECK', message: 'Bitte prüfen.' }]);
});
