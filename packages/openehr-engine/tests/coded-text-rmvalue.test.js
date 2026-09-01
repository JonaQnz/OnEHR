const assert = require('node:assert/strict');
const test = require('node:test');
const { toOpenEhrFlatComposition } = require('../dist');

// Live bug (2026-09-01): submitting "Diagnose (Basis)" failed against
// EHRbase with "DV_CODED_TEXT/value does not match. expected: Suspected;
// found: Vermutet" (and Active/Aktiv, Working/In Bearbeitung). EHRbase's
// FLAT-composition validator checks a submitted DV_CODED_TEXT.value against
// the archetype's ORIGINAL/default-language term text (English, for these
// archetypes) regardless of the UI's display language - but setFlatValue
// was writing `option.text`, which is the German-first *display* text (see
// webTemplateParser's preferredOptionText). Options now carry a separate
// `rmValue` (the original-language text, from webTemplateParser's
// originalLanguageOptionText) that setFlatValue must prefer over `text`.
const PATH = '/content/data/items[at0073]';

function definition(options) {
  return {
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{
        id: 'diagnose_sicherheit', type: 'input-select',
        binding: { path: PATH, rmType: 'DV_CODED_TEXT' },
        options,
      }],
    },
    bindings: {},
  };
}

test('a coded option with a distinct rmValue serializes the RM value, not the German display text', () => {
  const options = [
    { value: 'at0074', text: 'Vermutet', rmValue: 'Suspected' },
    { value: 'at0075', text: 'Wahrscheinlich', rmValue: 'Probable' },
    { value: 'at0076', text: 'Bestätigt', rmValue: 'Confirmed' },
  ];
  const flat = toOpenEhrFlatComposition(definition(options), { diagnose_sicherheit: 'at0074' });
  assert.equal(flat[`${PATH}|code`], 'at0074');
  assert.equal(flat[`${PATH}|value`], 'Suspected', 'must write the archetype\'s original-language term text, not the German UI label');
  assert.equal(flat[`${PATH}|terminology`], 'local');
});

test('a coded option with no rmValue (English-default template, no separate translation) still serializes text as before', () => {
  const options = [
    { value: 'at0047', text: 'Mild' },
    { value: 'at0048', text: 'Moderate' },
    { value: 'at0049', text: 'Severe' },
  ];
  const flat = toOpenEhrFlatComposition(definition(options), { diagnose_sicherheit: 'at0048' });
  assert.equal(flat[`${PATH}|value`], 'Moderate');
});
