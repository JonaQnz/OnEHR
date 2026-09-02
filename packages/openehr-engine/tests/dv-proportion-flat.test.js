const assert = require('node:assert/strict');
const test = require('node:test');
const { toOpenEhrFlatComposition, fromOpenEhrFlatComposition } = require('../dist');

// DV_PROPORTION support added 2026-09-02 after auditing the codebase
// against the openEHR RM Data Types spec - previously had no branch at all
// in setFlatValue/readFlatValue, fell through to a bare `output[key] =
// value` write with no suffix. numerator/denominator are always suffixed
// sibling keys, same convention as DV_QUANTITY's magnitude/unit. `|type`
// is written best-effort (see webTemplateParser.ts's DV_PROPORTION
// extraction comment) - no live WebTemplate example was available to
// confirm the exact wire format, unlike numerator/denominator which are
// confirmed via a real EHRbase WebTemplate example.
const PATH = '/content/data/items[at0005]';

function definition(proportionType) {
  return {
    sourceTemplates: [{ alias: 'obs', id: 'obs.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{ id: 'ratio_field', type: 'input-proportion', binding: { path: PATH, rmType: 'DV_PROPORTION' }, ...(proportionType ? { proportionType } : {}) }],
    },
    bindings: {},
  };
}

test('a {numerator, denominator} value writes both to their own suffix, never a bare path', () => {
  const flat = toOpenEhrFlatComposition(definition('ratio'), { ratio_field: { numerator: 1, denominator: 128 } });
  assert.equal(flat[`${PATH}|numerator`], 1);
  assert.equal(flat[`${PATH}|denominator`], 128);
  assert.equal(flat[`${PATH}|type`], 'ratio');
  assert.equal(flat[PATH], undefined, 'must never write a bare, unsuffixed key for DV_PROPORTION');
});

test('type "percent" with only a numerator supplied still writes the implied denominator of 100', () => {
  const flat = toOpenEhrFlatComposition(definition('percent'), { ratio_field: { numerator: 45.2 } });
  assert.equal(flat[`${PATH}|numerator`], 45.2);
  assert.equal(flat[`${PATH}|denominator`], 100);
  assert.equal(flat[`${PATH}|type`], 'percent');
});

test('type "unitary" with only a numerator supplied still writes the implied denominator of 1', () => {
  const flat = toOpenEhrFlatComposition(definition('unitary'), { ratio_field: { numerator: 0.35 } });
  assert.equal(flat[`${PATH}|numerator`], 0.35);
  assert.equal(flat[`${PATH}|denominator`], 1);
});

test('an explicit denominator overrides the implied one even when the type would normally imply a different value', () => {
  const flat = toOpenEhrFlatComposition(definition('percent'), { ratio_field: { numerator: 1, denominator: 4 } });
  assert.equal(flat[`${PATH}|denominator`], 4, 'the explicit value always wins - validateOne is what flags this as inconsistent, not the writer');
});

test('a field with no proportionType at all writes numerator/denominator as given, with no |type key', () => {
  const flat = toOpenEhrFlatComposition(definition(undefined), { ratio_field: { numerator: 1, denominator: 2 } });
  assert.equal(flat[`${PATH}|numerator`], 1);
  assert.equal(flat[`${PATH}|denominator`], 2);
  assert.equal(flat[`${PATH}|type`], undefined);
});

test('an empty value writes nothing at all', () => {
  const flat = toOpenEhrFlatComposition(definition('ratio'), {});
  assert.equal(Object.keys(flat).filter((key) => key.startsWith(PATH)).length, 0);
});

test('round-trips: write then read back reconstructs {numerator, denominator}', () => {
  const flat = toOpenEhrFlatComposition(definition('ratio'), { ratio_field: { numerator: 1, denominator: 128 } });
  const values = fromOpenEhrFlatComposition(definition('ratio'), flat);
  assert.deepEqual(values.ratio_field, { numerator: 1, denominator: 128 });
});

test('reading back a numerator with no denominator sibling at all omits denominator, not a fabricated one', () => {
  const flat = { [`${PATH}|numerator`]: 45.2 };
  const values = fromOpenEhrFlatComposition(definition('percent'), flat);
  assert.deepEqual(values.ratio_field, { numerator: 45.2 });
});
