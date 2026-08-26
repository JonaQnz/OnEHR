const assert = require('node:assert/strict');
const test = require('node:test');
const { collectRuntimeFields, collectRuntimeGroups } = require('../dist');

// A form generated without a parsed WebTemplate layout (formGenerator.ts's
// fallback path) never writes a `label` onto its layout nodes at all - only
// `type` and `name` - because the field's human-readable label instead lands
// in locales.en[[name='<fieldName>']].label. Before this fix,
// collectRuntimeFields silently fell back to the internal field name (or
// raw id) for any such form, which is what actually rendered in the Live
// Form instead of the real label.
test('a field with no node.label resolves its label from locales.en by field name', () => {
  const form = {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [
          { type: 'input-text', id: 'vg_person.v1.1.1_vorname', name: 'vg_person.v1.1.1_vorname' },
        ],
      }],
    },
    locales: { en: { "[name='vg_person.v1.1.1_vorname']": { label: 'Vorname' } } },
  };
  const [field] = collectRuntimeFields(form);
  assert.equal(field.label, 'Vorname');
});

test('a field with no node.label and no locale entry falls back to its name', () => {
  const form = {
    layout: { type: 'form', children: [{ type: 'container', children: [{ type: 'input-text', id: 'orphan_field' }] }] },
    locales: { en: {} },
  };
  const [field] = collectRuntimeFields(form);
  assert.equal(field.label, 'orphan_field');
});

// node.label must win over locales.en, not the other way around: the
// FormBuilder designer rewrites locales.en wholesale from the canvas on
// every save, but nothing keeps it in sync with a node.label set some other
// way (e.g. a direct API edit) - live data has forms where a curated
// node.label ("Testname") and a stale/default locale entry ("Test name")
// have drifted apart. The curated, currently-live node.label must win.
test('an explicit node.label wins over a stale locales.en entry for the same field', () => {
  const form = {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [
          { type: 'input-text', id: 'test_name', name: 'vg_observationlab.v1.2.0_test_name', label: 'Testname' },
        ],
      }],
    },
    locales: { en: { "[name='vg_observationlab.v1.2.0_test_name']": { label: 'Test name' } } },
  };
  const [field] = collectRuntimeFields(form);
  assert.equal(field.label, 'Testname');
});

test('a repeatable group container resolves its label the same way', () => {
  const form = {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [
          {
            type: 'container', id: 'medications', name: 'medications', repeatable: true,
            children: [{ type: 'input-text', id: 'drug_name', name: 'drug_name' }],
          },
        ],
      }],
    },
    locales: { en: { "[name='medications']": { label: 'Medikamente' } } },
  };
  const [group] = collectRuntimeGroups(form);
  assert.equal(group.label, 'Medikamente');
});
