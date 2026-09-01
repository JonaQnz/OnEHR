'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildConstraintModelFromWebTemplate, buildRuntimeValue, serializeRuntimeValue, deserializeRuntimeValue, RuntimeValueError } = require('../dist/index.js');

const webTemplate = require(path.join(__dirname, 'fixtures', 'vg_Diagnosis.v1.1.1.webtemplate.json'));

function findAllInstances(instances, out = []) {
  for (const instance of instances) { out.push(instance); findAllInstances(instance.children, out); }
  return out;
}

function fieldByNodeId(model, instanceKeyIncludes, nodeId) {
  const instances = findAllInstances(model.archetypeInstances);
  const instance = instances.find((i) => i.instanceKey.includes(instanceKeyIncludes));
  return instance.fields.find((f) => f.nodeId === nodeId);
}

function model() {
  return buildConstraintModelFromWebTemplate(webTemplate, { language: 'de' });
}

test('DV_TEXT roundtrip: problem/diagnosis name (at0002)', () => {
  const field = fieldByNodeId(model(), 'primary diagnosis', 'at0002');
  const constraint = field.valueConstraints.find((c) => c.rmType === 'DV_TEXT');
  const runtime = buildRuntimeValue(constraint, 'Diabetes mellitus Typ 2');
  assert.deepEqual(runtime, { _type: 'DV_TEXT', value: 'Diabetes mellitus Typ 2' });
  const rm = serializeRuntimeValue(runtime);
  const roundtripped = deserializeRuntimeValue(rm);
  assert.deepEqual(roundtripped, runtime);
});

test('DV_CODED_TEXT roundtrip (closed local value set): severity = "Mäßig" (at0048)', () => {
  const field = fieldByNodeId(model(), 'primary diagnosis', 'at0005');
  const constraint = field.valueConstraints.find((c) => c.rmType === 'DV_CODED_TEXT');
  const runtime = buildRuntimeValue(constraint, 'at0048');
  assert.deepEqual(runtime, {
    _type: 'DV_CODED_TEXT',
    value: 'Mäßig',
    defining_code: { terminology_id: { value: 'local' }, code_string: 'at0048' },
  });
  const rm = serializeRuntimeValue(runtime);
  assert.deepEqual(deserializeRuntimeValue(rm), runtime);
});

test('DV_CODED_TEXT rejects a code from the WRONG scope (at0064, valid in problem_qualifier.v2, not in severity\'s own at0047/48/49 set)', () => {
  const field = fieldByNodeId(model(), 'primary diagnosis', 'at0005');
  const constraint = field.valueConstraints.find((c) => c.rmType === 'DV_CODED_TEXT');
  assert.throws(() => buildRuntimeValue(constraint, 'at0064'), RuntimeValueError);
});

test('SCOPE COLLISION does not leak into runtime values either: at0076 serializes with the correct text depending on which field\'s constraint built it', () => {
  const m = model();
  const certaintyField = fieldByNodeId(m, 'primary diagnosis', 'at0073');
  const certainty = certaintyField.valueConstraints.find((c) => c.rmType === 'DV_CODED_TEXT');
  const primary = findAllInstances(m.archetypeInstances).find((i) => i.instanceKey.includes('primary diagnosis'));
  const qualifier = primary.children.find((c) => c.archetypeId.includes('problem_qualifier'));
  const categoryField = qualifier.fields.find((f) => f.nodeId === 'at0063');
  const category = categoryField.valueConstraints.find((c) => c.rmType === 'DV_CODED_TEXT');

  const certaintyValue = buildRuntimeValue(certainty, 'at0076');
  const categoryValue = buildRuntimeValue(category, 'at0076');
  assert.equal(certaintyValue.value, 'Bestätigt');
  assert.equal(categoryValue.value, 'Komplikation');
  assert.notEqual(certaintyValue.value, categoryValue.value);
});

test('DV_BOOLEAN roundtrip: admission diagnosis boolean alternative', () => {
  const runtime = buildRuntimeValue({ rmType: 'DV_BOOLEAN' }, true);
  assert.deepEqual(runtime, { _type: 'DV_BOOLEAN', value: true });
  assert.deepEqual(deserializeRuntimeValue(serializeRuntimeValue(runtime)), runtime);
});

test('DV_CODED_TEXT roundtrip: admission diagnosis coded alternative (at0108 = Ja)', () => {
  const primary = findAllInstances(model().archetypeInstances).find((i) => i.instanceKey.includes('primary diagnosis'));
  const qualifier = primary.children.find((c) => c.archetypeId.includes('problem_qualifier'));
  const admission = qualifier.fields.find((f) => f.nodeId === 'at0073');
  const coded = admission.valueConstraints.find((c) => c.rmType === 'DV_CODED_TEXT');
  const runtime = buildRuntimeValue(coded, 'at0108');
  assert.equal(runtime.value, 'Ja');
  assert.deepEqual(deserializeRuntimeValue(serializeRuntimeValue(runtime)), runtime);
});

test('a DV_TEXT alternative can still be stored for a coded-or-free-text field (severity as free text)', () => {
  const field = fieldByNodeId(model(), 'primary diagnosis', 'at0005');
  const textConstraint = field.valueConstraints.find((c) => c.rmType === 'DV_TEXT');
  const runtime = buildRuntimeValue(textConstraint, 'Leicht bis mäßig, wechselnd');
  assert.deepEqual(runtime, { _type: 'DV_TEXT', value: 'Leicht bis mäßig, wechselnd' });
});

test('serializeRuntimeValue rejects a malformed value rather than writing garbage to the wire', () => {
  assert.throws(() => serializeRuntimeValue({ value: 'no _type' }), RuntimeValueError);
});

test('deserializeRuntimeValue rejects malformed/incomplete RM JSON rather than guessing', () => {
  assert.throws(() => deserializeRuntimeValue({ _type: 'DV_CODED_TEXT', value: 'x' }), RuntimeValueError, 'missing defining_code');
  assert.throws(() => deserializeRuntimeValue({ nope: true }), RuntimeValueError, 'missing _type entirely');
});

test('full pipeline: OPT field -> constraint -> runtime value -> serialize -> deserialize -> same semantic value, for every DV_CODED_TEXT option on diagnostic category', () => {
  const primary = findAllInstances(model().archetypeInstances).find((i) => i.instanceKey.includes('primary diagnosis'));
  const qualifier = primary.children.find((c) => c.archetypeId.includes('problem_qualifier'));
  const category = qualifier.fields.find((f) => f.nodeId === 'at0063');
  const coded = category.valueConstraints.find((c) => c.rmType === 'DV_CODED_TEXT');
  for (const option of coded.options) {
    const runtime = buildRuntimeValue(coded, option.codeString);
    const roundtripped = deserializeRuntimeValue(serializeRuntimeValue(runtime));
    assert.deepEqual(roundtripped, runtime, `roundtrip must be lossless for ${option.codeString}`);
    assert.equal(roundtripped.value, option.text);
    assert.equal(roundtripped.defining_code.code_string, option.codeString);
  }
});
