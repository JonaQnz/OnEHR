const assert = require('node:assert/strict');
const test = require('node:test');
const { toOpenEhrFlatComposition, fromOpenEhrFlatComposition } = require('../dist');

// DV_INTERVAL<DV_QUANTITY> in the FLAT-format read/write path (P0.1 openEHR
// Constraint Completeness audit, 2026-09-05) - see canonicalComposition.ts's
// buildLeafDvValue DV_INTERVAL<DV_QUANTITY> branch for the structured/
// Contribution path's own write, and index.ts's setFlatValue/
// readIntervalQuantityFlatValue for this one. `lower`/`upper` are real
// nested PATH SEGMENTS in the archetype's own aqlPath (confirmed against
// the real, published "Medikationsabgleich" form's "Dose"/at0144 field:
// ".../value/lower", ".../value/upper"), unlike DV_QUANTITY's own bare
// `|magnitude`/`|unit` suffixes on the SAME path - so the FLAT keys here
// are `path/lower|magnitude` etc., one segment deeper.
//
// No webTemplateTree/pathMap is supplied, so resolveFlatPath() falls back
// to the binding's own `path` verbatim - PATH below matches that exactly,
// same convention as code-mappings-flat.test.js's sibling file.
const PATH = '/content/data/items[at0144]/value';

function definitionFor(unitOptions) {
  return {
    sourceTemplates: [{ alias: 'med', id: 'med.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{
        id: 'dose_range', type: 'input-interval',
        binding: { path: PATH, rmType: 'DV_INTERVAL<DV_QUANTITY>' },
        ...(unitOptions ? { unitOptions } : {}),
      }],
    },
    bindings: {},
  };
}

test('writes both bounds of a closed range to path/lower|... and path/upper|...', () => {
  const flat = toOpenEhrFlatComposition(definitionFor(), {
    dose_range: { lower: { magnitude: 1, unit: 'mg' }, upper: { magnitude: 2, unit: 'mg' } },
  });
  assert.equal(flat[`${PATH}/lower|magnitude`], 1);
  assert.equal(flat[`${PATH}/lower|unit`], 'mg');
  assert.equal(flat[`${PATH}/upper|magnitude`], 2);
  assert.equal(flat[`${PATH}/upper|unit`], 'mg');
});

test('an open-ended interval (upper only) writes only the upper bound\'s keys, no phantom lower keys', () => {
  const flat = toOpenEhrFlatComposition(definitionFor(), {
    dose_range: { upper: { magnitude: 5, unit: 'mg' } },
  });
  assert.equal(flat[`${PATH}/upper|magnitude`], 5);
  assert.equal(`${PATH}/lower|magnitude` in flat, false);
  assert.equal(`${PATH}/lower|unit` in flat, false);
});

test('an entirely empty interval writes nothing at all', () => {
  const flat = toOpenEhrFlatComposition(definitionFor(), { dose_range: {} });
  assert.deepEqual(Object.keys(flat).filter((k) => k.startsWith(PATH)), []);
});

test('round-trips: write then read back reconstructs {lower, upper} exactly', () => {
  const definition = definitionFor([{ unit: 'mg' }]);
  const flat = toOpenEhrFlatComposition(definition, {
    dose_range: { lower: { magnitude: 1, unit: 'mg' }, upper: { magnitude: 2, unit: 'mg' } },
  });
  const values = fromOpenEhrFlatComposition(definition, flat);
  assert.deepEqual(values.dose_range, { lower: { magnitude: 1, unit: 'mg' }, upper: { magnitude: 2, unit: 'mg' } });
});

test('round-trips an open-ended (upper-only) interval back to just {upper}, no fabricated lower', () => {
  const definition = definitionFor([{ unit: 'mg' }]);
  const flat = toOpenEhrFlatComposition(definition, { dose_range: { upper: { magnitude: 5, unit: 'mg' } } });
  const values = fromOpenEhrFlatComposition(definition, flat);
  assert.deepEqual(values.dose_range, { upper: { magnitude: 5, unit: 'mg' } });
});
