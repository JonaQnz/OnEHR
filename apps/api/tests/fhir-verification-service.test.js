const assert = require('node:assert/strict');
const test = require('node:test');
const prisma = require('../dist/db/prisma').default;
const fhirCdrService = require('../dist/services/fhirCdrService');
const ehrbaseDataProvider = require('../dist/services/ehrbaseDataProvider');
const { verifyFhirForSubmission } = require('../dist/services/fhirVerificationService');

const { FORM_FHIR_MAPPING_EXTENSION_KEY } = require('core');

function formRow(extensions) {
  return {
    id: 'form-1',
    version: '1.0.0',
    canonical_json: {
      id: 'form-1', name: 'Test form', version: '1.0.0', schemaVersion: '1.0', revision: 0,
      layout: { type: 'form', children: [] },
      extensions,
    },
  };
}

function withMocks(mocks, fn) {
  const originals = mocks.map(([obj, key, value]) => {
    const original = obj[key];
    obj[key] = value;
    return [obj, key, original];
  });
  return Promise.resolve(fn()).finally(() => {
    originals.forEach(([obj, key, original]) => { obj[key] = original; });
  });
}

test('verifyFhirForSubmission returns "unmapped" for a form with no FHIR mapping extension', async () => {
  await withMocks([
    [prisma.form, 'findUnique', async () => formRow({})],
  ], async () => {
    const result = await verifyFhirForSubmission('form-1', 'ehr-1');
    assert.deepEqual(result, { status: 'unmapped' });
  });
});

test('verifyFhirForSubmission returns "unmapped" when the form does not exist', async () => {
  await withMocks([
    [prisma.form, 'findUnique', async () => null],
  ], async () => {
    const result = await verifyFhirForSubmission('missing-form', 'ehr-1');
    assert.deepEqual(result, { status: 'unmapped' });
  });
});

test('verifyFhirForSubmission returns "no-fhir-patient" when the patient has no fhirPatientId on file', async () => {
  await withMocks([
    [prisma.form, 'findUnique', async () => formRow({ [FORM_FHIR_MAPPING_EXTENSION_KEY]: { resourceType: 'ServiceRequest' } })],
    [prisma.patient, 'findUnique', async () => ({ patientId: 'p-1', fhirPatientId: null })],
  ], async () => {
    const result = await verifyFhirForSubmission('form-1', 'ehr-1');
    assert.deepEqual(result, { status: 'no-fhir-patient' });
  });
});

test('verifyFhirForSubmission returns "no-fhir-patient" when the patient row does not exist at all', async () => {
  await withMocks([
    [prisma.form, 'findUnique', async () => formRow({ [FORM_FHIR_MAPPING_EXTENSION_KEY]: { resourceType: 'ServiceRequest' } })],
    [prisma.patient, 'findUnique', async () => null],
  ], async () => {
    const result = await verifyFhirForSubmission('form-1', 'ehr-1');
    assert.deepEqual(result, { status: 'no-fhir-patient' });
  });
});

test('verifyFhirForSubmission searches with patient + mapping searchParams and returns the bundle, formId/sessionId passed through for logging', async () => {
  let searchCall;
  await withMocks([
    [prisma.form, 'findUnique', async () => formRow({ [FORM_FHIR_MAPPING_EXTENSION_KEY]: { resourceType: 'ServiceRequest', searchParams: { status: 'active' } } })],
    [prisma.patient, 'findUnique', async () => ({ patientId: 'p-1', fhirPatientId: 'fhir-p-1' })],
    [fhirCdrService, 'searchFhirResource', async (resourceType, query, context) => {
      searchCall = { resourceType, query, context };
      return { resourceType: 'Bundle', entry: [{ resource: { resourceType: 'ServiceRequest' } }] };
    }],
    [ehrbaseDataProvider.EhrbaseDataProvider.prototype, 'loadLatestCompositionContext', async () => undefined],
  ], async () => {
    const result = await verifyFhirForSubmission('form-1', 'ehr-1', { sessionId: 'session-1', operation: 'verify-after-submit' });
    assert.equal(result.status, 'ok');
    assert.equal(result.resourceType, 'ServiceRequest');
    assert.equal(result.bundle.entry.length, 1);
    assert.equal(searchCall.resourceType, 'ServiceRequest');
    assert.equal(searchCall.query.patient, 'fhir-p-1');
    assert.equal(searchCall.query.status, 'active');
    assert.equal(searchCall.context.formId, 'form-1');
    assert.equal(searchCall.context.sessionId, 'session-1');
    assert.equal(searchCall.context.ehrId, 'ehr-1');
    assert.equal(searchCall.context.patientId, 'p-1');
    assert.equal(searchCall.context.operation, 'verify-after-submit');
  });
});

test('verifyFhirForSubmission still returns the bundle when the best-effort composition-context lookup fails', async () => {
  await withMocks([
    [prisma.form, 'findUnique', async () => formRow({ [FORM_FHIR_MAPPING_EXTENSION_KEY]: { resourceType: 'Procedure' } })],
    [prisma.patient, 'findUnique', async () => ({ patientId: 'p-1', fhirPatientId: 'fhir-p-1' })],
    [fhirCdrService, 'searchFhirResource', async () => ({ resourceType: 'Bundle', entry: [] })],
    [ehrbaseDataProvider.EhrbaseDataProvider.prototype, 'loadLatestCompositionContext', async () => { throw new Error('EHRbase unreachable'); }],
  ], async () => {
    const result = await verifyFhirForSubmission('form-1', 'ehr-1');
    assert.equal(result.status, 'ok');
    assert.equal(result.composition, undefined);
  });
});
