const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeCanonicalFormPayload } = require('../dist/validation/formValidation');

function validLegacyForm(extra = {}) {
  return {
    name: 'Vitals',
    version: '1.0.0',
    sourceTemplates: [],
    layout: { type: 'form', children: [] },
    bindings: {},
    locales: { en: {} },
    ...extra,
  };
}

test('legacy canonical payloads migrate to FormDefinition v1', () => {
  const form = normalizeCanonicalFormPayload(validLegacyForm(), 'database-id');

  assert.equal(form.schemaVersion, '1.0');
  assert.equal(form.revision, 0);
  assert.deepEqual(form.extensions, {});
  assert.equal(form.id, 'database-id');
});

test('FormDefinition v1 preserves namespaced extension data', () => {
  const form = normalizeCanonicalFormPayload(validLegacyForm({
    schemaVersion: '1.0',
    extensions: { 'org.example.test': { enabled: true } },
  }), 'database-id');

  assert.deepEqual(form.extensions, { 'org.example.test': { enabled: true } });
});

test('unsupported FormDefinition schema versions are rejected', () => {
  assert.throws(
    () => normalizeCanonicalFormPayload(validLegacyForm({ schemaVersion: '2.0' }), 'database-id'),
    /schemaVersion/,
  );
});

test('invalid extensions and revisions are rejected', () => {
  assert.throws(
    () => normalizeCanonicalFormPayload(validLegacyForm({ extensions: [] }), 'database-id'),
    /extensions/,
  );
  assert.throws(
    () => normalizeCanonicalFormPayload(validLegacyForm({ revision: -1 }), 'database-id'),
    /revision/,
  );
});
