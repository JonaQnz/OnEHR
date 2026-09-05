const assert = require('node:assert/strict');
const test = require('node:test');
const { toOpenEhrFlatComposition } = require('../dist');

// Real bug found live 2026-09-05 adding the new DV_INTERVAL<DV_QUANTITY>
// "Dosisbereich" field to the real, published "Medikationsabgleich" form:
// every field webTemplateParser generates carries only `.name`, never a
// separate `.id` (confirmed live across all ~24 fields on that form) - the
// same id/name ambiguity already fixed for form-scripting/form-runtime (see
// core/form-runtime's and form-scripting's own `node.id || node.name`
// helpers, and this file's own metadata.ts sibling). toOpenEhrFlatComposition's
// collectFieldBindings() used bare `node.id` only, so it silently registered
// ZERO layoutBindings for a name-only field's inline `node.binding` - such a
// field's value only ever reached EHRbase via the SEPARATE legacy top-level
// `definition.bindings[fieldId]` map, which auto-generated forms happen to
// also populate. A field added directly to the layout (the natural place to
// hand-add one, with no matching legacy bindings-map entry) validated fine
// and "submitted" successfully while its value silently vanished from the
// actual composition - confirmed live via a real EHRbase FLAT readback
// showing the whole archetype item missing, not just malformed.
const PATH = '/content/data/items[at0033]/value';

test('a field whose layout node has only `.name` (no `.id`) - the normal shape webTemplateParser produces - still gets its inline binding used for FLAT write', () => {
  const definition = {
    sourceTemplates: [{ alias: 'med', id: 'med.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{
        // Deliberately no `id` here - this is the point of the test.
        name: 'dose_and_timing',
        type: 'input-text',
        binding: { path: PATH, rmType: 'DV_TEXT' },
      }],
    },
    bindings: {},
  };
  const flat = toOpenEhrFlatComposition(definition, { dose_and_timing: '1-0-1' });
  assert.equal(flat[PATH], '1-0-1');
});

test('the same name-only field is unaffected when it ALSO happens to have an explicit `.id` that differs from `.name` - `.id` still wins', () => {
  const definition = {
    sourceTemplates: [{ alias: 'med', id: 'med.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{
        id: 'explicit_id',
        name: 'dose_and_timing',
        type: 'input-text',
        binding: { path: PATH, rmType: 'DV_TEXT' },
      }],
    },
    bindings: {},
  };
  const flat = toOpenEhrFlatComposition(definition, { explicit_id: '1-0-1', dose_and_timing: 'WRONG - should not be read' });
  assert.equal(flat[PATH], '1-0-1');
});
