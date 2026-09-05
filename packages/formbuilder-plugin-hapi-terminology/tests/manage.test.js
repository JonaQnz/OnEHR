const assert = require('node:assert/strict');
const test = require('node:test');
const { slugify, namespaceFor, bindingIdFor, resourceIdFor, statusToLifecycle, isActiveConcept, ManageError } = require('../dist/manage');

test('slugify lowercases and collapses non-alphanumerics, trims leading/trailing dashes', () => {
  assert.equal(slugify('Interne Medikamentenliste'), 'interne-medikamentenliste');
  assert.equal(slugify('  --Foo_Bar99--  '), 'foo-bar99');
});

test('slugify rejects an id with no alphanumeric content at all', () => {
  assert.throws(() => slugify('---'), ManageError);
  assert.throws(() => slugify(''), ManageError);
});

test('namespaceFor/bindingIdFor use a path-shaped canonical for an http(s) base, a colon-shaped one for a urn: base', () => {
  assert.equal(namespaceFor('https://forms.example.org/terminology', 'internal-list'), 'https://forms.example.org/terminology/CodeSystem/internal-list');
  assert.equal(bindingIdFor('https://forms.example.org/terminology', 'internal-list'), 'https://forms.example.org/terminology/ValueSet/internal-list');
  assert.equal(namespaceFor('urn:formbuilder:custom', 'internal-list'), 'urn:formbuilder:custom:codesystem:internal-list');
  assert.equal(bindingIdFor('urn:formbuilder:custom', 'internal-list'), 'urn:formbuilder:custom:valueset:internal-list');
});

test('resourceIdFor mints one HAPI resource id per business version, sharing the terminologyId prefix', () => {
  assert.equal(resourceIdFor('internal-list', 1), 'internal-list-v1');
  assert.equal(resourceIdFor('internal-list', 2), 'internal-list-v2');
});

test('statusToLifecycle maps FHIR PublicationStatus onto our lifecycle - the whole point of reusing it instead of a custom extension', () => {
  assert.equal(statusToLifecycle('draft'), 'draft');
  assert.equal(statusToLifecycle('active'), 'published');
  assert.equal(statusToLifecycle('retired'), 'retired');
  assert.equal(statusToLifecycle(undefined), 'draft');
  assert.equal(statusToLifecycle('unknown'), 'draft');
});

test('isActiveConcept defaults to active - only an explicit inactive:true property makes it inactive', () => {
  assert.equal(isActiveConcept({ code: 'A01' }), true);
  assert.equal(isActiveConcept({ code: 'A01', property: [] }), true);
  assert.equal(isActiveConcept({ code: 'A01', property: [{ code: 'inactive', valueBoolean: true }] }), false);
  assert.equal(isActiveConcept({ code: 'A01', property: [{ code: 'inactive', valueBoolean: false }] }), true);
  assert.equal(isActiveConcept({ code: 'A01', property: [{ code: 'notes', valueString: 'x' }] }), true);
});
