const assert = require('node:assert/strict');
const test = require('node:test');
const {
  collectRuntimeFields,
  createInitialRuntimeValues,
  validateRuntimeValues,
} = require('core');

function form(layoutChildren) {
  return {
    id: 'runtime-form',
    name: 'Runtime form',
    version: '1.0.0',
    sourceTemplates: [],
    bindings: {},
    locales: { en: {} },
    layout: { type: 'form', children: [{ type: 'container', id: 'root', children: layoutChildren }] },
  };
}

test('collects stable runtime field descriptors and default values', () => {
  const definition = form([
    { type: 'input-text', id: 'name', name: 'name', label: 'Name', defaultValue: 'Ada' },
    { type: 'input-quantity', id: 'weight', name: 'weight', label: 'Weight', unitOptions: [{ unit: 'kg' }] },
    { type: 'paragraph', id: 'help', content: 'Help text' },
  ]);

  assert.deepEqual(collectRuntimeFields(definition).map((field) => field.id), ['name', 'weight']);
  assert.deepEqual(createInitialRuntimeValues(definition), { name: 'Ada' });
});

test('validates required, type, range and option constraints', () => {
  const definition = form([
    { type: 'input-text', id: 'name', name: 'name', label: 'Name', required: true },
    { type: 'input-number', id: 'age', name: 'age', label: 'Age', validation: { min: 0, max: 120 } },
    { type: 'input-select', id: 'status', name: 'status', label: 'Status', options: [{ value: 'ok', text: 'OK' }] },
  ]);

  const result = validateRuntimeValues(definition, { name: '', age: 121, status: 'unknown' });
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((issue) => issue.path), ['name', 'age', 'status']);
  assert.deepEqual(result.issues.map((issue) => issue.code), ['required', 'max', 'option']);
});

test('skips hidden required fields and validates conditional visibility', () => {
  const definition = form([
    { type: 'input-select', id: 'kind', name: 'kind', label: 'Kind', options: [{ value: 'other', text: 'Other' }, { value: 'known', text: 'Known' }] },
    { type: 'input-text', id: 'details', name: 'details', label: 'Details', required: true, visibility: { fieldId: 'kind', equals: 'other' } },
  ]);

  assert.equal(validateRuntimeValues(definition, { kind: 'known', details: '' }).valid, true);
  const visible = validateRuntimeValues(definition, { kind: 'other', details: '' });
  assert.equal(visible.valid, false);
  assert.equal(visible.issues[0].path, 'details');
});

test('validates repeated values and quantity units', () => {
  const definition = form([
    { type: 'input-text', id: 'tags', name: 'tags', label: 'Tag', required: true, repeatable: true, repeatMin: 1, repeatMax: 2 },
    { type: 'input-quantity', id: 'dose', name: 'dose', label: 'Dose', unitOptions: [{ unit: 'mg' }], required: true },
  ]);

  const result = validateRuntimeValues(definition, { tags: ['first', ''], dose: { magnitude: 10 } });
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((issue) => issue.path), ['tags[1]', 'dose']);
  assert.equal(result.issues[1].code, 'unit');
});
