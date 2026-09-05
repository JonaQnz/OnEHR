const assert = require('node:assert/strict');
const test = require('node:test');
const { fromOpenEhrFlatComposition } = require('../dist');

// Live bug (2026-09-05): loading a previously-submitted vg_medicationstatement
// composition back into a form session produced
// `medication_item_name: { value: ["Ibuprofen 400mg"] }` (mappings array
// missing entirely, and `value` wrongly array-wrapped) instead of
// `{ value: "Ibuprofen 400mg", mappings: [...] }`. Root cause was two
// distinct bugs sharing the same reported symptom:
//
// 1. readFlatValue's index-extraction scanned the WHOLE matched flat key for
//    ANY `:N`, not just this (non-group) field's own trailing repeat index -
//    so `any_event`'s own occurrence index (an archetype-inherent EVENT
//    series, not a UI-level repeatable group in this Form's layout) got
//    mistaken for the field's own repeat dimension, wrapping a genuinely
//    single value in a one-element array. This affected EVERY field nested
//    under `any_event`, not just codeMappings ones - `status` (plain,
//    non-codeMappings) shows the exact same array-wrapping here, confirming
//    it is the SAME root cause, not a separate/pre-existing behavior.
// 2. readCodeMappings looked for a `path/mappings/N` key shape that real
//    EHRbase FLAT data never actually uses for a committed TERM_MAPPING list
//    - confirmed via live AQL readback the real shape is `path/_mapping:N`
//    (singular, underscore-prefixed, colon-indexed) - so the `mappings`
//    array came back empty even when perfectly good `_mapping:0/target|...`
//    data was present in the flat composition.
const definition = {
  layout: { type: 'form', children: [] },
  bindings: {
    medication_item_name: {
      openehr: {
        flatPath: 'vg_medicationstatement.v1.1.0/medication_statement/any_event/medication_item_name',
        rmType: 'DV_CODED_TEXT',
        codeMappings: { enabled: true, terminologies: [{ id: 'https://hip.vitagroup.ag/sid/medication-code', label: 'Medication code' }] },
      },
    },
    status: {
      openehr: {
        flatPath: 'vg_medicationstatement.v1.1.0/medication_statement/any_event/status',
        rmType: 'DV_CODED_TEXT',
      },
    },
  },
};

function realMedicationFlatComposition() {
  const base = 'vg_medicationstatement.v1.1.0/medication_statement/any_event:0';
  return {
    [`${base}/medication_item_name|code`]: 'MED-002',
    [`${base}/medication_item_name|value`]: 'Ibuprofen 400mg',
    [`${base}/medication_item_name|terminology`]: 'https://hip.vitagroup.ag/sid/medication-code',
    [`${base}/medication_item_name/_mapping:0|match`]: '=',
    [`${base}/medication_item_name/_mapping:0/target|code`]: 'MED-002',
    [`${base}/medication_item_name/_mapping:0/target|terminology`]: 'https://hip.vitagroup.ag/sid/medication-code',
    [`${base}/status|code`]: 'at0011',
    [`${base}/status|value`]: 'Active',
    [`${base}/status|terminology`]: 'local',
  };
}

test('a codeMappings.enabled field nested under a single any_event occurrence reads back as {value, mappings}, not an array', () => {
  const values = fromOpenEhrFlatComposition(definition, realMedicationFlatComposition());
  assert.deepEqual(values.medication_item_name, {
    value: 'Ibuprofen 400mg',
    mappings: [{ terminologyId: 'https://hip.vitagroup.ag/sid/medication-code', code: 'MED-002', match: '=' }],
  });
});

test('a plain (non-codeMappings) sibling field under the same any_event occurrence reads back as a bare code, not an array - same root cause as above, confirming it is not codeMappings-specific', () => {
  const values = fromOpenEhrFlatComposition(definition, realMedicationFlatComposition());
  assert.equal(values.status, 'at0011');
});
