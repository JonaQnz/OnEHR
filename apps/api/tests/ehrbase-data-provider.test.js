const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EhrbaseDataProvider,
  fromEhrbaseFlatComposition,
  toEhrbaseFlatComposition,
} = require('../dist/services/ehrbaseDataProvider');

function definition() {
  return {
    id: 'vitals-form',
    name: 'Vitals',
    version: '1.0.0',
    sourceTemplates: [{ alias: 'vitals', id: 'vitals.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: { type: 'form', children: [] },
    locales: { en: {} },
    bindings: {
      name: { openehr: { flatPath: 'vitals/name', rmType: 'DV_TEXT' } },
      weight: { openehr: { flatPath: 'vitals/weight', rmType: 'DV_QUANTITY' } },
      status: { openehr: { flatPath: 'vitals/status', rmType: 'DV_CODED_TEXT' } },
      active: { openehr: { flatPath: 'vitals/active', rmType: 'DV_BOOLEAN' } },
    },
  };
}

test('maps runtime values to and from the EHRbase flat representation', () => {
  const values = { name: 'Ada', weight: { magnitude: 63, unit: 'kg' }, status: 'ok', active: true };
  const flat = toEhrbaseFlatComposition(definition(), values, { patientId: 'p-1', userId: 'alice' });
  assert.equal(flat['vitals/name'], 'Ada');
  assert.equal(flat['vitals/weight|magnitude'], 63);
  assert.equal(flat['vitals/weight|unit'], 'kg');
  assert.equal(flat['vitals/status|code'], 'ok');
  assert.equal(flat['vitals/active'], true);
  assert.equal(flat['ctx/composer_name'], 'alice');
  assert.equal(flat['ctx/template_id'], 'vitals.v1');

  assert.deepEqual(fromEhrbaseFlatComposition(definition(), flat), values);
});

test('resolves the patient EHR and uses templateId for load and submit', async () => {
  const calls = [];
  const http = {
    async get(url, options) {
      calls.push({ method: 'GET', url, options });
      if (url.endsWith('/ehr')) return { data: { ehr_id: { value: 'ehr-1' } } };
      return { data: [{ 'vitals/name': 'Ada' }], headers: { location: '/ehr/ehr-1/composition/v1' } };
    },
    async post(url, body, options) {
      calls.push({ method: 'POST', url, body, options });
      return { data: {}, headers: { location: '/ehr/ehr-1/composition/v2' } };
    },
  };
  const provider = new EhrbaseDataProvider({
    http,
    config: { ehrbaseUrl: 'http://ehrbase/rest/openehr/v1', ehrbaseUser: 'admin', ehrbasePass: 'secret', authMode: 'basic', ehrbaseSubjectNamespace: 'demo' },
  });
  const input = { context: { patientId: 'patient-1', patientNamespace: 'demo', userId: 'alice' }, form: { id: 'form-1', version: '1.0.0', definition: definition() } };
  const loaded = await provider.load(input);
  assert.equal(loaded.values.name, 'Ada');
  assert.equal(loaded.reference, '/ehr/ehr-1/composition/v1');
  assert.equal(calls[1].options.params.templateId, 'vitals.v1');

  const submitted = await provider.submit({ ...input, values: { name: 'Grace' } });
  assert.equal(submitted.reference, '/ehr/ehr-1/composition/v2');
  assert.equal(calls[3].options.params.templateId, 'vitals.v1');
  assert.equal(calls[3].body['vitals/name'], 'Grace');
});
