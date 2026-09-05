const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRuntimeValues } = require('../dist');

// DV_IDENTIFIER support (P0.1 audit, 2026-09-05). Before this, a
// DV_IDENTIFIER-bound field could only ever render as plain free text (id
// only) - the write/read pipeline (openehr-engine's setFlatValue/
// buildLeafDvValue/readFlatValue) already fully supported the compound
// {id, issuer?, assigner?, type?} shape, but nothing in the Designer/Runtime
// ever produced or validated it. id is RM-mandatory (1..1, invariant
// "not id.is_empty") whenever the identifier is present at all; issuer/
// assigner/type are each 0..1, always optional.
function form(required) {
  return {
    layout: {
      type: 'form',
      children: [{ type: 'input-identifier', id: 'versicherungsnummer', label: 'Versicherungsnummer', ...(required ? { required: true } : {}) }],
    },
  };
}

test('a full {id, issuer, assigner, type} object with a non-empty id produces no issues', () => {
  const result = validateRuntimeValues(form(), { versicherungsnummer: { id: 'A123456789', issuer: 'AOK', assigner: 'Gesetzliche Krankenversicherung', type: 'KVNR' } });
  assert.deepEqual(result.issues, []);
  assert.equal(result.valid, true);
});

test('a bare string is accepted the same as {id: string} - the id-only reload/entry shape', () => {
  const result = validateRuntimeValues(form(), { versicherungsnummer: 'A123456789' });
  assert.deepEqual(result.issues, []);
});

test('an object with only issuer/assigner/type and no id is a blocking type error, not silently accepted', () => {
  const result = validateRuntimeValues(form(), { versicherungsnummer: { issuer: 'AOK' } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'type');
  assert.equal(result.valid, false);
});

test('an object with an empty-string id is likewise a type error (RM invariant "not id.is_empty")', () => {
  const result = validateRuntimeValues(form(), { versicherungsnummer: { id: '   ' } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'type');
});

test('required + completely absent is the ordinary required error, not a type error', () => {
  const result = validateRuntimeValues(form(true), { versicherungsnummer: undefined });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'required');
});

test('not required + completely absent is fine', () => {
  const result = validateRuntimeValues(form(false), {});
  assert.deepEqual(result.issues, []);
});

test('issuer/assigner/type alone, with no id at all, are never enough by themselves - matches DV_IDENTIFIER.id being 1..1 whenever present', () => {
  const result = validateRuntimeValues(form(), { versicherungsnummer: { issuer: 'AOK', assigner: 'GKV', type: 'KVNR' } });
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].code, 'type');
});
