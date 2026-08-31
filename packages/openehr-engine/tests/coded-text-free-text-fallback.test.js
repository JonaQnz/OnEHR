const assert = require('node:assert/strict');
const test = require('node:test');
const { toOpenEhrFlatComposition } = require('../dist');

// A DV_CODED_TEXT|DV_TEXT union field (binding.allowFreeText, set at import
// time from the OPT constraint model - see webTemplateParser.ts) whose
// current value doesn't match any of its known `options` must serialize as
// plain DV_TEXT, not as a DV_CODED_TEXT whose code_string is that free text
// (RM-invalid: a "local" terminology code that's actually a sentence). This
// is the live FLAT-format write path (toOpenEhrFlatComposition/setFlatValue
// in index.ts) - the one real single-form submits actually use.
const PATH = '/content/data/items[at0005]';

function definitionFor(allowFreeText) {
  return {
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{
        id: 'severity', type: 'input-select',
        binding: { path: PATH, rmType: 'DV_CODED_TEXT' },
        options: [
          { value: 'at0047', text: 'Mild' },
          { value: 'at0048', text: 'Moderate' },
          { value: 'at0049', text: 'Severe' },
        ],
        ...(allowFreeText ? { allowFreeText: true } : {}),
      }],
    },
    bindings: {},
  };
}

test('a value matching a known option always serializes as a full CODE_PHRASE, regardless of allowFreeText', () => {
  for (const allowFreeText of [false, true]) {
    const flat = toOpenEhrFlatComposition(definitionFor(allowFreeText), { severity: 'at0048' });
    assert.equal(flat[`${PATH}|code`], 'at0048');
    assert.equal(flat[`${PATH}|value`], 'Moderate');
    assert.equal(flat[`${PATH}|terminology`], 'local');
    assert.equal(flat[PATH], undefined);
  }
});

test('allowFreeText:false (default, every existing form) rejects-into-garbage exactly as before - unchanged legacy behavior', () => {
  const flat = toOpenEhrFlatComposition(definitionFor(false), { severity: 'Leicht bis mäßig, wechselnd' });
  // Documents the PRE-EXISTING behavior this fix does not touch for
  // allowFreeText:false fields - still writes a bogus code_string. Not
  // desirable, but changing it would be a behavior change for every
  // existing coded field with no free-text alternative, out of scope here.
  assert.equal(flat[`${PATH}|code`], 'Leicht bis mäßig, wechselnd');
  assert.equal(flat[`${PATH}|terminology`], 'local');
});

test('allowFreeText:true writes an unmatched value as plain DV_TEXT, never a bogus code_string', () => {
  const flat = toOpenEhrFlatComposition(definitionFor(true), { severity: 'Leicht bis mäßig, wechselnd' });
  assert.equal(flat[PATH], 'Leicht bis mäßig, wechselnd');
  assert.equal(flat[`${PATH}|code`], undefined);
  assert.equal(flat[`${PATH}|value`], undefined);
  assert.equal(flat[`${PATH}|terminology`], undefined);
});

test('allowFreeText:true with no value at all writes nothing, same as any other empty field', () => {
  const flat = toOpenEhrFlatComposition(definitionFor(true), {});
  assert.equal(flat[PATH], undefined);
  assert.equal(flat[`${PATH}|code`], undefined);
});
