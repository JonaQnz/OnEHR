const assert = require('node:assert/strict');
const test = require('node:test');
const { validateRuntimeValues } = require('../dist');

function form(allowFreeText) {
  return {
    layout: {
      type: 'form',
      children: [{
        type: 'container',
        children: [{
          type: 'input-select', id: 'severity', label: 'Schweregrad',
          options: [{ value: 'at0047', text: 'Mild' }, { value: 'at0048', text: 'Moderate' }],
          ...(allowFreeText ? { allowFreeText: true } : {}),
        }],
      }],
    },
  };
}

test('a coded field without allowFreeText (every existing form, unchanged) still rejects a value outside its option list', () => {
  const result = validateRuntimeValues(form(false), { severity: 'Leicht bis mäßig' });
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].code, 'option');
});

test('allowFreeText:true accepts a value outside the option list as legitimate free text', () => {
  const result = validateRuntimeValues(form(true), { severity: 'Leicht bis mäßig, wechselnd' });
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test('allowFreeText:true still accepts a real coded value normally', () => {
  const result = validateRuntimeValues(form(true), { severity: 'at0048' });
  assert.equal(result.valid, true);
});

test('allowFreeText defaults to false when absent, so an older/unmigrated form keeps its exact prior behavior', () => {
  const bare = { layout: { type: 'form', children: [{ type: 'container', children: [{ type: 'input-select', id: 'x', options: [{ value: 'a', text: 'A' }] }] }] } };
  const result = validateRuntimeValues(bare, { x: 'not-a-known-option' });
  assert.equal(result.valid, false);
});
