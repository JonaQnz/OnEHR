const assert = require('node:assert/strict');
const test = require('node:test');
const { toOpenEhrFlatComposition, fromOpenEhrFlatComposition } = require('../dist');

// codeMappings.enabled DV_TEXT fields (core.CodeMappedTextValue) in the
// FLAT-format read/write path - see index.ts's writeCodeMappingsFlat/
// readCodeMappings for the `path/_mapping:N|...` convention. Went through
// two earlier, disproven guesses: a leading-underscore-plus-plural
// `_mappings/N` (mirroring `_uid`/`_name`'s structural-meta-attribute
// convention), rejected wholesale by EHRbase on write 2026-09-01 ("Could
// not consume Parts"); then a no-underscore `mappings/N` (reasoning
// `mappings` is DV_TEXT's own plain RM attribute, not a meta-attribute, so
// surely takes no prefix) - accepted without error, but never actually
// verified against a live EHRbase GET, and per a live read-path bug
// investigation 2026-09-05 (medication_item_name on
// vg_medicationstatement.v1.1.0, real data committed via
// canonicalComposition.ts's buildLeafDvValue - the path every real
// submission of a codeMappings.enabled field takes) that guess was ALSO
// wrong: EHRbase's own FLAT rendering is singular, underscore-prefixed,
// colon-indexed - `_mapping:N` - the same `name:index` shape every other
// repeating FLAT attribute uses (e.g. `any_event:0`). See
// coded-text-rmvalue.test.js's sibling file for the DV_CODED_TEXT-bound
// case this same convention covers.
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

test('writes a codeMappings.enabled field\'s text to the bare path, and each mapping under path/mappings/N', () => {
  const definition = definitionFor({ enabled: true, terminologies: [{ id: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', label: 'ICD-10-GM' }] });
  const flat = toOpenEhrFlatComposition(definition, {
    diagnosis_name: { value: 'Diagnose Text', mappings: [{ terminologyId: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', code: 'F16.0' }] },
  });
  assert.equal(flat[PATH], 'Diagnose Text');
  assert.equal(flat[`${PATH}/_mapping:0|match`], '=');
  assert.equal(flat[`${PATH}/_mapping:0/target|code`], 'F16.0');
  assert.equal(flat[`${PATH}/_mapping:0/target|terminology`], 'http://fhir.de/CodeSystem/dimdi/icd-10-gm');
});

test('preserves an explicit non-default match type', () => {
  const definition = definitionFor({ enabled: true, terminologies: [{ id: 'condition.id', label: 'Case id', match: '?' }] });
  const flat = toOpenEhrFlatComposition(definition, {
    diagnosis_name: { value: '00010002218401', mappings: [{ terminologyId: 'condition.id', code: '00010002218401', match: '?' }] },
  });
  assert.equal(flat[`${PATH}/_mapping:0|match`], '?');
});

// RM data_types.text 5.2.2: TERM_MAPPING.match is a char restricted to
// '>'/'='/'<'/'?' - nothing in this app currently sets an out-of-set value,
// but the write side didn't validate it either, so it must fall back to
// '=' the same way an unset match already does, rather than ship an
// RM-invalid TERM_MAPPING if a future caller ever does.
test('an invalid/unrecognized match value falls back to "=" rather than being written verbatim', () => {
  const definition = definitionFor({ enabled: true, terminologies: [{ id: 'condition.id', label: 'Case id' }] });
  const flat = toOpenEhrFlatComposition(definition, {
    diagnosis_name: { value: '00010002218401', mappings: [{ terminologyId: 'condition.id', code: '00010002218401', match: 'equivalent' }] },
  });
  assert.equal(flat[`${PATH}/_mapping:0|match`], '=');
});

test('a field with no mapping entered yet writes only the bare text, no mappings keys at all', () => {
  const definition = definitionFor({ enabled: true, terminologies: [{ id: 'icd10gm', label: 'ICD-10-GM' }] });
  const flat = toOpenEhrFlatComposition(definition, { diagnosis_name: { value: 'Nur Text' } });
  assert.equal(flat[PATH], 'Nur Text');
  assert.equal(Object.keys(flat).some((key) => key.includes('mappings')), false);
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
    [`${PATH}/_mapping:0|match`]: '=',
    [`${PATH}/_mapping:0/target|code`]: 'F16.0',
    // target|terminology deliberately missing
  };
  const values = fromOpenEhrFlatComposition(definition, flat);
  assert.deepEqual(values.diagnosis_name, { value: 'Diagnose' });
});
