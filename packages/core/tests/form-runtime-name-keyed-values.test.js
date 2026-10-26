const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRuntimeValues } = require('../dist');

// Regression for a bug found live (clinician agent, Petra Hoffmann case,
// docs/simulation/issues/petra-hoffmann-copd-1.md): forms whose fields have
// a layout `id` distinct from their `name` (the prefixed key used by the
// canonical `bindings` map, by formScript's FieldId type, and by whatever
// wrote the session - e.g. the MCP `patch_form_session` tool) were reported
// as permanently "required" even when correctly populated under `name`,
// because validateRuntimeValues only ever read `values[field.id]`.
// toOpenEhrFlatComposition already tolerated both keys (see
// openehr-engine/src/index.ts's layout-id-then-bindings-map fallback), so a
// name-keyed session was silently convertible the whole time - it just
// could never get past this check to find out.
function flatForm() {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [
          { type: 'input-text', id: 'test_name', name: 'vg_observationlab.v1.2.0_test_name', label: 'Testname', required: true },
        ],
      }],
    },
  };
}

function groupedForm() {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container', id: 'any_event', label: 'Any event', repeatable: true, repeatMin: 1, repeatMax: -1,
        children: [
          { type: 'input-text', id: 'study_name', name: 'diagnostik-befund_study_name', label: 'Study name', required: true, repeatableGroupId: 'any_event' },
        ],
      }],
    },
  };
}

test('a flat required field populated only under its name key (not its id) still validates', () => {
  const nameKeyed = validateRuntimeValues(flatForm(), { 'vg_observationlab.v1.2.0_test_name': 'Blutbild' });
  assert.equal(nameKeyed.valid, true, 'a name-keyed value must satisfy the required check');
  assert.deepEqual(nameKeyed.issues, []);

  // id-keyed values keep working exactly as before.
  const idKeyed = validateRuntimeValues(flatForm(), { test_name: 'Blutbild' });
  assert.equal(idKeyed.valid, true);

  // Neither key present - genuinely missing, must still be flagged.
  const missing = validateRuntimeValues(flatForm(), {});
  assert.equal(missing.valid, false);
  assert.equal(missing.issues[0].code, 'required');
  assert.equal(missing.issues[0].path, 'test_name');
});

test('the id key wins when both id and name keys are present', () => {
  const result = validateRuntimeValues(flatForm(), { test_name: 'Blutbild', 'vg_observationlab.v1.2.0_test_name': 'ignored' });
  assert.equal(result.valid, true);
});

test('a repeat-group entry populated only under its name key still validates', () => {
  const nameKeyed = validateRuntimeValues(groupedForm(), { any_event: [{ 'diagnostik-befund_study_name': 'Röntgen-Thorax' }] });
  assert.equal(nameKeyed.valid, true, 'a name-keyed group-item value must satisfy the required check');

  const missing = validateRuntimeValues(groupedForm(), { any_event: [{}] });
  assert.equal(missing.valid, false);
  assert.equal(missing.issues[0].code, 'required');
});
