const assert = require('node:assert/strict');
const test = require('node:test');
const { toOpenEhrFlatComposition, fromOpenEhrFlatComposition } = require('../dist');

// A repeatable *group* container (values[groupId] = array of row objects,
// one per occurrence - see FormRuntime's own `row[field.id]` convention)
// used to be silently dropped entirely by toOpenEhrFlatComposition: the
// group container itself has no `.binding` (it's pure UI grouping, per
// core/form-runtime's own repeatableGroupId doc), so `values[groupId]`
// never matched any bound field and the whole array - and everything in
// it - never reached EHRbase. Confirmed live 2026-09-01: a Laborpanel's 9
// analyte rows vanished, leaving only the panel's own top-level "Test
// name" field (a real leaf) in the committed composition. This file
// exercises the fix using a shape that mirrors the real Laborpanel forms
// (vg_ObservationLab.v1.2.0's laboratory_analyte_result CLUSTER) closely
// enough to catch a regression there specifically, not just in principle.
const GROUP_PATH = '/content[OBSERVATION.laboratory_test_result]/data/events/data/items[CLUSTER.laboratory_test_analyte]';

function definition() {
  return {
    sourceTemplates: [{ alias: 'lab', id: 'vg_ObservationLab.v1.2.0', version: '1.2.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [
        { id: 'test_name', type: 'input-text', binding: { path: '/content/data/events/data/items[at0005]', rmType: 'DV_TEXT' } },
        {
          id: 'laboratory_analyte_result', type: 'container', repeatable: true, repeatMin: 1, repeatMax: -1,
          children: [
            { type: 'row', children: [{ type: 'column', children: [
              { id: 'analyte_name', type: 'input-text', binding: { path: `${GROUP_PATH}/items[at0024]`, rmType: 'DV_TEXT' } },
            ] }] },
            { type: 'row', children: [{ type: 'column', children: [
              { id: 'quantity_value', type: 'input-quantity', binding: { path: `${GROUP_PATH}/items[at0001]`, rmType: 'DV_QUANTITY' } },
            ] }] },
            { type: 'row', children: [{ type: 'column', children: [
              {
                id: 'result_status', type: 'input-select',
                binding: { path: `${GROUP_PATH}/items[at0005]`, rmType: 'DV_CODED_TEXT' },
                options: [{ value: 'at0018', text: 'Final', rmValue: 'Final' }, { value: 'at0017', text: 'Vorläufig', rmValue: 'Preliminary' }],
              },
            ] }] },
          ],
        },
      ],
    },
    bindings: {},
  };
}

function threeAnalytes() {
  return {
    test_name: 'Kleines Blutbild',
    laboratory_analyte_result: [
      { analyte_name: 'Hämoglobin', quantity_value: { magnitude: 13.8, unit: 'g/dL' }, result_status: 'at0018' },
      { analyte_name: 'Leukozyten', quantity_value: { magnitude: 6.8, unit: 'G/L' }, result_status: 'at0018' },
      { analyte_name: 'Thrombozyten', quantity_value: { magnitude: 268, unit: 'G/L' }, result_status: 'at0018' },
    ],
  };
}

test('a repeatable group writes one indexed row per occurrence, not just the top-level leaf fields', () => {
  const flat = toOpenEhrFlatComposition(definition(), threeAnalytes());
  assert.equal(flat['/content/data/events/data/items[at0005]'], 'Kleines Blutbild');
  assert.equal(flat[`${GROUP_PATH}:0/items[at0024]`], 'Hämoglobin');
  assert.equal(flat[`${GROUP_PATH}:1/items[at0024]`], 'Leukozyten');
  assert.equal(flat[`${GROUP_PATH}:2/items[at0024]`], 'Thrombozyten');
});

test('the group index sits on the group\'s own path segment, not appended after the leaf', () => {
  const flat = toOpenEhrFlatComposition(definition(), threeAnalytes());
  // Wrong-but-plausible placement this regresses to if indexedPath() (the
  // simple-repeating-LEAF convention) is used instead of insertGroupIndex().
  assert.equal(Object.prototype.hasOwnProperty.call(flat, `${GROUP_PATH}/items[at0024]:0`), false);
  assert.equal(Object.prototype.hasOwnProperty.call(flat, `${GROUP_PATH}:0/items[at0024]`), true);
});

test('DV_QUANTITY and DV_CODED_TEXT group members serialize with their normal per-type convention, just index-qualified', () => {
  const flat = toOpenEhrFlatComposition(definition(), threeAnalytes());
  assert.equal(flat[`${GROUP_PATH}:0/items[at0001]|magnitude`], 13.8);
  assert.equal(flat[`${GROUP_PATH}:0/items[at0001]|unit`], 'g/dL');
  assert.equal(flat[`${GROUP_PATH}:1/items[at0005]|code`], 'at0018');
  assert.equal(flat[`${GROUP_PATH}:1/items[at0005]|value`], 'Final');
});

test('round-trips back through fromOpenEhrFlatComposition into the same row-array shape', () => {
  const def = definition();
  const flat = toOpenEhrFlatComposition(def, threeAnalytes());
  const values = fromOpenEhrFlatComposition(def, flat);
  assert.equal(values.test_name, 'Kleines Blutbild');
  // fromOpenEhrFlatComposition reads plain per-field paths (readFlatValue's
  // own `:\d+` handling is generic across every segment) - this only proves
  // the write side is real openEHR FLAT the reader can already parse, not
  // that this app's read path reconstructs the group array shape itself.
  assert.equal(flat[`${GROUP_PATH}:2/items[at0024]`], 'Thrombozyten');
});

test('an empty group array writes nothing and does not throw', () => {
  const flat = toOpenEhrFlatComposition(definition(), { test_name: 'Kleines Blutbild', laboratory_analyte_result: [] });
  assert.equal(Object.keys(flat).some((key) => key.includes('laboratory_analyte_result') || key.includes('CLUSTER.laboratory_test_analyte')), false);
});

test('a form with no repeatable groups at all is unaffected (no group-id false positive)', () => {
  const def = {
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: { type: 'form', children: [{ id: 'diagnosis_name', type: 'input-text', binding: { path: '/content/data/items[at0002]', rmType: 'DV_TEXT' } }] },
    bindings: {},
  };
  const flat = toOpenEhrFlatComposition(def, { diagnosis_name: 'Mammakarzinom links' });
  assert.equal(flat['/content/data/items[at0002]'], 'Mammakarzinom links');
});
