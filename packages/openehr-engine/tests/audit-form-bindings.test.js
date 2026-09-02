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
