'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseWebTemplate } = require('../dist/parsers/webTemplateParser');

// Real vg_Diagnosis.v1.1.1 WebTemplate export, shared with the openehr-engine
// package's own OPT constraint engine tests.
const webTemplate = require(path.join(__dirname, '..', '..', '..', 'packages', 'openehr-engine', 'tests', 'fixtures', 'vg_Diagnosis.v1.1.1.webtemplate.json'));

test('parseWebTemplate additively attaches the OPT constraint model onto matching FieldRegistryItems, without changing anything else it already produced', () => {
  const parsed = parseWebTemplate(webTemplate);
  assert.ok(parsed.fields.length > 0);
  const enriched = parsed.fields.filter((field) => field.constraintModel);
  assert.ok(enriched.length > 40, `expected most leaf fields to get a constraintModel match, got ${enriched.length}/${parsed.fields.length}`);

  const severity = parsed.fields.find((field) => field.openehrPath && field.openehrPath.includes("name/value='primary diagnosis'") && field.archetypeNodeId === 'at0005');
  assert.ok(severity, 'severity field (at0005, primary diagnosis) must still be found the normal way');
  assert.equal(severity.constraintModel.archetypeInstanceKey, 'openEHR-EHR-EVALUATION.problem_diagnosis.v1|primary diagnosis');
  assert.deepEqual(severity.constraintModel.occurrences, { min: 0, max: 1 });
  assert.deepEqual(severity.constraintModel.valueConstraints.map((c) => c.rmType), ['DV_CODED_TEXT', 'DV_TEXT']);
  assert.equal(severity.constraintModel.parsingStatus, 'complete');

  // A repeatable field (diagnostic_category, 0..*) must carry that through
  // the enrichment too, not just the parser's own pre-existing maxOccurrences.
  const category = parsed.fields.find((field) => field.archetypeNodeId === 'at0063' && field.openehrPath && field.openehrPath.includes("name/value='primary diagnosis'"));
  assert.ok(category, 'diagnostic_category field must be found');
  assert.deepEqual(category.constraintModel.occurrences, { min: 0, max: null });
});

test('layout leaf nodes with a DV_CODED_TEXT|DV_TEXT union get allowFreeText:true, closing the "free text silently rejected/mis-serialized" gap', () => {
  const parsed = parseWebTemplate(webTemplate);
  function findByPath(node, path) {
    if (node.binding?.path === path) return node;
    for (const child of node.children || []) {
      const found = findByPath(child, path);
      if (found) return found;
    }
    return undefined;
  }
  const severityPath = "/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1 and name/value='primary diagnosis']/data[at0001]/items[at0005]/value";
  const severityNode = findByPath(parsed.layout, severityPath);
  assert.ok(severityNode, 'severity layout node must be found');
  assert.equal(severityNode.allowFreeText, true);

  // A field with NO DV_TEXT alternative (problem/diagnosis name, plain
  // DV_TEXT-only, or diagnostic_service_category-style single-type field)
  // must NOT get allowFreeText - only genuine unions do.
  const namePath = "/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1 and name/value='primary diagnosis']/data[at0001]/items[at0002]/value";
  const nameNode = findByPath(parsed.layout, namePath);
  assert.ok(nameNode);
  assert.notEqual(nameNode.allowFreeText, true);
});

test('a closed DV_CODED_TEXT field with 2-4 options (no free-text alternative) defaults to RadioButtons, not Dropdown', () => {
  const parsed = parseWebTemplate(webTemplate);
  function collectWithUiElement(node, out = []) {
    if (node.uiElement) out.push(node);
    (node.children || []).forEach((child) => collectWithUiElement(child, out));
    return out;
  }
  const withUiElement = collectWithUiElement(parsed.layout);
  const radioNodes = withUiElement.filter((node) => node.allowFreeText !== true);
  assert.ok(radioNodes.length > 0, 'at least one real closed field in this template should default to RadioButtons');
  for (const node of radioNodes) {
    assert.equal(node.uiElement, 'RadioButtons');
    assert.equal(node.type, 'input-select', 'the widget default never changes the underlying RM type/input contract');
  }
});

test('severity/diagnostic_category (DV_CODED_TEXT+DV_TEXT unions) default to the CodedWithOther widget, not plain Dropdown', () => {
  const parsed = parseWebTemplate(webTemplate);
  function findByPath(node, path) {
    if (node.binding?.path === path) return node;
    for (const child of node.children || []) {
      const found = findByPath(child, path);
      if (found) return found;
    }
    return undefined;
  }
  const severityPath = "/content[openEHR-EHR-EVALUATION.problem_diagnosis.v1 and name/value='primary diagnosis']/data[at0001]/items[at0005]/value";
  const severityNode = findByPath(parsed.layout, severityPath);
  assert.ok(severityNode);
  assert.equal(severityNode.uiElement, 'CodedWithOther');
  assert.equal(severityNode.allowFreeText, true);
  assert.equal(severityNode.type, 'input-select', 'still the same underlying RM type/input contract as before this widget existed');
});

test('enrichment never breaks the parse even if something in it fails - the rest of parseWebTemplate always still returns fields/layout', () => {
  // A deliberately minimal/malformed-ish tree that still parses fine
  // structurally, to confirm the try/catch around enrichment is not load-
  // bearing for basic parsing.
  const minimal = { templateId: 'x', tree: { id: 'x', name: 'X', rmType: 'COMPOSITION', children: [] } };
  const parsed = parseWebTemplate(minimal);
  assert.deepEqual(parsed.fields, []);
  assert.ok(parsed.layout);
});
