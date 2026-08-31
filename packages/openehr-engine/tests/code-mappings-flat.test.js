const assert = require('node:assert/strict');
const test = require('node:test');
const { toOpenEhrFlatComposition, fromOpenEhrFlatComposition } = require('../dist');

// codeMappings.enabled DV_TEXT fields (core.CodeMappedTextValue) in the
// FLAT-format read/write path - see index.ts's setFlatValue/readCodeMappings
// for the `path/_mappings/N|...` convention. Unlike canonical-composition
// .test.js's coverage of the same feature (confirmed against a real
// production Composition), this file's exact flat-key convention is a
// best-effort match to EHRbase's documented underscore-prefixed structural-
// attribute pattern, not verified against a live EHRbase instance - the
// tests below only guarantee this app's own write/read halves stay
// consistent with each other (a round trip), not that EHRbase itself
// accepts these exact keys.
//
// No webTemplateTree/pathMap is supplied in any test here, so
// resolveFlatPath() falls back to the binding's own `path` verbatim
// (leading slash and all) - PATH below matches that exactly.
const PATH = '/content/data/items[at0002]';

function definitionFor(codeMappings) {
  return {
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{
        id: 'diagnosis_name', type: 'input-text',
        binding: { path: PATH, rmType: 'DV_TEXT' },
        ...(codeMappings ? { codeMappings } : {}),
      }],
    },
    bindings: {},
  };
}

test('writes a codeMappings.enabled field\'s text to the bare path, and each mapping under path/_mappings/N', () => {
  const definition = definitionFor({ enabled: true, terminologies: [{ id: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', label: 'ICD-10-GM' }] });
  const flat = toOpenEhrFlatComposition(definition, {
    diagnosis_name: { value: 'Diagnose Text', mappings: [{ terminologyId: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', code: 'F16.0' }] },
  });
  assert.equal(flat[PATH], 'Diagnose Text');
  assert.equal(flat[`${PATH}/_mappings/0|match`], '=');
  assert.equal(flat[`${PATH}/_mappings/0/target|code`], 'F16.0');
  assert.equal(flat[`${PATH}/_mappings/0/target|terminology`], 'http://fhir.de/CodeSystem/dimdi/icd-10-gm');
});

test('preserves an explicit non-default match type', () => {
  const definition = definitionFor({ enabled: true, terminologies: [{ id: 'condition.id', label: 'Case id', match: '?' }] });
  const flat = toOpenEhrFlatComposition(definition, {
    diagnosis_name: { value: '00010002218401', mappings: [{ terminologyId: 'condition.id', code: '00010002218401', match: '?' }] },
  });
  assert.equal(flat[`${PATH}/_mappings/0|match`], '?');
});

test('a field with no mapping entered yet writes only the bare text, no _mappings keys at all', () => {
  const definition = definitionFor({ enabled: true, terminologies: [{ id: 'icd10gm', label: 'ICD-10-GM' }] });
  const flat = toOpenEhrFlatComposition(definition, { diagnosis_name: { value: 'Nur Text' } });
  assert.equal(flat[PATH], 'Nur Text');
  assert.equal(Object.keys(flat).some((key) => key.includes('_mappings')), false);
});

test('a codeMappings-disabled DV_TEXT field is completely unaffected - plain string in, plain string out', () => {
  const definition = definitionFor(undefined);
  const flat = toOpenEhrFlatComposition(definition, { diagnosis_name: 'Plain text, no coding' });
  assert.equal(flat[PATH], 'Plain text, no coding');
  const values = fromOpenEhrFlatComposition(definition, flat);
  assert.equal(values.diagnosis_name, 'Plain text, no coding');
});

test('round-trips: write then read back reconstructs {value, mappings} exactly, including multiple entries in order', () => {
  const definition = definitionFor({ enabled: true, allowMultiple: true, terminologies: [{ id: 'icd10gm', label: 'ICD-10-GM' }, { id: 'snomed', label: 'SNOMED CT' }] });
  const flat = toOpenEhrFlatComposition(definition, {
    diagnosis_name: { value: 'Diagnose', mappings: [{ terminologyId: 'icd10gm', code: 'F16.0' }, { terminologyId: 'snomed', code: '86299006' }] },
  });
  const values = fromOpenEhrFlatComposition(definition, flat);
  // match is a required TERM_MAPPING attribute (RM: 1..1) - the write side
  // always emits one (defaulting to '=' when the caller didn't set it), so
  // a round trip legitimately gets it back even though the original
  // runtime value didn't specify it explicitly.
  assert.deepEqual(values.diagnosis_name, {
    value: 'Diagnose',
    mappings: [
      { terminologyId: 'icd10gm', code: 'F16.0', match: '=' },
      { terminologyId: 'snomed', code: '86299006', match: '=' },
    ],
  });
});

test('round-trips a field with no mapping back to a bare, mapping-free value (no empty mappings array fabricated)', () => {
  const definition = definitionFor({ enabled: true, terminologies: [{ id: 'icd10gm', label: 'ICD-10-GM' }] });
  const flat = toOpenEhrFlatComposition(definition, { diagnosis_name: { value: 'Nur Text' } });
  const values = fromOpenEhrFlatComposition(definition, flat);
  assert.deepEqual(values.diagnosis_name, { value: 'Nur Text' });
});

test('a malformed/partial mapping group (missing target|terminology) is dropped on read, not fabricated', () => {
  const definition = definitionFor({ enabled: true, terminologies: [{ id: 'icd10gm', label: 'ICD-10-GM' }] });
  const flat = {
    [PATH]: 'Diagnose',
    [`${PATH}/_mappings/0|match`]: '=',
    [`${PATH}/_mappings/0/target|code`]: 'F16.0',
    // target|terminology deliberately missing
  };
  const values = fromOpenEhrFlatComposition(definition, flat);
  assert.deepEqual(values.diagnosis_name, { value: 'Diagnose' });
});
