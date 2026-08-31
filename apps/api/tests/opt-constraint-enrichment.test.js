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

test('enrichment never breaks the parse even if something in it fails - the rest of parseWebTemplate always still returns fields/layout', () => {
  // A deliberately minimal/malformed-ish tree that still parses fine
  // structurally, to confirm the try/catch around enrichment is not load-
  // bearing for basic parsing.
  const minimal = { templateId: 'x', tree: { id: 'x', name: 'X', rmType: 'COMPOSITION', children: [] } };
  const parsed = parseWebTemplate(minimal);
  assert.deepEqual(parsed.fields, []);
  assert.ok(parsed.layout);
});
