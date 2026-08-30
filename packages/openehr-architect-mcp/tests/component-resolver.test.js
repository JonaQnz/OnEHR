import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComponent, resolveComponents } from '../dist/documentTemplate/componentResolver.js';
import { ComponentResolutionError } from '../dist/documentTemplate/types.js';

function archetypeRootXml(rmType, archetypeId, { nodeId = 'at0000', extra = '', name } = {}) {
  const nameAttr = name === undefined ? '' : `<attributes xsi:type="C_SINGLE_ATTRIBUTE"><rm_attribute_name>name</rm_attribute_name><children xsi:type="C_COMPLEX_OBJECT"><rm_type_name>DV_TEXT</rm_type_name><attributes xsi:type="C_SINGLE_ATTRIBUTE"><rm_attribute_name>value</rm_attribute_name><children xsi:type="C_PRIMITIVE_OBJECT"><rm_type_name>STRING</rm_type_name><item xsi:type="C_STRING"><list>${name}</list></item></children></attributes></children></attributes>`;
  return `<children xsi:type="C_ARCHETYPE_ROOT"><rm_type_name>${rmType}</rm_type_name><node_id>${nodeId}</node_id>${nameAttr}${extra}<archetype_id><value>${archetypeId}</value></archetype_id><term_definitions code="at0000"><items id="text">Root</items></term_definitions></children>`;
}

function optDocument(rootsXml) {
  return `<template xmlns="http://schemas.openehr.org/v1"><definition><rm_type_name>COMPOSITION</rm_type_name><attributes xsi:type="C_MULTIPLE_ATTRIBUTE" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><rm_attribute_name>content</rm_attribute_name>${rootsXml}</attributes></definition></template>`;
}

function source(templateId, xml) {
  return { getTemplateOpt: async (id) => { assert.equal(id, templateId); return xml; } };
}

test('resolves a bare EVALUATION as a valid component - not falsely assumed to be a SECTION', async () => {
  const xml = optDocument(archetypeRootXml('EVALUATION', 'openEHR-EHR-EVALUATION.problem_diagnosis.v1'));
  const projection = await resolveComponent(source('vg_Diagnosis.v1.1.1', xml), {
    sourceTemplateId: 'vg_Diagnosis.v1.1.1',
    sourceArchetypeId: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1',
    label: 'Diagnosen',
  });
  assert.equal(projection.rmType, 'EVALUATION');
  assert.equal(projection.sourceArchetypeId, 'openEHR-EHR-EVALUATION.problem_diagnosis.v1');
  assert.equal(projection.node.rm_type_name, 'EVALUATION');
});

test('resolves an already-SECTION component without wrapping being required', async () => {
  const xml = optDocument(archetypeRootXml('SECTION', 'openEHR-EHR-SECTION.adhoc.v1'));
  const projection = await resolveComponent(source('vg_Custom.v1', xml), {
    sourceTemplateId: 'vg_Custom.v1',
    sourceArchetypeId: 'openEHR-EHR-SECTION.adhoc.v1',
    label: 'Custom Section',
  });
  assert.equal(projection.rmType, 'SECTION');
});

test('rejects a CLUSTER as a top-level component with a clear error, does not silently accept it', async () => {
  const xml = optDocument(archetypeRootXml('CLUSTER', 'openEHR-EHR-CLUSTER.problem_qualifier.v2'));
  await assert.rejects(
    resolveComponent(source('vg_X.v1', xml), { sourceTemplateId: 'vg_X.v1', sourceArchetypeId: 'openEHR-EHR-CLUSTER.problem_qualifier.v2', label: 'X' }),
    (error) => {
      assert.ok(error instanceof ComponentResolutionError);
      assert.match(error.message, /CLUSTER/);
      return true;
    },
  );
});

test('rejects an ELEMENT/ITEM_STRUCTURE-shaped node the same way', async () => {
  const xml = optDocument(archetypeRootXml('ITEM_TREE', 'openEHR-EHR-ITEM_TREE.generic.v1'));
  await assert.rejects(resolveComponent(source('vg_X.v1', xml), { sourceTemplateId: 'vg_X.v1', sourceArchetypeId: 'openEHR-EHR-ITEM_TREE.generic.v1', label: 'X' }), ComponentResolutionError);
});

test('fails loudly when the requested archetype_id is not present at all', async () => {
  const xml = optDocument(archetypeRootXml('EVALUATION', 'openEHR-EHR-EVALUATION.problem_diagnosis.v1'));
  await assert.rejects(
    resolveComponent(source('vg_Diagnosis.v1.1.1', xml), { sourceTemplateId: 'vg_Diagnosis.v1.1.1', sourceArchetypeId: 'openEHR-EHR-EVALUATION.does_not_exist.v1', label: 'X' }),
    /nicht gefunden/,
  );
});

// Mirrors a real, confirmed-live case: vg_Diagnosis.v1.1.1 uses
// EVALUATION.problem_diagnosis.v1 twice, disambiguated by openEHR's own
// `name/value='primary diagnosis'` / `'secondary diagnosis'` constraint -
// exactly the shape a real OPT uses (verified against the live template).
function twoDisambiguatedDiagnosisRoots() {
  return optDocument(
    archetypeRootXml('EVALUATION', 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', { nodeId: 'at0000', name: 'primary diagnosis' })
    + archetypeRootXml('EVALUATION', 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', { nodeId: 'at0000', name: 'secondary diagnosis' }),
  );
}

test('demands disambiguation instead of guessing when the same archetype_id occurs more than once, and lists the available name qualifiers', async () => {
  const xml = twoDisambiguatedDiagnosisRoots();
  await assert.rejects(
    resolveComponent(source('vg_Diagnosis.v1.1.1', xml), { sourceTemplateId: 'vg_Diagnosis.v1.1.1', sourceArchetypeId: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', label: 'X' }),
    (error) => {
      assert.ok(error instanceof ComponentResolutionError);
      assert.match(error.message, /mehrfach/);
      assert.match(error.message, /primary diagnosis/);
      assert.match(error.message, /secondary diagnosis/);
      return true;
    },
  );
});

test('sourceName picks out exactly one of two same-archetype_id roots, openEHR\'s own name/value disambiguator', async () => {
  const xml = twoDisambiguatedDiagnosisRoots();
  const projection = await resolveComponent(source('vg_Diagnosis.v1.1.1', xml), {
    sourceTemplateId: 'vg_Diagnosis.v1.1.1', sourceArchetypeId: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', sourceName: 'primary diagnosis', label: 'Diagnosen',
  });
  assert.equal(projection.rmType, 'EVALUATION');
});

test('an unmatched sourceName fails with a clear error listing what values actually exist', async () => {
  const xml = twoDisambiguatedDiagnosisRoots();
  await assert.rejects(
    resolveComponent(source('vg_Diagnosis.v1.1.1', xml), { sourceTemplateId: 'vg_Diagnosis.v1.1.1', sourceArchetypeId: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', sourceName: 'tertiary diagnosis', label: 'X' }),
    (error) => {
      assert.ok(error instanceof ComponentResolutionError);
      assert.match(error.message, /primary diagnosis/);
      assert.match(error.message, /secondary diagnosis/);
      return true;
    },
  );
});

test('resolveComponents resolves several components, one getTemplateOpt call per component', async () => {
  const diagnosisXml = optDocument(archetypeRootXml('EVALUATION', 'openEHR-EHR-EVALUATION.problem_diagnosis.v1'));
  const medicationXml = optDocument(archetypeRootXml('OBSERVATION', 'openEHR-EHR-OBSERVATION.medication_statement.v0'));
  const calls = [];
  const multiSource = { getTemplateOpt: async (id) => { calls.push(id); return id === 'vg_Diagnosis.v1.1.1' ? diagnosisXml : medicationXml; } };

  const projections = await resolveComponents(multiSource, [
    { sourceTemplateId: 'vg_Diagnosis.v1.1.1', sourceArchetypeId: 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', label: 'Diagnosen' },
    { sourceTemplateId: 'vg_Medication.v1', sourceArchetypeId: 'openEHR-EHR-OBSERVATION.medication_statement.v0', label: 'Medikation' },
  ]);

  assert.deepEqual(calls, ['vg_Diagnosis.v1.1.1', 'vg_Medication.v1']);
  assert.equal(projections.length, 2);
  assert.equal(projections[0].rmType, 'EVALUATION');
  assert.equal(projections[1].rmType, 'OBSERVATION');
});
