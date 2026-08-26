const assert = require('node:assert/strict');
const test = require('node:test');
const {
  collectRuntimeFields,
  collectRuntimeGroups,
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

test('initializes and validates repeatable groups as row objects', () => {
  const definition = form([
    {
      type: 'container',
      id: 'medications',
      label: 'Medications',
      repeatable: true,
      repeatMin: 1,
      repeatMax: 2,
      children: [
        {
          type: 'input-text',
          id: 'substance',
          name: 'substance',
          label: 'Substance',
          required: true,
          defaultValue: 'Aspirin',
        },
        { type: 'input-number', id: 'dose', name: 'dose', label: 'Dose' },
      ],
    },
  ]);

  assert.deepEqual(collectRuntimeGroups(definition), [{
    id: 'medications',
    label: 'Medications',
    repeatMin: 1,
    repeatMax: 2,
  }]);
  assert.equal(collectRuntimeFields(definition)[0].repeatableGroupId, 'medications');
  assert.deepEqual(createInitialRuntimeValues(definition), {
    medications: [{ substance: 'Aspirin' }],
  });

  const missingRow = validateRuntimeValues(definition, { medications: [] });
  assert.deepEqual(missingRow.issues.map((item) => item.path), ['medications']);
  assert.deepEqual(missingRow.issues.map((item) => item.code), ['repeat-min']);

  const missingSubstance = validateRuntimeValues(definition, { medications: [{}] });
  assert.deepEqual(missingSubstance.issues.map((item) => item.path), ['medications[0].substance']);
  assert.deepEqual(missingSubstance.issues.map((item) => item.code), ['required']);

  assert.equal(validateRuntimeValues(definition, {
    medications: [{ substance: 'Aspirin', dose: 100 }],
  }).valid, true);
});

// Epic 2 - Clinical Editing Lifecycle: a real openEHR draft
// (lifecycle_state=incomplete) is explicitly allowed to have missing
// required fields, but never an invalid typed value.
test('draft mode allows missing required fields but still rejects an invalid typed value', () => {
  const definition = form([
    { type: 'input-text', id: 'name', name: 'name', label: 'Name', required: true },
    { type: 'input-quantity', id: 'weight', name: 'weight', label: 'Weight', unitOptions: [{ unit: 'kg' }], required: true },
    { type: 'input-quantity', id: 'dose', name: 'dose', label: 'Dose', unitOptions: [{ unit: 'mg' }] },
  ]);

  // Missing required fields alone: fine as a draft, rejected as final.
  const missingOnly = validateRuntimeValues(definition, {}, { mode: 'draft' });
  assert.equal(missingOnly.valid, true);
  assert.equal(validateRuntimeValues(definition, {}, { mode: 'final' }).valid, false);
  assert.equal(validateRuntimeValues(definition, {}).valid, false, 'final is the default when mode is omitted');

  // An invalid typed value (DV_QUANTITY given a non-numeric magnitude) is
  // never acceptable, draft or final - draft mode only filters out
  // required/repeat-min issue codes, not type/unit/min/max/pattern ones.
  const invalidTyped = validateRuntimeValues(definition, { name: 'Ada', weight: { magnitude: 70, unit: 'kg' }, dose: 'abc' }, { mode: 'draft' });
  assert.equal(invalidTyped.valid, false);
  assert.deepEqual(invalidTyped.issues.map((issue) => issue.path), ['dose']);
  assert.equal(invalidTyped.issues[0].code, 'type');
});

test('draft mode filters repeat-min the same way it filters required', () => {
  const definition = form([{ type: 'input-text', id: 'tags', name: 'tags', label: 'Tag', repeatable: true, repeatMin: 2 }]);
  assert.equal(validateRuntimeValues(definition, { tags: ['first'] }, { mode: 'draft' }).valid, true);
  assert.equal(validateRuntimeValues(definition, { tags: ['first'] }, { mode: 'final' }).valid, false);
});
