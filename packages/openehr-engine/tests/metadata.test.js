const assert = require('node:assert/strict');
const test = require('node:test');
const {
  parseOpenEhrAqlPath,
  toArchetypePath,
  getElementMetadata,
  getArchetypePath,
  getTemplatePath,
  getAqlPath,
  resolveElementByPath,
  resolveElementsByNodeId,
} = require('../dist');

// Test 1 - basic DV_TEXT node
test('parseOpenEhrAqlPath extracts archetypeNodeId for a basic DV_TEXT node', () => {
  const parsed = parseOpenEhrAqlPath('/content[openEHR-EHR-ADMIN_ENTRY.person_data.v0]/data[at0001]/items[at0002]');
  assert.equal(parsed.archetypeNodeId, 'at0002');
  assert.equal(parsed.archetypeId, 'openEHR-EHR-ADMIN_ENTRY.person_data.v0');
  assert.equal(parsed.rmVersion, 'v0');
});

// Test 2 - DV_QUANTITY: metadata + value preserved (value roundtrip itself
// is already covered by composition-roundtrip.golden.test.js; this checks
// the metadata side specifically, using the user's own worked example).
test('DV_QUANTITY node keeps its full metadata (systolic blood pressure example)', () => {
  const layout = {
    type: 'form', id: 'root', children: [{
      type: 'input-quantity', id: 'systolic', label: 'Systolischer Blutdruck',
      binding: {
        templateAlias: 'bp', rmType: 'DV_QUANTITY',
        path: '/content[openEHR-EHR-OBSERVATION.blood_pressure.v2]/data[at0001]/events[at0006]/data[at0003]/items[at0004]',
        flatPath: 'bp/blood_pressure/any_event/systolic',
        archetypeNodeId: 'at0004', archetypeId: 'openEHR-EHR-OBSERVATION.blood_pressure.v2', rmVersion: 'v2',
      },
    }],
  };
  const metadata = getElementMetadata({ layout }, 'systolic');
  assert.equal(metadata.rmType, 'DV_QUANTITY');
  assert.equal(metadata.archetypeNodeId, 'at0004');
  assert.equal(getArchetypePath({ layout }, 'systolic'), '/data[at0001]/events[at0006]/data[at0003]/items[at0004]');
  assert.equal(getTemplatePath({ layout }, 'systolic'), 'bp/blood_pressure/any_event/systolic');
  assert.equal(getAqlPath({ layout }, 'systolic'), metadata.path);
});

// Test 3 - repeating cluster: same archetypeNodeId, distinct runtime identity
test('repeating Medication instances share archetypeNodeId but resolve to distinct nodes', () => {
  const medicationBinding = (id) => ({
    templateAlias: 'meds', rmType: 'CLUSTER',
    path: `/content[openEHR-EHR-INSTRUCTION.medication_order.v3]/activities[at0001]/description[at0002]/items[${id}]`,
    archetypeNodeId: 'at0009', archetypeId: 'openEHR-EHR-CLUSTER.medication.v1', rmVersion: 'v1',
  });
  const layout = {
    type: 'form', id: 'root', children: [
      { type: 'container', id: 'medication-0', label: 'Medication', binding: medicationBinding('at0009') },
      { type: 'container', id: 'medication-1', label: 'Medication', binding: medicationBinding('at0009') },
      { type: 'container', id: 'medication-2', label: 'Medication', binding: medicationBinding('at0009') },
    ],
  };
  const instances = resolveElementsByNodeId({ layout }, 'at0009');
  assert.equal(instances.length, 3);
  assert.deepEqual(instances.map((node) => node.id), ['medication-0', 'medication-1', 'medication-2']);
  instances.forEach((node) => assert.equal(node.binding.archetypeNodeId, 'at0009'));
});

// Test 4 - nested structure: OBSERVATION -> CLUSTER -> CLUSTER -> ELEMENT
test('nested OBSERVATION/CLUSTER/CLUSTER/ELEMENT keeps correct parent/path relationships', () => {
  const layout = {
    type: 'form', id: 'obs', binding: { templateAlias: 't', rmType: 'OBSERVATION', path: '/content[openEHR-EHR-OBSERVATION.exam.v1]', archetypeNodeId: 'at0000', archetypeId: 'openEHR-EHR-OBSERVATION.exam.v1', rmVersion: 'v1' },
    children: [{
      type: 'container', id: 'outer-cluster', binding: { templateAlias: 't', rmType: 'CLUSTER', path: '/content[openEHR-EHR-OBSERVATION.exam.v1]/data[at0001]/items[at0002]', archetypeNodeId: 'at0002', archetypeId: 'openEHR-EHR-OBSERVATION.exam.v1', rmVersion: 'v1' },
      children: [{
        type: 'container', id: 'inner-cluster', binding: { templateAlias: 't', rmType: 'CLUSTER', path: '/content[openEHR-EHR-OBSERVATION.exam.v1]/data[at0001]/items[at0002]/items[at0003]', archetypeNodeId: 'at0003', archetypeId: 'openEHR-EHR-OBSERVATION.exam.v1', rmVersion: 'v1' },
        children: [{
          type: 'input-text', id: 'leaf', binding: { templateAlias: 't', rmType: 'DV_TEXT', path: '/content[openEHR-EHR-OBSERVATION.exam.v1]/data[at0001]/items[at0002]/items[at0003]/items[at0004]', archetypeNodeId: 'at0004', archetypeId: 'openEHR-EHR-OBSERVATION.exam.v1', rmVersion: 'v1' },
        }],
      }],
    }],
  };
  assert.equal(getElementMetadata({ layout }, 'leaf').archetypeNodeId, 'at0004');
  assert.equal(getArchetypePath({ layout }, 'leaf'), '/data[at0001]/items[at0002]/items[at0003]/items[at0004]');
  assert.equal(getElementMetadata({ layout }, 'inner-cluster').rmType, 'CLUSTER');
  assert.equal(getElementMetadata({ layout }, 'outer-cluster').rmType, 'CLUSTER');
  assert.equal(getElementMetadata({ layout }, 'obs').rmType, 'OBSERVATION');
  const found = resolveElementByPath({ layout }, '/content[openEHR-EHR-OBSERVATION.exam.v1]/data[at0001]/items[at0002]/items[at0003]/items[at0004]');
  assert.equal(found.id, 'leaf');
});

// Test 5 + 6 - label override / translation must never change technical identity
test('changing a field label or translation never changes its openEHR identity', () => {
  const binding = { templateAlias: 'bp', rmType: 'DV_QUANTITY', path: '/content[openEHR-EHR-OBSERVATION.blood_pressure.v2]/data[at0001]/events[at0006]/data[at0003]/items[at0004]', flatPath: 'bp/blood_pressure/any_event/systolic', archetypeNodeId: 'at0004', archetypeId: 'openEHR-EHR-OBSERVATION.blood_pressure.v2', rmVersion: 'v2' };
  const before = { layout: { type: 'form', id: 'root', children: [{ type: 'input-quantity', id: 'systolic', label: 'Blood pressure', binding }] } };
  const afterRelabel = { layout: { type: 'form', id: 'root', children: [{ type: 'input-quantity', id: 'systolic', label: 'RR', binding }] } };
  const afterTranslate = { layout: { type: 'form', id: 'root', children: [{ type: 'input-quantity', id: 'systolic', label: 'Blutdruck', binding }] } };

  for (const variant of [afterRelabel, afterTranslate]) {
    assert.deepEqual(getElementMetadata(before, 'systolic'), getElementMetadata(variant, 'systolic'));
    assert.equal(getArchetypePath(before, 'systolic'), getArchetypePath(variant, 'systolic'));
    assert.equal(getTemplatePath(before, 'systolic'), getTemplatePath(variant, 'systolic'));
    assert.equal(getAqlPath(before, 'systolic'), getAqlPath(variant, 'systolic'));
  }
});
