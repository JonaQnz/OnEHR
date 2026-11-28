'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildConstraintModelFromWebTemplate } = require('../dist/index.js');

// Minimal hand-built WebTemplate JSON exercising the input-selection and
// occurrence rules the shared webTemplate/normalize helpers define - the
// same rules the real vg_Diagnosis.v1.1.1 fixture in
// opt-constraint-model.test.js covers end-to-end.
const ARCHETYPE_ID = 'openEHR-EHR-OBSERVATION.test.v1';

function webTemplateWith(...leaves) {
  return {
    templateId: 'test.v1',
    defaultLanguage: 'en',
    languages: ['en'],
    tree: {
      id: 'test',
      nodeId: ARCHETYPE_ID,
      rmType: 'OBSERVATION',
      aqlPath: `/${ARCHETYPE_ID}`,
      min: 1,
      max: 1,
      children: leaves,
    },
  };
}

function fieldFor(leaf) {
  const model = buildConstraintModelFromWebTemplate(webTemplateWith(leaf));
  const instance = model.archetypeInstances[0];
  assert.ok(instance, 'archetype instance must exist');
  assert.equal(instance.fields.length, 1, 'exactly one leaf field must be built');
  return instance.fields[0];
}

test('DV_QUANTITY leaf: a unit_code input supplies the units list', () => {
  const field = fieldFor({
    id: 'systolic',
    name: 'Systolic',
    nodeId: 'at0004',
    rmType: 'DV_QUANTITY',
    aqlPath: '/data[at0001]/items[at0004]',
    min: 1,
    max: 1,
    inputs: [
      { suffix: 'magnitude' },
      { suffix: 'unit_code', list: [{ value: 'mm[Hg]' }] },
    ],
  });
  assert.deepEqual(field.valueConstraints.map((c) => c.rmType), ['DV_QUANTITY']);
  assert.deepEqual(field.valueConstraints[0].units, ['mm[Hg]']);
});

test('coded leaf: a code input at inputs[1] supplies the options', () => {
  const field = fieldFor({
    id: 'severity',
    name: 'Severity',
    nodeId: 'at0005',
    rmType: 'DV_CODED_TEXT',
    aqlPath: '/data[at0001]/items[at0005]',
    min: 0,
    max: 1,
    inputs: [
      { suffix: 'other', type: 'TEXT' },
      { suffix: 'code', terminology: 'local', list: [{ value: 'at0047', label: 'Mild' }, { value: 'at0048', label: 'Moderate' }] },
    ],
  });
  const coded = field.valueConstraints.find((c) => c.rmType === 'DV_CODED_TEXT');
  assert.ok(coded, 'DV_CODED_TEXT constraint must exist');
  assert.deepEqual(coded.allowedCodes, ['at0047', 'at0048']);
  assert.deepEqual(coded.options.map((o) => o.codeString), ['at0047', 'at0048']);
  assert.deepEqual(coded.options.map((o) => o.text), ['Mild', 'Moderate']);
});

test('leaf with max -1: occurrences.max stays null, never -1', () => {
  const field = fieldFor({
    id: 'note',
    name: 'Note',
    nodeId: 'at0002',
    rmType: 'DV_TEXT',
    aqlPath: '/data[at0001]/items[at0002]',
    min: 0,
    max: -1,
  });
  assert.deepEqual(field.occurrences, { min: 0, max: null });
});

test('leaf without max: occurrences.max is null, not wtCardinality\'s default 1', () => {
  const field = fieldFor({
    id: 'comment',
    name: 'Comment',
    nodeId: 'at0003',
    rmType: 'DV_TEXT',
    aqlPath: '/data[at0001]/items[at0003]',
    min: 0,
  });
  assert.deepEqual(field.occurrences, { min: 0, max: null });
});

test('leaf with min 1 and max 3 keeps { min: 1, max: 3 }', () => {
  const field = fieldFor({
    id: 'tags',
    name: 'Tags',
    nodeId: 'at0006',
    rmType: 'DV_TEXT',
    aqlPath: '/data[at0001]/items[at0006]',
    min: 1,
    max: 3,
  });
  assert.deepEqual(field.occurrences, { min: 1, max: 3 });
});
