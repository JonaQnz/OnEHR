const assert = require('node:assert/strict');
const test = require('node:test');
const { FORM_FHIR_MAPPING_EXTENSION_KEY, getFormFhirMapping } = require('../dist/fhir-mapping');

test('getFormFhirMapping returns null when the extension key is absent', () => {
  assert.equal(getFormFhirMapping({ layout: { type: 'form', children: [] }, extensions: {} }), null);
  assert.equal(getFormFhirMapping({ layout: { type: 'form', children: [] } }), null);
});

test('getFormFhirMapping returns null when resourceType is missing/blank', () => {
  assert.equal(getFormFhirMapping({ layout: { type: 'form', children: [] }, extensions: { [FORM_FHIR_MAPPING_EXTENSION_KEY]: {} } }), null);
  assert.equal(getFormFhirMapping({ layout: { type: 'form', children: [] }, extensions: { [FORM_FHIR_MAPPING_EXTENSION_KEY]: { resourceType: '  ' } } }), null);
});

test('getFormFhirMapping reads a plain resourceType', () => {
  const form = { layout: { type: 'form', children: [] }, extensions: { [FORM_FHIR_MAPPING_EXTENSION_KEY]: { resourceType: 'ServiceRequest' } } };
  assert.deepEqual(getFormFhirMapping(form), { resourceType: 'ServiceRequest' });
});

test('getFormFhirMapping trims resourceType and only keeps string searchParams entries', () => {
  const form = {
    layout: { type: 'form', children: [] },
    extensions: {
      [FORM_FHIR_MAPPING_EXTENSION_KEY]: {
        resourceType: '  Procedure  ',
        searchParams: { code: 'abc', bogus: 123, another: 'def' },
      },
    },
  };
  assert.deepEqual(getFormFhirMapping(form), { resourceType: 'Procedure', searchParams: { code: 'abc', another: 'def' } });
});

test('getFormFhirMapping omits an empty searchParams object entirely', () => {
  const form = {
    layout: { type: 'form', children: [] },
    extensions: { [FORM_FHIR_MAPPING_EXTENSION_KEY]: { resourceType: 'Observation', searchParams: { bogus: 123 } } },
  };
  assert.deepEqual(getFormFhirMapping(form), { resourceType: 'Observation' });
});
