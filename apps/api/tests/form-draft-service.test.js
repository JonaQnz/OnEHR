const assert = require('node:assert/strict');
const test = require('node:test');
const prisma = require('../dist/db/prisma').default;
const { pluginRegistry } = require('../dist/plugins/pluginRegistry');
const { COMPOSITION_EXTENSION_KEY } = require('core');
const {
  createEmptyForm,
  saveDraft,
} = require('../dist/services/formDraftService');

// Draft persistence split out of the HTTP layer: the service owns the
// revision conflict rules (412 for a stale If-Match before any hook, 409 for
// a lost compare-and-set without one), so these tests pin them at the
// service boundary instead of through the router.

const FORM_ID = '11111111-1111-4111-8111-111111111111';

function canonical(overrides = {}) {
  return {
    id: FORM_ID,
    name: 'Vitals',
    version: '1.0.0',
    schemaVersion: '1.0',
    revision: 3,
    sourceTemplates: [],
    layout: { type: 'form', children: [{ type: 'container', children: [] }] },
    bindings: {},
    locales: { en: {} },
    extensions: {},
    ...overrides,
  };
}

function formRow(definition, overrides = {}) {
  return {
    id: FORM_ID,
    parent_id: FORM_ID,
    name: definition.name,
    version: definition.version,
    status: 'draft',
    canonical_json: definition,
    ...overrides,
  };
}

function savePayload(overrides = {}) {
  return {
    name: 'Vitals',
    version: '1.0.0',
    sourceTemplates: [],
    layout: { type: 'form', children: [{ type: 'container', children: [] }] },
    bindings: {},
    locales: { en: {} },
    ...overrides,
  };
}

test('createEmptyForm for a composition seeds the composition extension with id === parent_id and revision 0', async () => {
  const original = prisma.form.create;
  let created;
  prisma.form.create = async ({ data }) => {
    created = data;
    return { ...data };
  };
  try {
    const form = await createEmptyForm({ name: 'New Composition', composition: true });
    assert.equal(typeof form.id, 'string');
    assert.equal(form.id, form.parent_id);
    assert.equal(form.name, 'New Composition');
    assert.equal(form.status, 'draft');
    assert.equal(form.canonical_json.revision, 0);
    assert.ok(form.canonical_json.extensions?.[COMPOSITION_EXTENSION_KEY]);
    assert.equal(created.id, created.parent_id);
  } finally {
    prisma.form.create = original;
  }
});

test('saveDraft with a stale expectedRevision rejects with 412 before any hook runs', async () => {
  const originalFindUnique = prisma.form.findUnique;
  const originalRunHook = pluginRegistry.runHook;
  let hookCalls = 0;
  prisma.form.findUnique = async () => formRow(canonical({ revision: 3 }));
  pluginRegistry.runHook = async () => { hookCalls += 1; };
  try {
    await assert.rejects(
      () => saveDraft(FORM_ID, savePayload({ name: 'Stale write' }), 2),
      (error) => error.status === 412 && error.details?.code === 'FORM_REVISION_CONFLICT',
    );
    assert.equal(hookCalls, 0);
  } finally {
    prisma.form.findUnique = originalFindUnique;
    pluginRegistry.runHook = originalRunHook;
  }
});

test('saveDraft without an expectedRevision rejects a lost compare-and-set with 409', async () => {
  const originalFindUnique = prisma.form.findUnique;
  const originalUpdateMany = prisma.form.updateMany;
  const originalRunHook = pluginRegistry.runHook;
  prisma.form.findUnique = async () => formRow(canonical({ revision: 3 }));
  prisma.form.updateMany = async () => ({ count: 0 });
  pluginRegistry.runHook = async (_name, context) => context;
  try {
    await assert.rejects(
      () => saveDraft(FORM_ID, savePayload({ name: 'Late write' }), undefined),
      (error) => error.status === 409 && error.details?.code === 'FORM_REVISION_CONFLICT',
    );
  } finally {
    prisma.form.findUnique = originalFindUnique;
    prisma.form.updateMany = originalUpdateMany;
    pluginRegistry.runHook = originalRunHook;
  }
});

test('a successful saveDraft increments the revision and returns the persisted row', async () => {
  const originalFindUnique = prisma.form.findUnique;
  const originalUpdateMany = prisma.form.updateMany;
  const originalRunHook = pluginRegistry.runHook;
  let row = formRow(canonical({ revision: 3 }));
  prisma.form.findUnique = async () => structuredClone(row);
  prisma.form.updateMany = async ({ data }) => {
    row = { ...row, ...data };
    return { count: 1 };
  };
  pluginRegistry.runHook = async (_name, context) => context;
  try {
    const form = await saveDraft(FORM_ID, savePayload({ name: 'Vitals updated' }), 3);
    assert.equal(form.id, FORM_ID);
    assert.equal(form.name, 'Vitals updated');
    assert.equal(form.canonical_json.revision, 4);
    assert.equal(row.canonical_json.revision, 4);
  } finally {
    prisma.form.findUnique = originalFindUnique;
    prisma.form.updateMany = originalUpdateMany;
    pluginRegistry.runHook = originalRunHook;
  }
});
