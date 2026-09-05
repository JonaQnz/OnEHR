const assert = require('node:assert/strict');
const test = require('node:test');
const { conceptFromExpansion, classifyFailureMessage, extractOperationOutcomeMessage, bindingSummaryFromValueSet } = require('../dist/terminologyProvider');

// These are the pieces genuinely carrying business-logic risk in this
// plugin (mapping/classification), tested directly rather than through a
// live/mocked HTTP round-trip - full request/response wiring is exercised
// against a real HAPI instance instead (see the plan's section K; not
// runnable in this environment without a live terminology server).

test('conceptFromExpansion maps a $expand contains entry, treating inactive:true as active:false', () => {
  assert.deepEqual(
    conceptFromExpansion({ system: 'http://fhir.de/CodeSystem/bfarm/icd-10-gm', version: '2026', code: 'E11.9', display: 'Diabetes mellitus, Typ 2' }),
    { namespace: 'http://fhir.de/CodeSystem/bfarm/icd-10-gm', namespaceVersion: '2026', code: 'E11.9', display: 'Diabetes mellitus, Typ 2', active: undefined },
  );
  assert.deepEqual(
    conceptFromExpansion({ system: 'urn:test', code: 'OLD1', inactive: true }),
    { namespace: 'urn:test', namespaceVersion: undefined, code: 'OLD1', display: undefined, active: false },
  );
});

test('classifyFailureMessage defaults to invalid-code for an unrecognized message - the common case', () => {
  assert.deepEqual(classifyFailureMessage('Code "XYZ" is not in the value set'), { status: 'invalid-code' });
  assert.deepEqual(classifyFailureMessage(undefined), { status: 'invalid-code' });
});

test('classifyFailureMessage recognizes an unknown CodeSystem/namespace', () => {
  assert.deepEqual(classifyFailureMessage('Unknown Code System \'http://example.com/bogus\''), { status: 'unknown-namespace' });
  assert.deepEqual(classifyFailureMessage('Unrecognized code system uri'), { status: 'unknown-namespace' });
});

test('classifyFailureMessage recognizes an unknown ValueSet/binding', () => {
  assert.deepEqual(classifyFailureMessage('Unable to find ValueSet with url http://example.com/bogus'), { status: 'unknown-binding' });
});

test('classifyFailureMessage recognizes an unknown version', () => {
  assert.deepEqual(classifyFailureMessage('Unknown version \'9999\' for code system'), { status: 'unknown-version' });
});

test('extractOperationOutcomeMessage reads the first issue\'s diagnostics or details.text', () => {
  assert.equal(extractOperationOutcomeMessage({ issue: [{ diagnostics: 'Unknown code system' }] }), 'Unknown code system');
  assert.equal(extractOperationOutcomeMessage({ issue: [{ details: { text: 'from details' } }] }), 'from details');
  assert.equal(extractOperationOutcomeMessage({ issue: [] }), undefined);
  assert.equal(extractOperationOutcomeMessage(undefined), undefined);
});

test('bindingSummaryFromValueSet prefers title over name over id, and reads the namespace off compose.include[0].system', () => {
  assert.deepEqual(
    bindingSummaryFromValueSet({ resourceType: 'ValueSet', url: 'http://example.com/ValueSet/icd10', version: '2026', title: 'ICD-10-GM 2026', name: 'icd10', id: 'icd10-id', compose: { include: [{ system: 'http://fhir.de/CodeSystem/bfarm/icd-10-gm' }] } }),
    { bindingId: 'http://example.com/ValueSet/icd10', label: 'ICD-10-GM 2026', namespace: 'http://fhir.de/CodeSystem/bfarm/icd-10-gm', bindingVersion: '2026' },
  );
  assert.deepEqual(
    bindingSummaryFromValueSet({ resourceType: 'ValueSet', id: 'only-id' }),
    { bindingId: 'only-id', label: 'only-id', namespace: undefined, bindingVersion: undefined },
  );
});
