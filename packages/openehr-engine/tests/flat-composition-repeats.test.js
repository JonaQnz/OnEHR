const assert = require('node:assert/strict');
const test = require('node:test');
const { fromOpenEhrFlatComposition } = require('../dist');

// QA review finding: readFlatValue's repeat-index regex was `\\d` (a
// literal backslash + "d", matching nothing in a real flat-composition
// key) instead of `\d` (a digit). Every index extraction silently failed,
// so reading back a repeating field returned only its first occurrence -
// every other repeat (e.g. the 2nd/3rd of several diagnoses or
// medications) was discarded on edit/prefill/diff. This is the read path
// used for exactly that.
test('reads back every repeat of a repeating field, not just the first', () => {
  const definition = {
    layout: { type: 'form', children: [] },
    bindings: { note: { openehr: { flatPath: 'section/notes' } } },
  };
  const composition = {
    'section/notes:0': 'first note',
    'section/notes:1': 'second note',
    'section/notes:2': 'third note',
  };
  const values = fromOpenEhrFlatComposition(definition, composition);
  assert.deepEqual(values.note, ['first note', 'second note', 'third note']);
});

test('still reads a single (non-repeating) value correctly', () => {
  const definition = {
    layout: { type: 'form', children: [] },
    bindings: { note: { openehr: { flatPath: 'section/notes' } } },
  };
  const composition = { 'section/notes': 'only note' };
  const values = fromOpenEhrFlatComposition(definition, composition);
  assert.equal(values.note, 'only note');
});
