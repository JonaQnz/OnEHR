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
// (order_identifier) on "Medikamentengabe (eMAR-Eintrag)" - a plain
// input-text field, so `value` is normally just the id string. Updated
// 2026-09-05 (P0.1 audit) once a real input-identifier Designer widget was
// added (see identifier-validation.test.js): reading back now reconstructs
// the full {id, issuer?, assigner?, type?} object whenever those extra
// attributes actually carry data, while staying a bare string whenever
// they don't - so "Verordnungs-ID" itself, which never writes them, is
// completely unaffected by this change.
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

// Updated 2026-09-05 (P0.1 audit) alongside adding the real
// input-identifier Designer widget - see identifier-validation.test.js and
// FormRuntime.tsx's input-identifier branch. Before this, NOTHING ever
// wrote issuer/assigner/type through the Designer/Runtime at all, so this
// test only ever exercised a synthetic flat object, not a real scenario -
// reading it back as a bare string was correct FOR THAT PRE-EXISTING GAP,
// but is now the wrong behavior once a field genuinely does carry richer
// data. The bare-string case (no issuer/assigner/type at all) - the
// pre-existing "Verordnungs-ID" field's actual real-world shape - is
// covered separately above and stays completely unaffected.
test('reading back reconstructs the full {id, issuer, ...} object once issuer/assigner/type actually carry data', () => {
  const flat = {
    [`${PATH}|id`]: 'RX-2026-001234',
    [`${PATH}|issuer`]: 'Apotheke Nord',
  };
  const values = fromOpenEhrFlatComposition(definition(), flat);
  assert.deepEqual(values.order_identifier, { id: 'RX-2026-001234', issuer: 'Apotheke Nord' });
});

test('reading back a genuinely id-only value (no issuer/assigner/type keys at all) still surfaces the bare string - the pre-existing single-field widget stays unaffected', () => {
  const flat = { [`${PATH}|id`]: 'RX-2026-001234' };
  const values = fromOpenEhrFlatComposition(definition(), flat);
  assert.equal(values.order_identifier, 'RX-2026-001234');
});

test('a full write/read round-trip reconstructs every attribute exactly', () => {
  const flat = toOpenEhrFlatComposition(definition(), {
    order_identifier: { id: 'RX-2026-001234', issuer: 'Apotheke Nord', assigner: 'KIS', type: 'prescription' },
  });
  const values = fromOpenEhrFlatComposition(definition(), flat);
  assert.deepEqual(values.order_identifier, { id: 'RX-2026-001234', issuer: 'Apotheke Nord', assigner: 'KIS', type: 'prescription' });
});
