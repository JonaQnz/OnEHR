'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { deriveDefaultWidget } = require('../dist/index.js');

function field(valueConstraints, occurrences = { min: 0, max: 1 }) {
  return { valueConstraints, occurrences };
}

test('DV_TEXT alone -> text input', () => {
  assert.deepEqual(deriveDefaultWidget(field([{ rmType: 'DV_TEXT' }])), { widget: 'text', repeatable: false });
});

test('DV_DATE_TIME -> date-time picker, no terminology logic involved', () => {
  assert.deepEqual(deriveDefaultWidget(field([{ rmType: 'DV_DATE_TIME' }])), { widget: 'date-time', repeatable: false });
});

test('DV_BOOLEAN alone -> checkbox/yes-no', () => {
  assert.deepEqual(deriveDefaultWidget(field([{ rmType: 'DV_BOOLEAN' }])), { widget: 'checkbox', repeatable: false });
});

test('DV_CODED_TEXT with 2-4 local options -> radio', () => {
  const constraint = { rmType: 'DV_CODED_TEXT', terminologyId: 'local', options: [{ terminologyId: 'local', codeString: 'at1', text: 'A' }, { terminologyId: 'local', codeString: 'at2', text: 'B' }] };
  assert.deepEqual(deriveDefaultWidget(field([constraint])), { widget: 'radio', repeatable: false });
});

test('DV_CODED_TEXT with 5-50 local options -> select', () => {
  const options = Array.from({ length: 10 }, (_, i) => ({ terminologyId: 'local', codeString: `at${i}`, text: `Option ${i}` }));
  const constraint = { rmType: 'DV_CODED_TEXT', terminologyId: 'local', options };
  assert.deepEqual(deriveDefaultWidget(field([constraint])), { widget: 'select', repeatable: false });
});

test('DV_CODED_TEXT with >50 local options -> autocomplete', () => {
  const options = Array.from({ length: 60 }, (_, i) => ({ terminologyId: 'local', codeString: `at${i}`, text: `Option ${i}` }));
  const constraint = { rmType: 'DV_CODED_TEXT', terminologyId: 'local', options };
  assert.deepEqual(deriveDefaultWidget(field([constraint])), { widget: 'autocomplete', repeatable: false });
});

test('DV_CODED_TEXT bound to a non-local/external terminology -> autocomplete regardless of option count', () => {
  const constraint = { rmType: 'DV_CODED_TEXT', terminologyId: 'http://loinc.org', options: [{ terminologyId: 'http://loinc.org', codeString: '1234-5', text: 'Something' }] };
  assert.deepEqual(deriveDefaultWidget(field([constraint])), { widget: 'autocomplete', repeatable: false });
});

test('DV_CODED_TEXT with no enumerable options at all -> autocomplete (open/unbounded value set)', () => {
  const constraint = { rmType: 'DV_CODED_TEXT', terminologyId: 'local', options: [] };
  assert.deepEqual(deriveDefaultWidget(field([constraint])), { widget: 'autocomplete', repeatable: false });
});

test('DV_CODED_TEXT + DV_TEXT union -> coded-choice-with-other, regardless of option count', () => {
  const coded = { rmType: 'DV_CODED_TEXT', terminologyId: 'local', options: [{ terminologyId: 'local', codeString: 'at1', text: 'A' }] };
  assert.deepEqual(deriveDefaultWidget(field([coded, { rmType: 'DV_TEXT' }])), { widget: 'coded-choice-with-other', repeatable: false });
});

test('DV_BOOLEAN + DV_CODED_TEXT (polymorphic union, e.g. admission_diagnosis) resolves via the coded alternative, not "coded-choice-with-other" (no DV_TEXT present)', () => {
  const coded = { rmType: 'DV_CODED_TEXT', terminologyId: 'local', options: [{ terminologyId: 'local', codeString: 'at1', text: 'Ja' }, { terminologyId: 'local', codeString: 'at2', text: 'Nein' }] };
  assert.deepEqual(deriveDefaultWidget(field([{ rmType: 'DV_BOOLEAN' }, coded])), { widget: 'radio', repeatable: false });
});

test('occurrences 0..* marks repeatable regardless of widget', () => {
  const result = deriveDefaultWidget(field([{ rmType: 'DV_TEXT' }], { min: 0, max: null }));
  assert.equal(result.repeatable, true);
});

test('occurrences 0..1 and 1..1 are not repeatable', () => {
  assert.equal(deriveDefaultWidget(field([{ rmType: 'DV_TEXT' }], { min: 0, max: 1 })).repeatable, false);
  assert.equal(deriveDefaultWidget(field([{ rmType: 'DV_TEXT' }], { min: 1, max: 1 })).repeatable, false);
});

test('occurrences 1..* is repeatable too', () => {
  assert.equal(deriveDefaultWidget(field([{ rmType: 'DV_TEXT' }], { min: 1, max: null })).repeatable, true);
});

test('an unsupported/unknown constraint still resolves to a safe fallback widget, never throws', () => {
  assert.doesNotThrow(() => deriveDefaultWidget(field([{ rmType: 'DV_PARAGRAPH', unsupported: true }])));
});

test('DV_QUANTITY/DV_COUNT/DV_DURATION each get their own distinct widget, not lumped into "text"', () => {
  assert.equal(deriveDefaultWidget(field([{ rmType: 'DV_QUANTITY' }])).widget, 'quantity');
  assert.equal(deriveDefaultWidget(field([{ rmType: 'DV_COUNT' }])).widget, 'number');
  assert.equal(deriveDefaultWidget(field([{ rmType: 'DV_DURATION' }])).widget, 'duration');
});
