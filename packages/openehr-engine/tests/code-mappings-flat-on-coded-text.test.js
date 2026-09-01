const assert = require('node:assert/strict');
const test = require('node:test');
const { toOpenEhrFlatComposition } = require('../dist');

// Live bug (2026-09-01): "Diagnose (Basis)"'s diagnose_name - a real
// production field, WebTemplate rmType DV_CODED_TEXT with codeMappings
// enabled (the "HIP converter is king" dual-encoding, see
// canonicalComposition.ts's buildLeafDvValue comment) - was submitted to
// EHRbase with a free-text diagnosis name written into `|code` (a "local"
// CODE_PHRASE code_string that's actually a sentence), because setFlatValue's
// DV_CODED_TEXT branch always returned before the codeMappings.enabled check
// further down could ever run. EHRbase rejected the whole composition with
// "Could not consume Parts" for every field, not just this one.
// code-mappings-flat.test.js already covers this convention for a DV_TEXT-
// bound field; this covers the DV_CODED_TEXT-bound case specifically, since
// that's exactly the shape that was unreachable. Fixing this original bug
// surfaced a second one on the very next live submission attempt: the
// `mappings/N` group itself was being written as `_mappings/N` (a guessed,
// unverified convention) - EHRbase rejected that too. Both are fixed here.
const PATH = '/content/data/items[at0002]';

function definition() {
  return {
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{
        id: 'diagnose_name', type: 'input-text',
        binding: { path: PATH, rmType: 'DV_CODED_TEXT' },
        codeMappings: { enabled: true, terminologies: [{ id: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', label: 'ICD-10-GM' }] },
      }],
    },
    bindings: {},
  };
}

test('a DV_CODED_TEXT-bound codeMappings.enabled field writes the bare-path/mappings convention, never |code/|value/|terminology', () => {
  const flat = toOpenEhrFlatComposition(definition(), {
    diagnose_name: { value: 'Pneumonie, nicht näher bezeichnet', mappings: [{ terminologyId: 'http://fhir.de/CodeSystem/dimdi/icd-10-gm', code: 'J18.9' }] },
  });
  assert.equal(flat[PATH], 'Pneumonie, nicht näher bezeichnet');
  assert.equal(flat[`${PATH}/mappings/0/target|code`], 'J18.9');
  assert.equal(flat[`${PATH}/mappings/0/target|terminology`], 'http://fhir.de/CodeSystem/dimdi/icd-10-gm');
  assert.equal(flat[`${PATH}/mappings/0|match`], '=');
  // The bug's exact symptom: free text must never land in a CODE_PHRASE key.
  assert.equal(flat[`${PATH}|code`], undefined);
  assert.equal(flat[`${PATH}|value`], undefined);
  assert.equal(flat[`${PATH}|terminology`], undefined);
});

test('a DV_CODED_TEXT-bound codeMappings.enabled field with no value yet writes nothing', () => {
  const flat = toOpenEhrFlatComposition(definition(), {});
  assert.equal(Object.keys(flat).filter((key) => key.startsWith(PATH)).length, 0);
});
