const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeCanonicalFormPayload } = require('../dist/validation/formValidation');
const { parseWebTemplate } = require('../dist/parsers/webTemplateParser');

test('canonical payload always uses the database form ID', () => {
  const form = normalizeCanonicalFormPayload({
    id: 'untrusted-client-id',
    name: 'Vitals',
    version: '1.0.0',
    sourceTemplates: [],
    layout: { type: 'form', children: [] },
    bindings: {},
    locales: { en: {} },
  }, 'database-id');

  assert.equal(form.id, 'database-id');
});

test('canonical payload rejects structurally invalid forms', () => {
  assert.throws(
    () => normalizeCanonicalFormPayload({ name: 'Broken' }, 'database-id'),
    /version/,
  );
});

test('web template parser maps common openEHR value types explicitly', () => {
  const result = parseWebTemplate({
    templateId: 'test-template',
    tree: {
      id: 'T0',
      rmType: 'COMPOSITION',
      children: [
        { id: 'date', rmType: 'DV_DATE', aqlPath: '/date' },
        { id: 'date_time', rmType: 'DV_DATE_TIME', aqlPath: '/date_time' },
        { id: 'time', rmType: 'DV_TIME', aqlPath: '/time' },
        { id: 'boolean', rmType: 'DV_BOOLEAN', aqlPath: '/boolean' },
        { id: 'count', rmType: 'DV_COUNT', aqlPath: '/count' },
        { id: 'ordinal', rmType: 'DV_ORDINAL', aqlPath: '/ordinal' },
        { id: 'duration', rmType: 'DV_DURATION', aqlPath: '/duration' },
      ],
    },
  });

  const types = Object.fromEntries(result.fields.map((field) => [field.technicalName, field.dataType]));
  assert.deepEqual(types, {
    date: 'date',
    date_time: 'date-time',
    time: 'time',
    boolean: 'boolean',
    count: 'number',
    ordinal: 'ordinal',
    duration: 'duration',
  });
  assert.deepEqual(result.fields.find((field) => field.technicalName === 'boolean').options, [
    { value: 'true', text: 'Yes' },
    { value: 'false', text: 'No' },
  ]);
});
