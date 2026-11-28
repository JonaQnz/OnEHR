const assert = require('node:assert/strict');
const test = require('node:test');
const {
  wtRmType,
  wtCardinality,
  wtInputs,
  wtCodeListInput,
  wtOtherTextInput,
  wtUnitInput,
  wtNumericConstraint,
  wtUnitOptions,
  wtCodedValues,
} = require('../dist');

test('wtRmType trims and rejects missing/empty/non-string', () => {
  assert.equal(wtRmType({ rmType: ' DV_QUANTITY ' }), 'DV_QUANTITY');
  assert.equal(wtRmType({ rmType: '   ' }), undefined);
  assert.equal(wtRmType({}), undefined);
  assert.equal(wtRmType(null), undefined);
  assert.equal(wtRmType({ rmType: 42 }), undefined);
});

test('wtCardinality: missing max is 1 and not repeatable', () => {
  assert.deepEqual(wtCardinality({}), { min: 0, max: 1, repeatable: false });
  assert.deepEqual(wtCardinality({ min: 1 }), { min: 1, max: 1, repeatable: false });
  assert.deepEqual(wtCardinality(null), { min: 0, max: 1, repeatable: false });
  assert.deepEqual(wtCardinality({ min: '2', max: '3' }), { min: 0, max: 1, repeatable: false });
});

test('wtCardinality: max -1 and max 3 are repeatable', () => {
  assert.deepEqual(wtCardinality({ max: -1 }), { min: 0, max: -1, repeatable: true });
  assert.deepEqual(wtCardinality({ min: 1, max: -1 }), { min: 1, max: -1, repeatable: true });
  assert.deepEqual(wtCardinality({ max: 3 }), { min: 0, max: 3, repeatable: true });
  assert.deepEqual(wtCardinality({ max: 1 }), { min: 0, max: 1, repeatable: false });
  assert.deepEqual(wtCardinality({ max: 0 }), { min: 0, max: 0, repeatable: false });
});

test('wtInputs keeps only plain objects and defaults to []', () => {
  const kept = { suffix: 'code' };
  assert.deepEqual(wtInputs({ inputs: [kept, null, 'nope', 7, [], { type: 'TEXT' }] }), [kept, { type: 'TEXT' }]);
  assert.deepEqual(wtInputs({}), []);
  assert.deepEqual(wtInputs(null), []);
  assert.deepEqual(wtInputs({ inputs: 'x' }), []);
});

test('wtCodeListInput: a later code input wins over inputs[0]', () => {
  const codeInput = { suffix: 'code', list: [{ value: 'at0001' }] };
  const node = { inputs: [{ suffix: 'other', type: 'TEXT' }, codeInput] };
  assert.deepEqual(wtCodeListInput(node), codeInput);
});

test('wtCodeListInput: type CODED_TEXT wins, then fallback to inputs[0]', () => {
  const codedInput = { type: 'CODED_TEXT', list: [{ value: 'at0002' }] };
  const node = { inputs: [{ suffix: 'other' }, codedInput] };
  assert.deepEqual(wtCodeListInput(node), codedInput);

  const first = { list: [{ value: 'at0003' }] };
  assert.deepEqual(wtCodeListInput({ inputs: [first, { suffix: 'other' }] }), first);
  assert.equal(wtCodeListInput({ inputs: [] }), undefined);
  assert.equal(wtCodeListInput({}), undefined);
  assert.equal(wtCodeListInput(null), undefined);
});

test('wtOtherTextInput finds suffix other or type TEXT', () => {
  const bySuffix = { suffix: 'other' };
  const byType = { type: 'TEXT' };
  assert.deepEqual(wtOtherTextInput({ inputs: [{ suffix: 'code' }, bySuffix] }), bySuffix);
  assert.deepEqual(wtOtherTextInput({ inputs: [{ suffix: 'code' }, byType] }), byType);
  assert.equal(wtOtherTextInput({ inputs: [{ suffix: 'code' }] }), undefined);
  assert.equal(wtOtherTextInput({}), undefined);
});

test('wtUnitInput finds units, unit and unit_code suffixes', () => {
  const unitCode = { suffix: 'unit_code', list: [{ value: 'mg' }] };
  assert.deepEqual(wtUnitInput({ inputs: [{ suffix: 'other' }, unitCode] }), unitCode);
  assert.deepEqual(wtUnitInput({ inputs: [{ suffix: 'units' }] }), { suffix: 'units' });
  assert.deepEqual(wtUnitInput({ inputs: [{ suffix: 'unit' }] }), { suffix: 'unit' });
  assert.equal(wtUnitInput({ inputs: [{ suffix: 'units-magnitude' }] }), undefined);
  assert.equal(wtUnitInput({}), undefined);
});

test('wtNumericConstraint reads number range bounds only', () => {
  assert.deepEqual(wtNumericConstraint({ range: { min: 1, max: 10 } }), { min: 1, max: 10 });
  // string min values are dropped
  assert.deepEqual(wtNumericConstraint({ range: { min: '1', max: 10 } }), { max: 10 });
  assert.deepEqual(wtNumericConstraint({ range: { min: 1, max: '10' } }), { min: 1 });
  assert.deepEqual(wtNumericConstraint({ range: { min: 0, minOp: '>=', max: 5, maxOp: '<=' } }), { min: 0, max: 5 });
});

test('wtNumericConstraint: minOp > and maxOp < set exclusive flags', () => {
  assert.deepEqual(
    wtNumericConstraint({ range: { min: 0, minOp: '>', max: 5, maxOp: '<' } }),
    { min: 0, minexclusive: true, max: 5, maxexclusive: true },
  );
  assert.deepEqual(wtNumericConstraint({ range: { minOp: '>' } }), { minexclusive: true });
  assert.deepEqual(wtNumericConstraint({ range: { maxOp: '<' } }), { maxexclusive: true });
  assert.deepEqual(wtNumericConstraint({ range: null }), {});
});

test('wtNumericConstraint: precision.max wins, precision.min is the fallback', () => {
  assert.deepEqual(wtNumericConstraint({ precision: { max: 2, min: 1 } }), { precision: 2 });
  assert.deepEqual(wtNumericConstraint({ precision: { min: 1 } }), { precision: 1 });
  assert.deepEqual(wtNumericConstraint({ precision: { max: '2', min: 1 } }), { precision: 1 });
  assert.deepEqual(wtNumericConstraint({ precision: {} }), {});
});

test('wtNumericConstraint: non-objects give {} and unset keys are omitted', () => {
  assert.deepEqual(wtNumericConstraint(undefined), {});
  assert.deepEqual(wtNumericConstraint(null), {});
  assert.deepEqual(wtNumericConstraint('range'), {});
  assert.deepEqual(wtNumericConstraint({}), {});
  assert.deepEqual(Object.keys(wtNumericConstraint({ range: {} })), []);
});

test('wtUnitOptions keeps string-valued entries and merges constraints', () => {
  assert.deepEqual(
    wtUnitOptions([
      { value: 'mg', validation: { range: { min: 0, max: 100 }, precision: { max: 1 } } },
      { value: 'g', validation: { range: { minOp: '>' }, precision: { min: 2 } } },
      { value: 'ml' },
    ]),
    [
      { unit: 'mg', min: 0, max: 100, precision: 1 },
      { unit: 'g', minexclusive: true, precision: 2 },
      { unit: 'ml' },
    ],
  );
});

test('wtUnitOptions skips entries without a value and non-objects', () => {
  assert.deepEqual(wtUnitOptions([null, 'mg', 7, {}, { value: '   ' }, { value: 5 }, { unit: 'g' }]), []);
  assert.deepEqual(wtUnitOptions(undefined), []);
  assert.deepEqual(wtUnitOptions('mg'), []);
  assert.deepEqual(wtUnitOptions({ value: 'mg' }), []);
});

test('wtUnitOptions trims the unit value', () => {
  assert.deepEqual(wtUnitOptions([{ value: ' g ' }]), [{ unit: 'g' }]);
});

test('wtCodedValues mirrors currentCodesOf', () => {
  assert.deepEqual(
    wtCodedValues({ rmType: 'DV_CODED_TEXT', inputs: [{ suffix: 'code', list: [{ value: 'at0001' }, { value: 'at0002' }] }] }),
    ['at0001', 'at0002'],
  );
  assert.deepEqual(
    wtCodedValues({ rmType: 'CODE_PHRASE', inputs: [{ list: [{ value: 'at0003' }] }] }),
    ['at0003'],
  );
  // a code input that is not inputs[0] wins
  assert.deepEqual(
    wtCodedValues({
      rmType: 'DV_CODED_TEXT',
      inputs: [{ suffix: 'other', list: [{ value: 'at9999' }] }, { suffix: 'code', list: [{ value: 'at0004' }] }],
    }),
    ['at0004'],
  );
});

test('wtCodedValues skips unusable entries and trims', () => {
  assert.deepEqual(
    wtCodedValues({
      rmType: 'DV_CODED_TEXT',
      inputs: [{ list: [{ value: ' at0001 ' }, null, 'at0002', { label: 'no value' }, { value: '   ' }, { value: 9 }] }],
    }),
    ['at0001'],
  );
});

test('wtCodedValues is undefined for DV_TEXT, missing and empty lists', () => {
  assert.equal(wtCodedValues({ rmType: 'DV_TEXT', inputs: [{ list: [{ value: 'at0001' }] }] }), undefined);
  assert.equal(wtCodedValues({ rmType: 'DV_CODED_TEXT', inputs: [{ suffix: 'code', list: [] }] }), undefined);
  assert.equal(wtCodedValues({ rmType: 'DV_CODED_TEXT', inputs: [{}] }), undefined);
  assert.equal(wtCodedValues({ rmType: 'DV_CODED_TEXT', inputs: [{ list: [{ label: 'x' }] }] }), undefined);
  assert.equal(wtCodedValues(null), undefined);
});
