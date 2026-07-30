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
    id: 'org.example.connector',
    version: '1.0.0',
    apiVersion: '1.0',
    name: 'Connector plugin',
    extensionPoints: ['scripting'],
    permissions: ['patient:read'],
    ...overrides,
  };
}

test('registers permission-scoped scripting operations as isolated plugin actions', async () => {
  const registry = new PluginRegistry(silentLogger);
  await registry.register({
    manifest: manifest(),
    activate(context) {
      context.registerScriptingOperation({
        key: 'connector.lookup',
        operationId: 'lookup',
        label: 'Lookup patient',
        permissions: ['patient:read'],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      }, ({ data }) => ({ data: { patientId: data.patientId } }));
    },
  });

  const contribution = registry.getContributions()[0];
  assert.equal(contribution.extensionPoint, 'scripting');
  assert.equal(contribution.actionId, 'scripting.lookup');
  const result = await registry.runAction(
    'org.example.connector',
    'scripting.lookup',
    { form: {}, data: { patientId: 'patient-1' } },
  );
  assert.deepEqual(result.data, { patientId: 'patient-1' });
});

test('rejects scripting operation permissions missing from the plugin manifest', async () => {
  const registry = new PluginRegistry(silentLogger);
  await assert.rejects(registry.register({
    manifest: manifest({
      id: 'org.example.connector-permissions',
      permissions: [],
    }),
    activate(context) {
      context.registerScriptingOperation({
        key: 'connector.lookup',
        operationId: 'lookup',
        label: 'Lookup patient',
        permissions: ['network:request'],
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      }, () => ({ data: {} }));
    },
  }), /undeclared permission network:request/);
});
