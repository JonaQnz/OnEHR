const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getFormScriptConnectorConfiguration,
  migrateCanonicalFormToV1,
} = require('core');
const {
  hydrateFormScriptConnectors,
  ScriptConnectorError,
  ScriptConnectorRegistry,
} = require('../dist/services/scriptConnectorRegistry');
const { pluginRegistry } = require('../dist/plugins/pluginRegistry');

function operation(id, handler, outputSchema = { type: 'string' }) {
  return {
    id,
    label: id,
    permissions: ['patient:read'],
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    },
    outputSchema,
    handler,
  };
}

function definition(allowedOperations) {
  return migrateCanonicalFormToV1({
    id: 'connector-form',
    name: 'Connector form',
    version: '1.0.0',
    schemaVersion: '1.0',
    revision: 0,
    extensions: {
      'formbuilder.scripting': {
        allowedOperations,
        operations: [],
      },
    },
    sourceTemplates: [],
    bindings: {},
    locales: { en: {} },
    layout: { type: 'form', children: [] },
  });
}

function context(form) {
  return {
    formId: form.id,
    form,
    userId: 'test-user',
    authMode: 'local',
  };
}

test('executes only enabled connector operations after schema validation', async () => {
  const registry = new ScriptConnectorRegistry();
  registry.register(operation('test.echo', async (input) => input.value));
  const form = definition(['test.echo']);

  assert.equal(await registry.execute('test.echo', { value: 'hello' }, context(form)), 'hello');

  await assert.rejects(
    registry.execute('test.echo', { value: 42 }, context(form)),
    (error) => error instanceof ScriptConnectorError && error.code === 'SCRIPT_CONNECTOR_INPUT_INVALID',
  );
  await assert.rejects(
    registry.execute('test.echo', { value: 'hello' }, context(definition([]))),
    (error) => error instanceof ScriptConnectorError && error.code === 'SCRIPT_CONNECTOR_FORBIDDEN',
  );
});

test('enforces connector timeouts even when a handler ignores abort', async () => {
  const registry = new ScriptConnectorRegistry();
  registry.register({
    ...operation('test.slow', async () => new Promise(() => {})),
    timeoutMs: 100,
  });
  const form = definition(['test.slow']);

  await assert.rejects(
    registry.execute('test.slow', { value: 'wait' }, context(form)),
    (error) => error instanceof ScriptConnectorError && error.code === 'SCRIPT_CONNECTOR_TIMEOUT',
  );
});

test('propagates external request cancellation', async () => {
  const registry = new ScriptConnectorRegistry();
  registry.register(operation('test.abort', async () => new Promise(() => {})));
  const form = definition(['test.abort']);
  const controller = new AbortController();
  const request = registry.execute(
    'test.abort',
    { value: 'wait' },
    context(form),
    controller.signal,
  );
  controller.abort();

  await assert.rejects(
    request,
    (error) => error instanceof ScriptConnectorError && error.code === 'SCRIPT_CONNECTOR_ABORTED',
  );
});

test('rejects connector output that violates its public schema', async () => {
  const registry = new ScriptConnectorRegistry();
  registry.register(operation('test.invalid-output', async () => 42));
  const form = definition(['test.invalid-output']);

  await assert.rejects(
    registry.execute('test.invalid-output', { value: 'hello' }, context(form)),
    (error) => error instanceof ScriptConnectorError && error.code === 'SCRIPT_CONNECTOR_OUTPUT_INVALID',
  );
});

test('hydrates versioned public connector types and rejects stale operation ids', () => {
  const hydrated = hydrateFormScriptConnectors(definition(['patient.get']));
  const configuration = getFormScriptConnectorConfiguration(hydrated);
  assert.deepEqual(configuration.allowedOperations, ['patient.get']);
  assert.equal(configuration.operations[0].id, 'patient.get');
  assert.equal(configuration.operations[0].permissions.includes('patient:read'), true);

  assert.throws(
    () => hydrateFormScriptConnectors(definition(['patient.removed'])),
    (error) => error instanceof ScriptConnectorError && error.code === 'SCRIPT_CONNECTOR_UNKNOWN',
  );
});

test('executes plugin-contributed scripting operations through the same registry', async () => {
  const pluginId = 'org.example.script-connector';
  await pluginRegistry.register({
    manifest: {
      id: pluginId,
      version: '1.0.0',
      apiVersion: '1.0',
      name: 'Script connector',
      extensionPoints: ['scripting'],
      permissions: ['patient:read'],
    },
    activate(activation) {
      activation.registerScriptingOperation({
        key: 'script.lookup',
        operationId: 'lookup',
        label: 'Lookup',
        permissions: ['patient:read'],
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          additionalProperties: false,
        },
      }, ({ data }) => ({ data: { id: data.id } }));
    },
  });

  try {
    const operationId = `${pluginId}.lookup`;
    const registry = new ScriptConnectorRegistry();
    const form = definition([operationId]);
    assert.deepEqual(
      await registry.execute(operationId, { id: 'patient-1' }, context(form)),
      { id: 'patient-1' },
    );
  } finally {
    pluginRegistry.unregister(pluginId);
  }
});
