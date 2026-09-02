const assert = require('node:assert/strict');
const test = require('node:test');
const { toOpenEhrFlatComposition, fromOpenEhrFlatComposition } = require('../dist');

// Spec gap found 2026-09-02 while auditing openEHR RM Data Types conformance
// (specifications.openehr.org/releases/RM/latest/data_types.html):
// DV_IDENTIFIER has no dedicated branch in setFlatValue/readFlatValue -
// falls through to the generic `output[key] = value` write, a bare string
// with no `|id` suffix at all. Not a valid FLAT representation: `id` (RM:
// 1..1, invariant "not id.is_empty") is always a suffixed sibling key,
// never the bare path itself - same convention as DV_QUANTITY's
// `|magnitude`. EHRbase's own atomic-Contribution path
// (canonicalComposition.ts's buildLeafDvValue) already got this right;
// only this FLAT path had the gap. Live example: "Verordnungs-ID"
// (order_identifier) on "Medikamentengabe (eMAR-Eintrag)" - a single
// plain input-text field, no dedicated issuer/assigner/type UI, so `value`
// is normally just the id string.
const PATH = '/content[openEHR-EHR-ACTION.medication.v1]/protocol[at0030]/items[at0103]/value';

function definition() {
  return {
    sourceTemplates: [{ alias: 'med', id: 'med.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{ id: 'order_identifier', type: 'input-text', binding: { path: PATH, rmType: 'DV_IDENTIFIER' } }],
    },
    bindings: {},
  };
}

test('a plain string value writes to the |id suffix, not the bare path', () => {
  const flat = toOpenEhrFlatComposition(definition(), { order_identifier: 'RX-2026-001234' });
  assert.equal(flat[`${PATH}|id`], 'RX-2026-001234');
  assert.equal(flat[PATH], undefined, 'must never write a bare, unsuffixed key for DV_IDENTIFIER');
});

test('an empty value writes nothing at all', () => {
  const flat = toOpenEhrFlatComposition(definition(), {});
  assert.equal(Object.keys(flat).filter((key) => key.startsWith(PATH)).length, 0);
});

test('round-trips: write then read back reconstructs the plain id string', () => {
  const flat = toOpenEhrFlatComposition(definition(), { order_identifier: 'RX-2026-001234' });
  const values = fromOpenEhrFlatComposition(definition(), flat);
  assert.equal(values.order_identifier, 'RX-2026-001234');
});

test('a structured {id, issuer, assigner, type} value writes every attribute to its own suffix', () => {
  const flat = toOpenEhrFlatComposition(definition(), {
    order_identifier: { id: 'RX-2026-001234', issuer: 'Apotheke Nord', assigner: 'KIS', type: 'prescription' },
  });
  assert.equal(flat[`${PATH}|id`], 'RX-2026-001234');
  assert.equal(flat[`${PATH}|issuer`], 'Apotheke Nord');
  assert.equal(flat[`${PATH}|assigner`], 'KIS');
  assert.equal(flat[`${PATH}|type`], 'prescription');
});

test('reading back only ever surfaces the bare id string, matching the single-field widget this rmType actually has today', () => {
  const flat = {
    [`${PATH}|id`]: 'RX-2026-001234',
    [`${PATH}|issuer`]: 'Apotheke Nord',
  };
  const values = fromOpenEhrFlatComposition(definition(), flat);
  assert.equal(values.order_identifier, 'RX-2026-001234');
});
