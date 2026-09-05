const assert = require('node:assert/strict');
const test = require('node:test');
const { generateFormScriptTypes } = require('../dist');

// DV_INTERVAL<DV_QUANTITY> Form Script typing (P0.1 audit, 2026-09-05).
// generateFormScriptTypes()'s valueType() had no branch for 'input-interval'
// and silently fell through to the generic `string | null` default -
// confirmed live saving a real interval field ("Dosisbereich" on
// "Medikationsabgleich"): the generated FormValues entry read
// `string | null` instead of the field's actual { lower?, upper? } shape,
// the same class of bug as the codeMappings valueType gap found earlier
// wiring the Laborpanel forms (see [[lab-panels-terminology-wiring-and-formscript-type-bug]]).
function form(fieldOverrides) {
  return {
    layout: {
      type: 'form',
      children: [{ type: 'input-interval', id: 'dose_range', label: 'Dosisbereich', ...fieldOverrides }],
    },
  };
}

test("an input-interval field's FormValues entry is the real { lower?, upper? } shape, not the generic string fallback", () => {
  const types = generateFormScriptTypes(form());
  assert.match(types, /"dose_range":\s*\{\s*lower\?:\s*\{\s*magnitude:\s*number;\s*unit\?:\s*string\s*\};\s*upper\?:\s*\{\s*magnitude:\s*number;\s*unit\?:\s*string\s*\}\s*\}\s*\|\s*null;/);
  assert.doesNotMatch(types, /"dose_range":\s*string \| null;/);
});
