const assert = require('node:assert/strict');
const test = require('node:test');
const engine = require('../dist');
const {
  toOpenEhrFlatComposition,
  fromOpenEhrFlatComposition,
  buildOpenEhrPathMap,
  auditFormBindings,
} = engine;

// Module-boundary regressions for the p2 split: the FLAT codec, the WebTemplate
// path index and the binding audit now live in their own files but must keep
// their public names on the package root and behave exactly as before the move.
const CODE_PATH = '/content/data/items[at0005]';
const GROUP_PATH = '/content/data/events/data/items[CLUSTER.laboratory_test_analyte]';

function templateTree() {
  return {
    id: 'diag', rmType: 'COMPOSITION', aqlPath: '',
    children: [
      { id: 'diagnosis_name', rmType: 'DV_TEXT', aqlPath: '/content/data/items[at0002]' },
      {
        id: 'severity', rmType: 'DV_CODED_TEXT', aqlPath: CODE_PATH,
        inputs: [{ suffix: 'code', list: [{ value: 'at0047' }, { value: 'at0048' }] }],
      },
    ],
  };
}

test('the moved codec, path index and audit are still public functions on the package root', () => {
  assert.equal(typeof toOpenEhrFlatComposition, 'function');
  assert.equal(typeof fromOpenEhrFlatComposition, 'function');
  assert.equal(typeof buildOpenEhrPathMap, 'function');
  assert.equal(typeof auditFormBindings, 'function');
});

test('layoutFieldBinding stays internal to flatCodec and is not re-exported from index', () => {
  assert.equal(engine.layoutFieldBinding, undefined);
});

test('an inline binding and a legacy {openehr: ...} binding resolve to the same FLAT key', () => {
  const inline = {
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{ id: 'name_legacy', name: 'name_legacy', type: 'input-text', binding: { path: '/content/data/items[at0002]', rmType: 'DV_TEXT' } }],
    },
    bindings: {},
  };
  const wrapped = {
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{ id: 'name_canonical', name: 'name_canonical', type: 'input-text', binding: { openehr: { path: '/content/data/items[at0002]', rmType: 'DV_TEXT' } } }],
    },
    bindings: {},
  };
  const inlineFlat = toOpenEhrFlatComposition(inline, { name_legacy: 'Mammakarzinom links' }, {}, templateTree());
  const wrappedFlat = toOpenEhrFlatComposition(wrapped, { name_canonical: 'Mammakarzinom links' }, {}, templateTree());
  // Both shapes resolve the archetype path through the same path map to the
  // WebTemplate node's own flat path - the legacy envelope must not change
  // which key the value lands on.
  assert.equal(inlineFlat['diag/diagnosis_name'], 'Mammakarzinom links');
  assert.equal(wrappedFlat['diag/diagnosis_name'], 'Mammakarzinom links');
});

test('a name-only field (no id) round-trips through the FLAT codec', () => {
  const def = {
    sourceTemplates: [{ alias: 'diag', id: 'diag.v1', version: '1.0.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{ name: 'diagnosis_name', type: 'input-text', binding: { path: '/content/data/items[at0002]', rmType: 'DV_TEXT' } }],
    },
    bindings: {},
  };
  const flat = toOpenEhrFlatComposition(def, { diagnosis_name: 'Mammakarzinom links' }, {}, templateTree());
  assert.equal(flat['diag/diagnosis_name'], 'Mammakarzinom links');
  const values = fromOpenEhrFlatComposition(def, flat, templateTree());
  assert.equal(values.diagnosis_name, 'Mammakarzinom links');
});

function repeatableDefinition() {
  return {
    sourceTemplates: [{ alias: 'lab', id: 'vg_ObservationLab.v1.2.0', version: '1.2.0', type: 'openEhrWebTemplate' }],
    layout: {
      type: 'form',
      children: [{
        id: 'laboratory_analyte_result', type: 'container', repeatable: true, repeatMin: 1, repeatMax: -1,
        children: [
          { type: 'row', children: [{ type: 'column', children: [
            { id: 'analyte_name', type: 'input-text', binding: { path: `${GROUP_PATH}/items[at0024]`, rmType: 'DV_TEXT' } },
          ] }] },
        ],
      }],
    },
    bindings: {},
  };
}

test('a repeatable group with two rows writes :0/:1 indices and reads both rows back', () => {
  const def = repeatableDefinition();
  const flat = toOpenEhrFlatComposition(def, {
    laboratory_analyte_result: [{ analyte_name: 'Hämoglobin' }, { analyte_name: 'Leukozyten' }],
  });
  assert.equal(flat[`${GROUP_PATH}:0/items[at0024]`], 'Hämoglobin');
  assert.equal(flat[`${GROUP_PATH}:1/items[at0024]`], 'Leukozyten');
  const values = fromOpenEhrFlatComposition(def, flat);
  assert.deepEqual(values.analyte_name, ['Hämoglobin', 'Leukozyten']);
});

function codedForm(extraOptions = []) {
  return {
    layout: {
      type: 'form',
      children: [
        { id: 'diagnosis_name', type: 'input-text', binding: { path: '/content/data/items[at0002]', rmType: 'DV_TEXT' } },
        {
          id: 'severity', type: 'input-select',
          binding: { path: CODE_PATH, rmType: 'DV_CODED_TEXT' },
          options: [{ value: 'at0047', text: 'Mild' }, ...extraOptions],
        },
      ],
    },
  };
}

test('auditFormBindings: a valid binding produces no findings', () => {
  assert.deepEqual(auditFormBindings(codedForm(), templateTree()), []);
});

test('auditFormBindings: a code no longer in the tree is flagged stale-option', () => {
  const findings = auditFormBindings(codedForm([{ value: 'at0999', text: 'Retired option' }]), templateTree());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fieldId, 'severity');
  assert.equal(findings[0].issue, 'stale-option');
  assert.match(findings[0].detail, /at0999/);
});

test('auditFormBindings: a unit no longer offered is flagged stale-unit', () => {
  const template = {
    id: 'obs', rmType: 'COMPOSITION', aqlPath: '',
    children: [{ id: 'frequenz', rmType: 'DV_QUANTITY', aqlPath: '/content/data/items[at0003]', inputs: [{ suffix: 'unit_code', list: [{ value: '1/h' }] }] }],
  };
  const def = {
    layout: {
      type: 'form',
      children: [{ id: 'frequenz', type: 'input-quantity', binding: { path: '/content/data/items[at0003]', rmType: 'DV_QUANTITY' }, unitOptions: [{ unit: '1/d' }] }],
    },
  };
  const findings = auditFormBindings(def, template);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue, 'stale-unit');
  assert.match(findings[0].detail, /1\/d/);
});

test('buildOpenEhrPathMap carries unitOptions from a DV_QUANTITY unit_code input', () => {
  const template = {
    id: 'obs', rmType: 'COMPOSITION', aqlPath: '',
    children: [{
      id: 'frequenz', rmType: 'DV_QUANTITY', aqlPath: '/content/data/items[at0003]',
      inputs: [{ suffix: 'unit_code', list: [{ value: '1/d', validation: { range: { min: 1 }, precision: { max: 0 } } }] }],
    }],
  };
  const mapping = buildOpenEhrPathMap(template).get('/content/data/items[at0003]');
  assert.ok(mapping);
  assert.equal(mapping.flatPath, 'obs/frequenz');
  assert.deepEqual(mapping.unitOptions, [{ unit: '1/d', min: 1, precision: 0 }]);
});

test('buildOpenEhrPathMap omits unitOptions when the DV_QUANTITY unit list is empty', () => {
  const template = {
    id: 'obs', rmType: 'COMPOSITION', aqlPath: '',
    children: [{ id: 'frequenz', rmType: 'DV_QUANTITY', aqlPath: '/content/data/items[at0003]', inputs: [{ suffix: 'unit_code', list: [] }] }],
  };
  const mapping = buildOpenEhrPathMap(template).get('/content/data/items[at0003]');
  assert.ok(mapping);
  assert.equal(mapping.unitOptions, undefined);
});
