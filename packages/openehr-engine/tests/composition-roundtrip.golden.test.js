const assert = require('node:assert/strict');
const test = require('node:test');
const {
  fromOpenEhrFlatComposition,
  toOpenEhrFlatComposition,
} = require('../dist');

const definition = {
  id: 'vitals-form',
  name: 'Vitals',
  version: '1.0.0',
  sourceTemplates: [{ alias: 'vitals', id: 'vitals.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
  layout: { type: 'form', children: [] },
  locales: { en: {} },
  bindings: {
    name: { openehr: { templateAlias: 'vitals', path: '/name', flatPath: 'vitals/name', rmType: 'DV_TEXT' } },
    weight: { openehr: { templateAlias: 'vitals', path: '/weight', flatPath: 'vitals/weight', rmType: 'DV_QUANTITY' } },
    status: { openehr: { templateAlias: 'vitals', path: '/status', flatPath: 'vitals/status', rmType: 'DV_CODED_TEXT' } },
    active: { openehr: { templateAlias: 'vitals', path: '/active', flatPath: 'vitals/active', rmType: 'DV_BOOLEAN' } },
  },
};

const values = {
  name: 'Ada',
  weight: { magnitude: 63, unit: 'kg' },
  status: 'ok',
  active: true,
};

const goldenFlatComposition = {
  'ctx/language': 'en',
  'ctx/territory': 'DE',
  'ctx/time': '2026-01-01T00:00:00.000Z',
  'ctx/composer_name': 'test-user',
  'ctx/template_id': 'vitals.v1',
  'vitals/name': 'Ada',
  'vitals/weight|magnitude': 63,
  'vitals/weight|unit': 'kg',
  'vitals/status|code': 'ok',
  'vitals/status|value': 'ok',
  'vitals/status|terminology': 'local',
  'vitals/active': true,
};

test('round-trips the golden flat composition without an EHRbase transport', () => {
  const composition = toOpenEhrFlatComposition(definition, values, {
    composerName: 'test-user',
    time: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(composition, goldenFlatComposition);
  assert.deepEqual(fromOpenEhrFlatComposition(definition, goldenFlatComposition), values);
});

test('maps legacy layout binding envelopes to the runtime field id', () => {
  const legacyDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'field_legacy_first_name',
        name: 'name',
        type: 'input-text',
        binding: { openehr: definition.bindings.name.openehr },
      }],
    },
  };
  const composition = toOpenEhrFlatComposition(legacyDefinition, {
    field_legacy_first_name: 'Ada',
  }, {
    composerName: 'test-user',
    time: '2026-01-01T00:00:00.000Z',
  });

  assert.equal(composition['vitals/name'], 'Ada');
  assert.deepEqual(
    fromOpenEhrFlatComposition(legacyDefinition, { 'vitals/name': 'Ada' }),
    { field_legacy_first_name: 'Ada' },
  );
});

test('serializes scalar legacy select values as complete coded text', () => {
  const legacyDefinition = {
    ...definition,
    layout: {
      type: 'form',
      children: [{
        id: 'field_name_type',
        type: 'select',
        options: [{ value: 'at0001', text: 'Official name' }],
        binding: { openehr: definition.bindings.status.openehr },
      }],
    },
  };

  const composition = toOpenEhrFlatComposition(legacyDefinition, {
    field_name_type: 'at0001',
  }, {
    composerName: 'test-user',
    time: '2026-01-01T00:00:00.000Z',
  });

  assert.deepEqual(
    Object.fromEntries(Object.entries(composition).filter(([key]) => key.startsWith('vitals/status'))),
    {
      'vitals/status|code': 'at0001',
      'vitals/status|value': 'Official name',
      'vitals/status|terminology': 'local',
    },
  );
});
