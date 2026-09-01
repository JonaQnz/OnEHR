'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseWebTemplate } = require('../dist/parsers/webTemplateParser');

// German labels/option text should come through automatically for any
// freshly-parsed template - no per-form hand-translation should ever be
// needed again (see webTemplateParser.ts's preferredLabel/preferredOptionText,
// added after "Diagnose (Basis)" had to be manually translated). Uses the
// real vg_Diagnosis.v1.1.1 WebTemplate export shared with the openehr-engine
// package's own OPT constraint engine tests.
const webTemplate = require(path.join(__dirname, '..', '..', '..', 'packages', 'openehr-engine', 'tests', 'fixtures', 'vg_Diagnosis.v1.1.1.webtemplate.json'));

test('field labels default to German (localizedNames.de), not the template default language', () => {
  const parsed = parseWebTemplate(webTemplate);
  const severity = parsed.fields.find((f) => f.archetypeNodeId === 'at0005' && f.openehrPath.includes('primary'));
  assert.equal(severity.label, 'Schweregrad');
  const name = parsed.fields.find((f) => f.archetypeNodeId === 'at0002' && f.openehrPath.includes('primary'));
  assert.match(name.label, /Diagnose/);
});

test('DV_CODED_TEXT option text defaults to German (localizedLabels.de), not English', () => {
  const parsed = parseWebTemplate(webTemplate);
  function findByPath(node, targetPath) {
    if (node.binding?.path === targetPath) return node;
    for (const child of node.children || []) {
      const found = findByPath(child, targetPath);
      if (found) return found;
    }
    return undefined;
  }
  const severityField = parsed.fields.find((f) => f.archetypeNodeId === 'at0005' && f.openehrPath.includes('primary'));
  const severityNode = findByPath(parsed.layout, severityField.openehrPath);
  assert.deepEqual(severityNode.options.map((o) => o.text), ['Leicht', 'Mäßig', 'Schwer']);
});
