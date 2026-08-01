const assert = require('node:assert/strict');
const test = require('node:test');
const {
  bindAqlParameters,
  qualifiedAqlFunctionName,
  validateAqlFunctionInput,
  validateCodeFunctionInput,
} = require('../dist/services/aqlFunctionService');
const { EhrbaseDataProvider } = require('../dist/services/ehrbaseDataProvider');

test('AQL functions accept a single read-only query and expose a qualified name', () => {
  const definition = validateAqlFunctionInput({
    packageName: 'laboratory',
    name: 'latest-result',
    query: "SELECT o/data[at0001]/items[at0004]/value/value FROM EHR e[ehr_id/value = :ehrId] CONTAINS OBSERVATION o LIMIT 1",
    parameters: { limit: { default: 10 } },
  });
  assert.equal(qualifiedAqlFunctionName(definition.packageName, definition.name), 'laboratory.latest-result');
  assert.equal(definition.autoload, true);
  assert.equal(definition.parameters.limit.default, 10);
});

test('AQL parameter binding quotes values and rejects missing parameters', () => {
  const query = bindAqlParameters("SELECT e/ehr_id/value FROM EHR e[ehr_id/value = :ehrId] WHERE e/system_id/value = :system", {
    ehrId: "ehr'42",
    system: 'clinical',
  });
  assert.match(query, /'ehr''42'/);
  assert.match(query, /'clinical'/);
  assert.throws(() => bindAqlParameters('SELECT e/ehr_id/value FROM EHR e[ehr_id/value = :ehrId]', {}), /Missing AQL parameter/);
});

test('AQL functions reject mutation statements and statement chaining', () => {
  assert.throws(() => validateAqlFunctionInput({ packageName: 'laboratory', name: 'unsafe', query: 'DELETE FROM EHR e' }), /read-only SELECT/);
  assert.throws(() => validateAqlFunctionInput({ packageName: 'laboratory', name: 'chained', query: 'SELECT e/ehr_id/value FROM EHR e; SELECT 1' }), /read-only SELECT/);
});

test('code functions require an exported matching function and block network-capable code', () => {
  const definition = validateCodeFunctionInput({
    packageName: 'clinicalTools',
    name: 'doubleValue',
    source: 'export function doubleValue(params) { return params.value * 2; }',
  });
  assert.equal(definition.packageName, 'clinicalTools');
  assert.throws(() => validateCodeFunctionInput({ packageName: 'tools', name: 'run', source: 'export function other() { return 1; }' }), /must export function run/);
  assert.throws(() => validateCodeFunctionInput({ packageName: 'tools', name: 'run', source: 'export function run() { return fetch(\"/x\"); }' }), /cannot import modules/);
});

test('the latest Flat Composition is loaded as independent runtime context', async () => {
  const versionUid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa::vg_Test.v1::2';
  const provider = new EhrbaseDataProvider({
    http: {
      async post(url) {
        assert.match(url, /\/query\/aql$/);
        return { data: { rows: [[versionUid]] } };
      },
      async get(url) {
        assert.match(url, /\/composition\//);
        return { data: [{ 'ctx/template_id': 'vg_Test.v1', 'test/value': 'latest' }] };
      },
    },
    config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic' },
  });
  const context = await provider.loadLatestCompositionContext({
    context: { ehrId: 'ehr-42', patientId: 'patient-42', mode: 'create' },
    form: { id: 'form-42', version: '1.0.0', definition: { sourceTemplates: [{ id: 'vg_Test.v1' }] } },
  });
  assert.equal(context.ehrId, 'ehr-42');
  assert.equal(context.reference, versionUid);
  assert.deepEqual(context.flat, { 'ctx/template_id': 'vg_Test.v1', 'test/value': 'latest' });
});
