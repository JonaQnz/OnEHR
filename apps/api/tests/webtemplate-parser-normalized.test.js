'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWebTemplate } = require('../dist/parsers/webTemplateParser');

// These regressions pin the output of the parts of webTemplateParser that
// now delegate to openehr-engine's pure WebTemplate normalizer
// (wtCardinality / wtUnitInput / wtUnitOptions / wtNumericConstraint /
// wtCodeListInput). They are deliberately built on small synthetic
// WebTemplates shaped like EHRbase's own export, so each rule is exercised
// on its own rather than through one large published template.

function leaf(id, rmType, aqlPath, extra = {}) {
  return {
    id,
    rmType,
    name: id,
    aqlPath,
    min: 0,
    max: 1,
    ...extra,
  };
}

function template(children) {
  return {
    templateId: 'synthetic.v1.0.0',
    tree: {
      id: 'root',
      rmType: 'COMPOSITION',
      name: 'Composition',
      children,
    },
  };
}

function fieldByTechnicalName(parsed, technicalName) {
  const field = parsed.fields.find((f) => f.technicalName === technicalName);
  assert.ok(field, `expected a field with technicalName "${technicalName}"`);
  return field;
}

test('a repeatable CLUSTER with max -1 produces a repeatable layout group with repeatMax -1', () => {
  const parsed = parseWebTemplate(template([
    {
      id: 'repeat_cluster',
      rmType: 'CLUSTER',
      name: 'Wiederholbarer Block',
      aqlPath: '/content[openEHR-EHR-OBSERVATION.demo.v1]/data[at0001]/items[at0010]',
      min: 0,
      max: -1,
      children: [
        leaf('note_a', 'DV_TEXT', '/content[openEHR-EHR-OBSERVATION.demo.v1]/data[at0001]/items[at0010]/items[at0011]'),
        leaf('note_b', 'DV_TEXT', '/content[openEHR-EHR-OBSERVATION.demo.v1]/data[at0001]/items[at0010]/items[at0012]'),
      ],
    },
  ]));

  function findContainer(node, id) {
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = findContainer(child, id);
      if (found) return found;
    }
    return undefined;
  }

  const group = findContainer(parsed.layout, 'repeat_cluster');
  assert.ok(group, 'expected the repeatable cluster in the layout tree');
  assert.equal(group.type, 'container');
  assert.equal(group.repeatable, true);
  assert.equal(group.repeatMin, 0);
  assert.equal(group.repeatMax, -1);
});

test('a DV_QUANTITY with a unit_code input exposes constraints.units and unitOptions with range/precision', () => {
  const parsed = parseWebTemplate(template([
    leaf('body_weight', 'DV_QUANTITY', '/content[openEHR-EHR-OBSERVATION.demo.v1]/data[at0001]/items[at0004]', {
      inputs: [
        {
          suffix: 'unit_code',
          list: [
            { value: 'kg', validation: { range: { min: 0, max: 300, minOp: '>' }, precision: { max: 1 } } },
          ],
        },
      ],
    }),
  ]));

  const field = fieldByTechnicalName(parsed, 'body_weight');
  assert.deepEqual(field.constraints.units, ['kg']);
  assert.deepEqual(field.constraints.unitOptions, [
    { unit: 'kg', min: 0, max: 300, minexclusive: true, precision: 1 },
  ]);
});

test('a DV_INTERVAL<DV_QUANTITY> unions the lower and upper unit lists into intervalUnitOptions', () => {
  const parsed = parseWebTemplate(template([
    {
      id: 'dose',
      rmType: 'DV_INTERVAL<DV_QUANTITY>',
      name: 'Dosis',
      aqlPath: '/content[openEHR-EHR-OBSERVATION.demo.v1]/data[at0001]/items[at0144]',
      min: 0,
      max: 1,
      children: [
        {
          id: 'lower',
          rmType: 'DV_QUANTITY',
          inputs: [{ suffix: 'unit', list: [{ value: 'kg' }, { value: 'g', validation: { range: { max: 500 } } }] }],
        },
        {
          id: 'upper',
          rmType: 'DV_QUANTITY',
          // 'kg' again: the first child seen wins for the same unit.
          inputs: [{ suffix: 'units', list: [{ value: 'kg', validation: { range: { max: 300 } } }, { value: 'mg' }] }],
        },
      ],
    },
  ]));

  const field = fieldByTechnicalName(parsed, 'dose');
  assert.deepEqual(field.constraints.intervalUnitOptions, [
    { unit: 'kg' },
    { unit: 'g', max: 500 },
    { unit: 'mg' },
  ]);
});

test('a DV_COUNT with inputs[0].validation.range {min:1, minOp:">"} gives constraints.min 1 and minexclusive', () => {
  const parsed = parseWebTemplate(template([
    leaf('order', 'DV_COUNT', '/content[openEHR-EHR-OBSERVATION.demo.v1]/data[at0001]/items[at0164]', {
      inputs: [{ type: 'INTEGER', validation: { range: { min: 1, minOp: '>' } } }],
    }),
  ]));

  const field = fieldByTechnicalName(parsed, 'order');
  assert.equal(field.constraints.min, 1);
  assert.equal(field.constraints.minexclusive, true);
  assert.equal(field.constraints.max, undefined);
});

test('a DV_CODED_TEXT whose code input is inputs[1] takes its options from inputs[1]', () => {
  const parsed = parseWebTemplate(template([
    leaf('status', 'DV_CODED_TEXT', '/content[openEHR-EHR-EVALUATION.demo.v1]/data[at0001]/items[at0006]', {
      inputs: [
        { type: 'TEXT', list: [{ value: 'ignored', label: 'Ignored' }] },
        { suffix: 'code', list: [{ value: 'at0007', label: 'Alpha' }] },
      ],
    }),
  ]));

  const field = fieldByTechnicalName(parsed, 'status');
  assert.deepEqual(field.options, [{ value: 'at0007', text: 'Alpha' }]);
});
