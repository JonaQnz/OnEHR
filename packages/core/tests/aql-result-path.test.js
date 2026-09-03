'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAqlResultPath } = require('../dist/index.js');

/**
 * `resolveAqlResultPath` is a faithful port of the old
 * `formbuilder-plugin-aql-prefill` package's `resultPathResolver.ts` -
 * per the QA review, the single highest-risk untested piece of logic in
 * the whole project (a hand-rolled openEHR-path parser with zero tests).
 * This is its first test coverage.
 */

test('resolves a plain property path', () => {
  assert.equal(resolveAqlResultPath({ a: { b: 'x' } }, 'a/b'), 'x');
});

test('resolves an array index via a bare-number segment', () => {
  assert.equal(resolveAqlResultPath({ items: ['first', 'second'] }, 'items/1'), 'second');
});

test('returns undefined for a missing property', () => {
  assert.equal(resolveAqlResultPath({ a: {} }, 'a/b'), undefined);
});

test('returns undefined for an out-of-bounds array index', () => {
  assert.equal(resolveAqlResultPath({ items: ['only'] }, 'items/5'), undefined);
});

test('returns undefined for null/undefined source or an empty path', () => {
  assert.equal(resolveAqlResultPath(null, 'a/b'), undefined);
  assert.equal(resolveAqlResultPath(undefined, 'a/b'), undefined);
  assert.equal(resolveAqlResultPath({ a: 1 }, ''), undefined);
  assert.equal(resolveAqlResultPath({ a: 1 }, '   '), undefined);
});

test('a leading slash is stripped, an absolute-looking path resolves the same as a relative one', () => {
  assert.equal(resolveAqlResultPath({ a: { b: 'x' } }, '/a/b'), resolveAqlResultPath({ a: { b: 'x' } }, 'a/b'));
});

test('bare numeric predicate on an array selects by index, same as a plain index segment', () => {
  const source = { items: ['zero', 'one', 'two'] };
  assert.equal(resolveAqlResultPath(source, 'items[2]'), 'two');
});

test('archetype_node_id predicate selects the matching array entry', () => {
  const source = {
    items: [
      { archetype_node_id: 'at0001', value: { value: 'wrong' } },
      { archetype_node_id: 'at0006', value: { value: 'right' } },
    ],
  };
  assert.equal(resolveAqlResultPath(source, 'items[at0006]/value'), 'right');
});

test('archetype_id predicate (archetype_details.archetype_id.value) also matches', () => {
  const source = {
    items: [
      { archetype_details: { archetype_id: { value: 'openEHR-EHR-CLUSTER.other.v1' } }, value: { value: 'wrong' } },
      { archetype_details: { archetype_id: { value: 'openEHR-EHR-CLUSTER.target.v1' } }, value: { value: 'right' } },
    ],
  };
  assert.equal(resolveAqlResultPath(source, "items[openEHR-EHR-CLUSTER.target.v1]/value"), 'right');
});

test(`name/value= predicate alone selects by name, no node id required`, () => {
  const source = {
    items: [
      { name: { value: 'Systolic' }, value: { value: 120 } },
      { name: { value: 'Diastolic' }, value: { value: 80 } },
    ],
  };
  assert.equal(resolveAqlResultPath(source, "items[name/value='Diastolic']/value"), 80);
});

test('combined "at-code and name/value=" predicate requires both to match', () => {
  const source = {
    items: [
      { archetype_node_id: 'at0006', name: { value: 'Wrong name' }, value: { value: 'nope' } },
      { archetype_node_id: 'at0006', name: { value: 'Right name' }, value: { value: 'yes' } },
    ],
  };
  assert.equal(resolveAqlResultPath(source, "items[at0006 and name/value='Right name']/value"), 'yes');
});

test('predicate on a non-array object filters it out entirely when it does not match', () => {
  const source = { item: { archetype_node_id: 'at0001', value: { value: 'x' } } };
  assert.equal(resolveAqlResultPath(source, 'item[at0006]/value'), undefined);
});

test('predicate on a non-array object passes it through when it matches', () => {
  const source = { item: { archetype_node_id: 'at0006', value: { value: 'x' } } };
  assert.equal(resolveAqlResultPath(source, 'item[at0006]/value'), 'x');
});

test('no array entry matches the predicate -> undefined, not a crash', () => {
  const source = { items: [{ archetype_node_id: 'at0001', value: { value: 'x' } }] };
  assert.equal(resolveAqlResultPath(source, 'items[at0999]/value'), undefined);
});

test('unwraps a plain DV_* value object (string/number/boolean) at the end of the path', () => {
  assert.equal(resolveAqlResultPath({ v: { value: 'text' } }, 'v'), 'text');
  assert.equal(resolveAqlResultPath({ v: { value: 42 } }, 'v'), 42);
  assert.equal(resolveAqlResultPath({ v: { value: true } }, 'v'), true);
});

test('unwraps a DV_CODED_TEXT to its plain string value', () => {
  const source = { v: { _type: 'DV_CODED_TEXT', value: 'Active', defining_code: { code_string: 'at0.1' } } };
  assert.equal(resolveAqlResultPath(source, 'v'), 'Active');
});

test('unwraps a CODE_PHRASE to its code_string', () => {
  const source = { v: { _type: 'CODE_PHRASE', code_string: 'F16.0', terminology_id: { value: 'icd-10-gm' } } };
  assert.equal(resolveAqlResultPath(source, 'v'), 'F16.0');
});

test('an object with no unwrappable shape is returned as-is (caller decides what to do with it)', () => {
  const source = { v: { nested: 'structure', without: 'a value key' } };
  assert.deepEqual(resolveAqlResultPath(source, 'v'), { nested: 'structure', without: 'a value key' });
});

test('a realistic multi-segment AQL row: array index into a nested predicate-selected item', () => {
  const source = {
    rows: [
      {
        a: {
          items: [
            { archetype_node_id: 'at0005', name: { value: 'Diastolic' }, value: { value: 80, _type: 'DV_QUANTITY' } },
            { archetype_node_id: 'at0004', name: { value: 'Systolic' }, value: { value: 120, _type: 'DV_QUANTITY' } },
          ],
        },
      },
    ],
  };
  assert.equal(resolveAqlResultPath(source, "rows/0/a/items[at0004 and name/value='Systolic']/value"), 120);
});
