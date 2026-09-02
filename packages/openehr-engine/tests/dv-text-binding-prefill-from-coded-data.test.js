const assert = require('node:assert/strict');
const test = require('node:test');
const { fromOpenEhrFlatComposition } = require('../dist');

// Live bug (2026-09-02), a second layer of the same underlying issue fixed
// in code-mappings-flat-on-coded-text.test.js's prefill test: some openEHR
// archetype nodes are a genuine union type - free DV_TEXT OR coded
// DV_CODED_TEXT (see coded-text-free-text-fallback.test.js) - and different
// forms bound to the very same archetype path are free to pick either
// alternative. "Kodierte Diagnose" binds problem_diagnosis_name as plain
// DV_TEXT (no codeMappings at all), while "Diagnose (Basis)" binds the very
// same path as DV_CODED_TEXT with codeMappings.enabled. When a patient's
// diagnosis was originally entered via "Diagnose (Basis)", the node is
// committed to the RM as a real DV_CODED_TEXT with defining_code, so
// EHRbase's own FLAT rendering on GET emits the ordinary |value/|code/
// |terminology sibling triple for that path - even though "Kodierte
// Diagnose"'s own binding is plain DV_TEXT and never writes that shape
// itself (see code-mappings-flat.test.js). readFlatValue's rmType branch
// only special-cased DV_QUANTITY and DV_CODED_TEXT/CODE_PHRASE; a plain
// DV_TEXT binding fell into a bare `value = flat[key]` on whichever
// matching key Object.keys() happened to list first - here `|code`,
// showing "I10" in the Diagnose field instead of "Arterielle Hypertonie".
const PATH = '/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1]/data[at0001]/items[at0002]/value';

function plainTextDefinition() {
  return {
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{
        id: 'diagnose_name', type: 'input-text',
        binding: { path: PATH, rmType: 'DV_TEXT' },
      }],
    },
    bindings: {},
  };
}

test('a plain DV_TEXT binding reads the human-readable |value sibling, not |code, when the underlying node was actually committed as DV_CODED_TEXT', () => {
  const flat = {
    [`${PATH}|value`]: 'Arterielle Hypertonie',
    [`${PATH}|code`]: 'I10',
    [`${PATH}|terminology`]: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm',
  };
  const values = fromOpenEhrFlatComposition(plainTextDefinition(), flat);
  assert.equal(values.diagnose_name, 'Arterielle Hypertonie');
});

test('a plain DV_TEXT binding still reads an ordinary bare-path value untouched (the common case, no coded siblings at all)', () => {
  const flat = { [PATH]: 'Nur Freitext, keine Kodierung' };
  const values = fromOpenEhrFlatComposition(plainTextDefinition(), flat);
  assert.equal(values.diagnose_name, 'Nur Freitext, keine Kodierung');
});

test('order independence: the fix does not depend on |value happening to sort before |code in the flat object', () => {
  // Object.keys() preserves insertion order - deliberately insert |code
  // first (the exact order EHRbase returned in the live repro) to prove
  // the fix isn't accidentally relying on the OTHER key order winning.
  const flat = {};
  flat[`${PATH}|code`] = 'I10';
  flat[`${PATH}|terminology`] = 'http://fhir.de/CodeSystem/dimdi/icd-10-gm';
  flat[`${PATH}|value`] = 'Arterielle Hypertonie';
  const values = fromOpenEhrFlatComposition(plainTextDefinition(), flat);
  assert.equal(values.diagnose_name, 'Arterielle Hypertonie');
});
