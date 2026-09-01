const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRuntimeValues } = require('../dist');

function form(requireMapping) {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [{
          type: 'input-text', id: 'diagnose_name', label: 'Diagnose',
          codeMappings: { enabled: true, terminologies: [{ id: 'icd10gm', label: 'ICD-10-GM' }], ...(requireMapping ? { requireMapping: true } : {}) },
        }],
      }],
    },
  };
}

test('requireMapping: free text alone is no longer enough once a value is entered', () => {
  const result = validateRuntimeValues(form(true), { diagnose_name: { value: 'Diabetes mellitus Typ 2' } });
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].code, 'mapping-required');
});

test('requireMapping: satisfied once at least one mapping is attached', () => {
  const result = validateRuntimeValues(form(true), { diagnose_name: { value: 'Diabetes mellitus Typ 2', mappings: [{ terminologyId: 'icd10gm', code: 'E11.9' }] } });
  assert.equal(result.valid, true);
});

test('requireMapping: an empty/untouched field is governed by `required` alone, not this check', () => {
  const result = validateRuntimeValues(form(true), {});
  assert.equal(result.valid, true, 'no value at all -> requireMapping never fires; only `required` (unset here) would');
});

test('without requireMapping (every existing codeMappings field, unchanged): free text alone is still valid', () => {
  const result = validateRuntimeValues(form(false), { diagnose_name: { value: 'Diabetes mellitus Typ 2' } });
  assert.equal(result.valid, true);
});
