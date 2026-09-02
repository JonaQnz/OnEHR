'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateCanonicalFormToV1 } = require('../dist/index.js');

/**
 * `migrateCanonicalFormToV1` is the trusted upgrade path both apps/api and
 * apps/web rely on for every stored form - before this test file existed
 * (packages/core's form-definition module had none at all), a payload
 * missing a required field (layout, name, version, ...) passed straight
 * through as `input as unknown as CanonicalForm` and only failed much
 * later, deep in some downstream consumer, as a confusing crash far from
 * the actual bad data. These tests pin the current behavior: a clear,
 * specific Error at this boundary instead.
 */

function minimalForm(overrides = {}) {
  return {
    id: 'form-1',
    name: 'A Form',
    version: '1.0.0',
    sourceTemplates: [],
    layout: { type: 'form', children: [] },
    bindings: {},
    locales: {},
    ...overrides,
  };
}

test('a well-formed form migrates cleanly and gets schemaVersion/revision/formScript filled in', () => {
  const result = migrateCanonicalFormToV1(minimalForm());
  assert.equal(result.id, 'form-1');
  assert.equal(result.schemaVersion, '1.0');
  assert.equal(result.revision, 0);
  assert.deepEqual(result.extensions, {});
  assert.ok(result.formScript);
});

test('idOverride replaces the input id, and is enough on its own even if input has no id', () => {
  const { id: _drop, ...withoutId } = minimalForm();
  const result = migrateCanonicalFormToV1(withoutId, 'form-2');
  assert.equal(result.id, 'form-2');
});

test('rejects a non-object input', () => {
  assert.throws(() => migrateCanonicalFormToV1('not an object'), /must be an object/);
  assert.throws(() => migrateCanonicalFormToV1(null), /must be an object/);
});

test('rejects a missing id when no idOverride is given', () => {
  const { id: _drop, ...withoutId } = minimalForm();
  assert.throws(() => migrateCanonicalFormToV1(withoutId), /"id" must be a string/);
});

test('rejects a missing/empty name', () => {
  assert.throws(() => migrateCanonicalFormToV1(minimalForm({ name: undefined })), /"name" must be a non-empty string/);
  assert.throws(() => migrateCanonicalFormToV1(minimalForm({ name: '   ' })), /"name" must be a non-empty string/);
});

test('rejects a missing/empty version', () => {
  assert.throws(() => migrateCanonicalFormToV1(minimalForm({ version: undefined })), /"version" must be a non-empty string/);
});

test('sourceTemplates defaults to [] when absent, but rejects a non-array value', () => {
  const { sourceTemplates: _drop, ...withoutSourceTemplates } = minimalForm();
  const result = migrateCanonicalFormToV1(withoutSourceTemplates);
  assert.deepEqual(result.sourceTemplates, []);
  assert.throws(() => migrateCanonicalFormToV1(minimalForm({ sourceTemplates: 'nope' })), /"sourceTemplates" must be an array/);
});

test('rejects a missing layout - the concrete case that used to surface as a downstream crash instead', () => {
  const { layout: _drop, ...withoutLayout } = minimalForm();
  assert.throws(() => migrateCanonicalFormToV1(withoutLayout), /"layout" must be an object/);
});

test('rejects a layout whose type is not "form"', () => {
  assert.throws(() => migrateCanonicalFormToV1(minimalForm({ layout: { type: 'container', children: [] } })), /"layout\.type" must be "form"/);
});

test('bindings/locales default to {} when absent, but reject a non-object value', () => {
  const { bindings: _b, locales: _l, ...rest } = minimalForm();
  const result = migrateCanonicalFormToV1(rest);
  assert.deepEqual(result.bindings, {});
  assert.deepEqual(result.locales, {});
  assert.throws(() => migrateCanonicalFormToV1(minimalForm({ bindings: [] })), /"bindings" must be an object/);
  assert.throws(() => migrateCanonicalFormToV1(minimalForm({ locales: 'nope' })), /"locales" must be an object/);
});
