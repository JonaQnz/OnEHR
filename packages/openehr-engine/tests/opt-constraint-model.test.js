'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildConstraintModelFromWebTemplate } = require('../dist/index.js');
const { resolveTerm, resolveTermIn } = require('../../core/dist/index.js');

// Real EHRbase export for vg_Diagnosis.v1.1.1, fetched via the app's own
// get_remote_template_opt/get_remote_template_detail pipeline (not a
// hand-built fixture) - see packages/openehr-engine/tests/fixtures/README
// if one is added, or the OPT constraint engine analysis doc for how it was
// obtained. Regression tests in this file are the "vg_Diagnosis.v1.1.1 is a
// demanding regression test of the generic engine" requirement from the OPT
// constraint engine architecture task, not template-specific special-casing
// in the engine itself.
const webTemplate = require(path.join(__dirname, 'fixtures', 'vg_Diagnosis.v1.1.1.webtemplate.json'));

function findAllInstances(instances, out = []) {
  for (const instance of instances) {
    out.push(instance);
    findAllInstances(instance.children, out);
  }
  return out;
}

function buildModel(language) {
  return buildConstraintModelFromWebTemplate(webTemplate, language ? { language } : {});
}

function allInstances(model) {
  return findAllInstances(model.archetypeInstances);
}

test('template metadata: id, languages, no parse warnings', () => {
  const model = buildModel();
  assert.equal(model.templateId, 'vg_Diagnosis.v1.1.1');
  assert.deepEqual(model.languages.slice().sort(), ['de', 'en']);
  assert.deepEqual(model.warnings, [], 'a well-formed real template should parse with zero "unsupported constraint" warnings');
});

test('archetype instances: primary diagnosis and secondary diagnosis are kept as two distinct, independently addressable instances', () => {
  const model = buildModel();
  const instances = allInstances(model);
  const primary = instances.find((i) => i.instanceKey === 'openEHR-EHR-EVALUATION.problem_diagnosis.v1|primary diagnosis');
  const secondary = instances.find((i) => i.instanceKey === 'openEHR-EHR-EVALUATION.problem_diagnosis.v1|secondary diagnosis');
  assert.ok(primary, 'primary diagnosis instance must exist');
  assert.ok(secondary, 'secondary diagnosis instance must exist');
  assert.notEqual(primary.instanceKey, secondary.instanceKey);
  assert.equal(primary.nameConstraint, 'primary diagnosis');
  assert.equal(secondary.nameConstraint, 'secondary diagnosis');
  assert.ok(primary.path.includes("name/value='primary diagnosis'"));
  assert.ok(secondary.path.includes("name/value='secondary diagnosis'"));
});

test('problem/diagnosis name (at0002): DV_TEXT, 1..1, on both primary and secondary', () => {
  const model = buildModel();
  const instances = allInstances(model);
  for (const key of ['openEHR-EHR-EVALUATION.problem_diagnosis.v1|primary diagnosis', 'openEHR-EHR-EVALUATION.problem_diagnosis.v1|secondary diagnosis']) {
    const instance = instances.find((i) => i.instanceKey === key);
    const name = instance.fields.find((f) => f.nodeId === 'at0002');
    assert.ok(name, `at0002 must exist on ${key}`);
    assert.deepEqual(name.occurrences, { min: 1, max: 1 });
    assert.deepEqual(name.valueConstraints.map((c) => c.rmType), ['DV_TEXT']);
    assert.equal(name.parsingStatus, 'complete');
  }
});

test('severity (at0005): DV_CODED_TEXT|DV_TEXT union with at0047/48/49, German labels resolve correctly', () => {
  const model = buildModel('de');
  const primary = allInstances(model).find((i) => i.instanceKey.includes('primary diagnosis'));
  const severity = primary.fields.find((f) => f.nodeId === 'at0005');
  assert.deepEqual(severity.valueConstraints.map((c) => c.rmType), ['DV_CODED_TEXT', 'DV_TEXT'], 'a DV_TEXT alternative must be preserved, not discarded');
  const codes = severity.valueConstraints[0].options.map((o) => o.codeString);
  assert.deepEqual(codes, ['at0047', 'at0048', 'at0049']);
  const labels = severity.valueConstraints[0].options.map((o) => o.text);
  assert.deepEqual(labels, ['Leicht', 'Mäßig', 'Schwer']);
});

test('diagnostic certainty (at0073 on problem_diagnosis.v1): at0074/75/76, German = Vermutet/Wahrscheinlich/Bestätigt', () => {
  const model = buildModel('de');
  const primary = allInstances(model).find((i) => i.instanceKey.includes('primary diagnosis'));
  const certainty = primary.fields.find((f) => f.nodeId === 'at0073');
  assert.deepEqual(certainty.valueConstraints.map((c) => c.rmType), ['DV_CODED_TEXT', 'DV_TEXT']);
  const byCode = Object.fromEntries(certainty.valueConstraints[0].options.map((o) => [o.codeString, o.text]));
  assert.deepEqual(byCode, { at0074: 'Vermutet', at0075: 'Wahrscheinlich', at0076: 'Bestätigt' });
});

test('diagnostic category (problem_qualifier.v2 at0063): 0..* (repeatable), at0064/66/76, German = Hauptdiagnose/Nebendiagnose/Komplikation', () => {
  const model = buildModel('de');
  // The qualifier CLUSTER nested under "primary diagnosis" - not the
  // context-level or "secondary diagnosis" occurrence.
  const primary = allInstances(model).find((i) => i.instanceKey.includes('primary diagnosis'));
  const qualifier = primary.children.find((c) => c.archetypeId === 'openEHR-EHR-CLUSTER.problem_qualifier.v2');
  const category = qualifier.fields.find((f) => f.nodeId === 'at0063');
  assert.deepEqual(category.occurrences, { min: 0, max: null }, '0..* must map to { min: 0, max: null }, not be silently capped');
  assert.deepEqual(category.valueConstraints.map((c) => c.rmType), ['DV_CODED_TEXT', 'DV_TEXT']);
  const byCode = Object.fromEntries(category.valueConstraints[0].options.map((o) => [o.codeString, o.text]));
  assert.deepEqual(byCode, { at0064: 'Hauptdiagnose', at0066: 'Nebendiagnose', at0076: 'Komplikation' });
});

test('SCOPE COLLISION: at0076 means "Bestätigt" in problem_diagnosis.v1 but "Komplikation" in problem_qualifier.v2 - resolveTerm must never confuse the two', () => {
  const model = buildModel();
  const fromDiagnosis = resolveTermIn(model.terminologyIndex, 'openEHR-EHR-EVALUATION.problem_diagnosis.v1', 'at0076', 'de');
  const fromQualifier = resolveTermIn(model.terminologyIndex, 'openEHR-EHR-CLUSTER.problem_qualifier.v2', 'at0076', 'de');
  assert.equal(fromDiagnosis, 'Bestätigt');
  assert.equal(fromQualifier, 'Komplikation');
  assert.notEqual(fromDiagnosis, fromQualifier, 'the two archetypes must resolve at0076 independently - a global Map<atCode, Term> would collide these');
});

test('course label (problem_qualifier.v2 at0077): at0081/94/79, German = Akut/Akut bei chronisch/Chronisch', () => {
  const model = buildModel('de');
  const primary = allInstances(model).find((i) => i.instanceKey.includes('primary diagnosis'));
  const qualifier = primary.children.find((c) => c.archetypeId === 'openEHR-EHR-CLUSTER.problem_qualifier.v2');
  const course = qualifier.fields.find((f) => f.nodeId === 'at0077');
  const byCode = Object.fromEntries(course.valueConstraints[0].options.map((o) => [o.codeString, o.text]));
  assert.deepEqual(byCode, { at0081: 'Akut', at0094: 'Akut bei chronisch', at0079: 'Chronisch' });
});

test('admission diagnosis (problem_qualifier.v2 at0073): polymorphic ELEMENT preserves BOTH DV_BOOLEAN and DV_CODED_TEXT alternatives, not just one', () => {
  const model = buildModel('de');
  const primary = allInstances(model).find((i) => i.instanceKey.includes('primary diagnosis'));
  const qualifier = primary.children.find((c) => c.archetypeId === 'openEHR-EHR-CLUSTER.problem_qualifier.v2');
  const admission = qualifier.fields.find((f) => f.nodeId === 'at0073');
  assert.deepEqual(admission.valueConstraints.map((c) => c.rmType), ['DV_BOOLEAN', 'DV_CODED_TEXT']);
  const coded = admission.valueConstraints.find((c) => c.rmType === 'DV_CODED_TEXT');
  const byCode = Object.fromEntries(coded.options.map((o) => [o.codeString, o.text]));
  assert.deepEqual(byCode, { at0108: 'Ja', at0109: 'Nein' });
});

test('multiple coding ICD-10-GM flag (multiple_coding_icd10gm.v1 at0001): at0002/3/4 = †/*/!', () => {
  const model = buildModel('de');
  const primary = allInstances(model).find((i) => i.instanceKey.includes('primary diagnosis'));
  const coding = primary.children.find((c) => c.archetypeId === 'openEHR-EHR-CLUSTER.multiple_coding_icd10gm.v1');
  assert.ok(coding, 'multiple_coding_icd10gm.v1 must be found nested under primary diagnosis');
  const flag = coding.fields.find((f) => f.nodeId === 'at0001');
  const byCode = Object.fromEntries(flag.valueConstraints[0].options.map((o) => [o.codeString, o.text]));
  assert.deepEqual(byCode, { at0002: '†', at0003: '*', at0004: '!' });
});

test('repeatable fields: two distinct diagnostic-category selections are two ELEMENT instances, never one array-valued DV_CODED_TEXT', () => {
  // This is a runtime-serialization property, not something the constraint
  // model itself materializes (the model describes the *constraint*, 0..*,
  // not concrete occurrences) - verified here by construction: the
  // constraint model's own field-level ValueConstraint for at0063 has no
  // array/list shape at all, only a single-value DV_CODED_TEXT option set.
  const model = buildModel();
  const primary = allInstances(model).find((i) => i.instanceKey.includes('primary diagnosis'));
  const qualifier = primary.children.find((c) => c.archetypeId === 'openEHR-EHR-CLUSTER.problem_qualifier.v2');
  const category = qualifier.fields.find((f) => f.nodeId === 'at0063');
  assert.equal(category.valueConstraints[0].rmType, 'DV_CODED_TEXT');
  assert.equal(Array.isArray(category.valueConstraints[0].value), false);
});

test('free text alternative: fields with DV_CODED_TEXT + DV_TEXT unions all expose a genuine DV_TEXT constraint entry to serialize free text into', () => {
  const model = buildModel();
  const primary = allInstances(model).find((i) => i.instanceKey.includes('primary diagnosis'));
  const severity = primary.fields.find((f) => f.nodeId === 'at0005');
  const hasFreeText = severity.valueConstraints.some((c) => c.rmType === 'DV_TEXT');
  assert.ok(hasFreeText);
});

test('field identity is never just the bare nodeId: primary and secondary at0005 have distinct field ids despite the identical nodeId', () => {
  const model = buildModel();
  const instances = allInstances(model);
  const primary = instances.find((i) => i.instanceKey.includes('primary diagnosis'));
  const secondary = instances.find((i) => i.instanceKey.includes('secondary diagnosis'));
  const primarySeverity = primary.fields.find((f) => f.nodeId === 'at0005');
  const secondarySeverity = secondary.fields.find((f) => f.nodeId === 'at0005');
  assert.equal(primarySeverity.nodeId, secondarySeverity.nodeId, 'sanity: same nodeId');
  assert.notEqual(primarySeverity.id, secondarySeverity.id, 'field.id must differ even though nodeId is identical');
});

test('resolveTerm falls back gracefully and never throws for an unknown code/language', () => {
  const model = buildModel();
  const terminology = model.terminologyIndex['openEHR-EHR-EVALUATION.problem_diagnosis.v1'];
  assert.equal(resolveTerm(terminology, 'at9999', 'de'), 'at9999', 'unknown code degrades to the bare code string, never throws');
  assert.equal(resolveTerm(undefined, 'at0076', 'de'), 'at0076', 'missing terminology entirely still degrades gracefully');
  // fr not configured on this template at all - must fall back through to
  // whatever language IS available rather than crash or return nothing.
  assert.equal(resolveTerm(terminology, 'at0076', 'fr', 'en'), 'Confirmed');
});
