const assert = require('node:assert/strict');
const test = require('node:test');
const { auditFormBindings } = require('../dist');

// A minimal but realistic WebTemplate tree - a DV_TEXT leaf and a
// DV_CODED_TEXT leaf with a two-value code list, both under a COMPOSITION
// root, mirroring the shape buildOpenEhrPathMap/webTemplateParser already
// walk in production.
function currentTemplateTree() {
  return {
    id: 'diag', rmType: 'COMPOSITION', aqlPath: '',
    children: [
      { id: 'diagnosis_name', rmType: 'DV_TEXT', aqlPath: '/content/data/items[at0002]' },
      {
        id: 'severity', rmType: 'DV_CODED_TEXT', aqlPath: '/content/data/items[at0005]',
        inputs: [{ suffix: 'code', list: [{ value: 'at0047' }, { value: 'at0048' }, { value: 'at0049' }] }],
      },
    ],
  };
}

function formDefinition(overrides = {}) {
  return {
    layout: {
      type: 'form',
      children: [
        { id: 'diagnosis_name', type: 'input-text', binding: { path: '/content/data/items[at0002]', rmType: 'DV_TEXT' } },
        {
          id: 'severity', type: 'input-select',
          binding: { path: '/content/data/items[at0005]', rmType: 'DV_CODED_TEXT' },
          options: [{ value: 'at0047', text: 'Mild' }, { value: 'at0048', text: 'Moderate' }],
        },
        ...(overrides.extraChildren || []),
      ],
    },
  };
}

test('a Form Section whose bindings still match the current template produces zero findings', () => {
  const findings = auditFormBindings(formDefinition(), currentTemplateTree());
  assert.deepEqual(findings, []);
});

test('a binding path removed/restructured in the current template is flagged unresolved-path', () => {
  const def = formDefinition({
    extraChildren: [{ id: 'old_field', type: 'input-text', binding: { path: '/content/data/items[at0099]', rmType: 'DV_TEXT' } }],
  });
  const findings = auditFormBindings(def, currentTemplateTree());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fieldId, 'old_field');
  assert.equal(findings[0].issue, 'unresolved-path');
});

test('a binding whose rmType no longer matches the current template node is flagged rmtype-mismatch', () => {
  const def = {
    layout: {
      type: 'form',
      children: [
        // The template now has a DV_TEXT here, but the Form Section still
        // expects a DV_CODED_TEXT (e.g. the archetype dropped a value set).
        { id: 'diagnosis_name', type: 'input-select', binding: { path: '/content/data/items[at0002]', rmType: 'DV_CODED_TEXT' } },
      ],
    },
  };
  const findings = auditFormBindings(def, currentTemplateTree());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue, 'rmtype-mismatch');
  assert.match(findings[0].detail, /DV_TEXT/);
});

test('a stored option no longer present in the current template value set is flagged stale-option', () => {
  const def = formDefinition({
    extraChildren: [],
  });
  def.layout.children[1].options.push({ value: 'at0999', text: 'Retired option' });
  const findings = auditFormBindings(def, currentTemplateTree());
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fieldId, 'severity');
  assert.equal(findings[0].issue, 'stale-option');
  assert.match(findings[0].detail, /at0999/);
});

test('a repeatable container carrying its own binding (the generator shape) is audited too, not just leaves', () => {
  const template = {
    id: 'lab', rmType: 'COMPOSITION', aqlPath: '',
    children: [{
      id: 'result', rmType: 'CLUSTER', aqlPath: '/content/data/items[CLUSTER.result]',
      children: [{ id: 'value', rmType: 'DV_TEXT', aqlPath: '/content/data/items[CLUSTER.result]/items[at0001]' }],
    }],
  };
  const def = {
    layout: {
      type: 'form',
      children: [{
        id: 'result', type: 'container', repeatable: true,
        binding: { path: '/content/data/items[CLUSTER.gone]', rmType: 'CLUSTER' }, // stale path
        children: [{ id: 'value', type: 'input-text', binding: { path: '/content/data/items[CLUSTER.result]/items[at0001]', rmType: 'DV_TEXT' } }],
      }],
    },
  };
  const findings = auditFormBindings(def, template);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].fieldId, 'result');
  assert.equal(findings[0].issue, 'unresolved-path');
});

// DV_QUANTITY: 2026-09-02 addition, complementing the sibling fix to
// formGenerator.ts/webTemplateParser.ts (which used to silently drop
// per-unit min/max/precision when generating a field) and to validateOne
// (which now enforces them as warnings). This audit surfaces the same
// drift for a field that predates either fix - or whose template gained
// range/precision after the field was built.
function quantityTemplateTree(unitList) {
  return {
    id: 'obs', rmType: 'COMPOSITION', aqlPath: '',
    children: [{ id: 'frequenz', rmType: 'DV_QUANTITY', aqlPath: '/content/data/items[at0003]', inputs: [{ suffix: 'unit', list: unitList }] }],
  };
}

function quantityFormDefinition(unitOptions) {
  return { layout: { type: 'form', children: [{ id: 'frequenz', type: 'input-quantity', binding: { path: '/content/data/items[at0003]', rmType: 'DV_QUANTITY' }, unitOptions }] } };
}

test('a DV_QUANTITY field whose stored unit still matches the template and already carries its min/precision produces zero findings', () => {
  const template = quantityTemplateTree([{ value: '1/d', validation: { range: { min: 1 }, precision: { max: 0 } } }]);
  const def = quantityFormDefinition([{ unit: '1/d', min: 1, precision: 0 }]);
  assert.deepEqual(auditFormBindings(def, template), []);
});

test('a DV_QUANTITY field whose stored unit is no longer offered by the template is flagged stale-unit', () => {
  const template = quantityTemplateTree([{ value: '1/h' }]); // '1/d' retired
  const def = quantityFormDefinition([{ unit: '1/d' }]);
  const findings = auditFormBindings(def, template);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue, 'stale-unit');
  assert.match(findings[0].detail, /1\/d/);
});

test('a DV_QUANTITY field missing a min/precision the template now specifies for its unit is flagged missing-quantity-constraint', () => {
  const template = quantityTemplateTree([{ value: '1/d', validation: { range: { min: 1 }, precision: { max: 0 } } }]);
  const def = quantityFormDefinition([{ unit: '1/d' }]); // predates the extraction fix - no min/precision at all
  const findings = auditFormBindings(def, template);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].issue, 'missing-quantity-constraint');
  assert.match(findings[0].detail, /min 1/);
  assert.match(findings[0].detail, /precision 0/);
});

test('a DV_QUANTITY field that already has SOME but not all of the template\'s current limits is only flagged for what it\'s actually missing', () => {
  const template = quantityTemplateTree([{ value: 'mg', validation: { range: { min: 0, max: 1000 } } }]);
  const def = quantityFormDefinition([{ unit: 'mg', min: 0 }]); // has min, missing max
  const findings = auditFormBindings(def, template);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /max 1000/);
  assert.doesNotMatch(findings[0].detail, /min /);
});

test('a DV_QUANTITY field intentionally narrower than the template (a numeric value present on both sides, just different) is never flagged - only an outright missing limit is', () => {
  const template = quantityTemplateTree([{ value: 'mg', validation: { range: { min: 0, max: 1000 } } }]);
  const def = quantityFormDefinition([{ unit: 'mg', min: 0, max: 500 }]); // deliberately narrower max - a design choice, not drift
  assert.deepEqual(auditFormBindings(def, template), []);
});

test('a DV_QUANTITY field is unaffected when the template specifies no range/precision at all for its unit', () => {
  const template = quantityTemplateTree([{ value: 'mg' }]);
  const def = quantityFormDefinition([{ unit: 'mg' }]);
  assert.deepEqual(auditFormBindings(def, template), []);
});

test('a field with no binding at all (e.g. a plain layout row/column) is silently skipped, not flagged', () => {
  const def = {
    layout: {
      type: 'form',
      children: [{ type: 'row', children: [{ type: 'column', children: [{ id: 'diagnosis_name', type: 'input-text', binding: { path: '/content/data/items[at0002]', rmType: 'DV_TEXT' } }] }] }],
    },
  };
  const findings = auditFormBindings(def, currentTemplateTree());
  assert.deepEqual(findings, []);
});
