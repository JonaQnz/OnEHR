'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { parseWebTemplate } = require('../dist/parsers/webTemplateParser');

// vg_ServiceRequest.v1.1.1's "indefinite" and "supplementary_information"
// are DV_BOOLEAN elements EHRbase's own WebTemplate export constrains to a
// SINGLE allowed value ({True} only) - a common openEHR "presence flag"
// idiom, not a real yes/no toggle (see "indefinite"'s own archetype comment:
// "Record as TRUE to record explicitly that the request has no expiry
// date"). Confirmed live: submitting `false` for either field gets EHRbase's
// "The value false must be true" 400. Before this fix, parseWebTemplate
// hardcoded both Yes/No options for every DV_BOOLEAN field unconditionally,
// silently discarding this constraint (which EHRbase already surfaces the
// exact same way a coded field's option list works - `inputs[0].list`
// containing only `[{value:"true", label:"true"}]`, no "false" entry) - a
// form built by picking this WebTemplate field would offer a "No" choice
// that live submission always rejects.
const webTemplate = require(path.join(__dirname, '..', '..', '..', 'packages', 'openehr-engine', 'tests', 'fixtures', 'vg_ServiceRequest.v1.1.1.webtemplate.json'));

test('a DV_BOOLEAN field whose WebTemplate list only contains "true" exposes just that one option, not a fabricated Yes/No pair', () => {
  const parsed = parseWebTemplate(webTemplate);
  const indefinite = parsed.fields.find((f) => f.archetypeNodeId === 'at0147' && f.rmType === 'DV_BOOLEAN');
  assert.ok(indefinite, 'expected to find the "indefinite" field');
  assert.deepEqual(indefinite.options, [{ value: 'true', text: 'Yes' }]);
});

test('a DV_BOOLEAN field with only "true" in its WebTemplate list carries that restriction through to a generated layout node\'s options too', () => {
  const parsed = parseWebTemplate(webTemplate);
  function findByPath(node, targetPath) {
    if (node.binding?.path === targetPath) return node;
    for (const child of node.children || []) {
      const found = findByPath(child, targetPath);
      if (found) return found;
    }
    return undefined;
  }
  const indefiniteField = parsed.fields.find((f) => f.archetypeNodeId === 'at0147' && f.rmType === 'DV_BOOLEAN');
  const indefiniteNode = findByPath(parsed.layout, indefiniteField.openehrPath);
  assert.ok(indefiniteNode, 'expected the generated layout to include a node for "indefinite"');
  assert.deepEqual(indefiniteNode.options, [{ value: 'true', text: 'Yes' }]);
});
