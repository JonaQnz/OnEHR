const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EhrbaseDataProvider,
  EhrbaseProviderError,
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

test('prefers the trusted patient-registry EHR ID over subject lookup', async () => {
  const calls = [];
  const http = {
    async get(url, options) {
      calls.push({ method: 'GET', url, options });
      return { data: [] };
    },
    async post() {
      throw new Error('not used');
    },
  };
  const provider = new EhrbaseDataProvider({
    http,
    config: {
      ehrbaseUrl: 'http://ehrbase/rest/openehr/v1',
      ehrbaseUser: 'admin',
      ehrbasePass: 'secret',
      authMode: 'basic',
      defaultEhrId: 'wrong-default-ehr',
    },
  });

  const loaded = await provider.load({
    context: {
      patientId: 'asdas',
      patientNamespace: 'default',
      ehrId: '3bfb00d8-62f0-4fd5-abbc-a37c9cd4fc5a',
      userId: 'alice',
    },
    form: { id: 'form-1', version: '1.0.0', definition: definition() },
  });

  assert.equal(loaded.metadata.ehrId, '3bfb00d8-62f0-4fd5-abbc-a37c9cd4fc5a');
  assert.match(calls[0].url, /\/ehr\/3bfb00d8-62f0-4fd5-abbc-a37c9cd4fc5a\/composition$/);
  assert.equal(calls.some((call) => call.options?.params?.subject_id === 'asdas'), false);
});

test('does not silently submit a known patient to the configured default EHR', async () => {
  const provider = new EhrbaseDataProvider({
    http: {
      async get() {
        const error = new Error('not found');
        error.response = { status: 404 };
        throw error;
      },
      async post() {
        throw new Error('not used');
      },
    },
    config: {
      ehrbaseUrl: 'http://ehrbase/rest/openehr/v1',
      ehrbaseUser: 'admin',
      ehrbasePass: 'secret',
      authMode: 'basic',
      defaultEhrId: 'default-ehr',
    },
  });

  await assert.rejects(
    provider.load({
      context: { patientId: 'missing-patient', userId: 'alice' },
      form: { id: 'form-1', version: '1.0.0', definition: definition() },
    }),
    (error) => error instanceof EhrbaseProviderError && error.code === 'PATIENT_EHR_NOT_FOUND',
  );
});
