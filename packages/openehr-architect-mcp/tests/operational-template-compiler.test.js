import assert from 'node:assert/strict';
import test from 'node:test';
import { XMLParser } from 'fast-xml-parser';
import { resolveComponent } from '../dist/documentTemplate/componentResolver.js';
import { compileOperationalTemplate } from '../dist/documentTemplate/operationalTemplateCompiler.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

function archetypeRootXml(rmType, archetypeId, atCode, label) {
  // Deliberately reuses the SAME local at-code (atCode) across different
  // fixtures below - at-codes are scoped per archetype, so two independent
  // C_ARCHETYPE_ROOTs both using e.g. "at0001" must remain perfectly valid
  // once composed together (see the plan's correction #2).
  return `<children xsi:type="C_ARCHETYPE_ROOT"><rm_type_name>${rmType}</rm_type_name><node_id>${atCode}</node_id><archetype_id><value>${archetypeId}</value></archetype_id><term_definitions code="${atCode}"><items id="text">${label}</items></term_definitions></children>`;
}

function optDocument(rootXml) {
  return `<template xmlns="http://schemas.openehr.org/v1"><definition><rm_type_name>COMPOSITION</rm_type_name><attributes xsi:type="C_MULTIPLE_ATTRIBUTE" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><rm_attribute_name>content</rm_attribute_name>${rootXml}</attributes></definition></template>`;
}

async function resolveFixture(archetypeId, rmType, atCode, label) {
  const xml = optDocument(archetypeRootXml(rmType, archetypeId, atCode, label));
  const source = { getTemplateOpt: async () => xml };
  return resolveComponent(source, { sourceTemplateId: 'src', sourceArchetypeId: archetypeId, label, wrapInSection: rmType !== 'SECTION' });
}

test('throws when composing zero components', () => {
  assert.throws(() => compileOperationalTemplate({ templateId: 't', uid: 'u', purpose: 'p', compositionRootText: 'r', compositionRootDescription: 'd', components: [] }));
});

test('composes two components that both use the SAME local at-code (at0001) without any renumbering or collision', async () => {
  const diagnosis = await resolveFixture('openEHR-EHR-EVALUATION.problem_diagnosis.v1', 'EVALUATION', 'at0001', 'Diagnosen');
  const medication = await resolveFixture('openEHR-EHR-OBSERVATION.medication_statement.v0', 'OBSERVATION', 'at0001', 'Medikation');

  const opt = compileOperationalTemplate({
    templateId: 'entlassbrief_v1', uid: 'uid-1', purpose: 'Entlassbrief aus Components', compositionRootText: 'Entlassbrief', compositionRootDescription: 'desc',
    components: [diagnosis, medication],
  });

  // Both original archetype_ids are present, verbatim.
  assert.match(opt, /openEHR-EHR-EVALUATION\.problem_diagnosis\.v1/);
  assert.match(opt, /openEHR-EHR-OBSERVATION\.medication_statement\.v0/);
  // The shared local at-code appears twice (once per archetype's own
  // untouched term_definitions/node_id) - never renumbered to avoid a
  // collision that was never real.
  const at0001Occurrences = opt.match(/at0001/g) || [];
  assert.ok(at0001Occurrences.length >= 4, `expected at0001 to appear for both components' node_id + term_definitions, got ${at0001Occurrences.length}`);

  const parsed = parser.parse(opt);
  assert.equal(parsed.template.template_id.value, 'entlassbrief_v1');
});

test('wrapInSection wraps a bare EVALUATION component in a new ad-hoc SECTION with the given label, nesting the original archetype unchanged inside it', async () => {
  const diagnosis = await resolveFixture('openEHR-EHR-EVALUATION.problem_diagnosis.v1', 'EVALUATION', 'at0001', 'Diagnosen');

  const opt = compileOperationalTemplate({
    templateId: 't', uid: 'u', purpose: 'p', compositionRootText: 'r', compositionRootDescription: 'd',
    components: [diagnosis],
  });

  assert.match(opt, /openEHR-EHR-SECTION\.adhoc\.v1/);
  assert.match(opt, /Diagnosen/);
  assert.match(opt, /openEHR-EHR-EVALUATION\.problem_diagnosis\.v1/);
  // The wrapper SECTION and the wrapped EVALUATION are both valid, distinct
  // archetype roots in the output.
  const parsed = parser.parse(opt);
  assert.ok(opt.indexOf('SECTION') < opt.indexOf('openEHR-EHR-EVALUATION.problem_diagnosis.v1'), 'section wrapper should enclose the component');
  void parsed;
});

// Regression test for a real bug caught live: without a distinguishing
// `name` constraint, multiple ad-hoc SECTION wrappers (same archetype_id,
// same node_id "at0000") are one indistinguishable RM identity to EHRbase,
// which rejected a real submission with "Attribute has 4 occurrences, but
// must be 0..1" once 4 such wrappers existed in one COMPOSITION.
test('each wrapInSection wrapper gets its own distinguishing name constraint, so multiple wrapped components in one document are distinct RM identities', async () => {
  const diagnosis = await resolveFixture('openEHR-EHR-EVALUATION.problem_diagnosis.v1', 'EVALUATION', 'at0001', 'Diagnosen');
  const medication = await resolveFixture('openEHR-EHR-OBSERVATION.medication_statement.v0', 'OBSERVATION', 'at0001', 'Medikation');

  const opt = compileOperationalTemplate({
    templateId: 't', uid: 'u', purpose: 'p', compositionRootText: 'r', compositionRootDescription: 'd',
    components: [diagnosis, medication],
  });

  // Both wrapper SECTIONs must each carry their own <rm_attribute_name>name</rm_attribute_name>
  // constraint fixed to their own label - not just the shared term_definitions text.
  const nameConstraintCount = (opt.match(/<rm_attribute_name>name<\/rm_attribute_name>/g) || []).length;
  assert.ok(nameConstraintCount >= 2, `expected at least one name constraint per wrapped SECTION, got ${nameConstraintCount}`);
  assert.match(opt, /<list>Diagnosen<\/list>/);
  assert.match(opt, /<list>Medikation<\/list>/);
});

test('the same component compiled in two separate documents stays independently valid with identical, non-renumbered at-codes', async () => {
  const diagnosisA = await resolveFixture('openEHR-EHR-EVALUATION.problem_diagnosis.v1', 'EVALUATION', 'at0001', 'Diagnosen');
  const diagnosisB = await resolveFixture('openEHR-EHR-EVALUATION.problem_diagnosis.v1', 'EVALUATION', 'at0001', 'Diagnosen');

  const optA = compileOperationalTemplate({ templateId: 'doc_a', uid: 'ua', purpose: 'p', compositionRootText: 'A', compositionRootDescription: 'd', components: [diagnosisA] });
  const optB = compileOperationalTemplate({ templateId: 'doc_b', uid: 'ub', purpose: 'p', compositionRootText: 'B', compositionRootDescription: 'd', components: [diagnosisB] });

  for (const opt of [optA, optB]) {
    assert.match(opt, /openEHR-EHR-EVALUATION\.problem_diagnosis\.v1/);
    assert.match(opt, /at0001/);
    const parsed = parser.parse(opt);
    assert.ok(parsed.template);
  }
});
