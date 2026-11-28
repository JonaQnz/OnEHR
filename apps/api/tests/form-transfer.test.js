const assert = require('node:assert/strict');
const test = require('node:test');
const prisma = require('../dist/db/prisma').default;
const { exportFullForm, importFullForm } = require('../dist/services/formTransferService');

function storedForm() {
  return {
    id: 'form-1',
    canonical_json: {
      name: 'Vitals',
      version: '1.0.0',
      sourceTemplates: [],
      layout: {
        type: 'form',
        children: [{ type: 'input-number', id: 'weight', options: [] }],
      },
      bindings: {},
      locales: { en: {} },
    },
  };
}

async function withStoredForm(form, fn) {
  const originalFindUnique = prisma.form.findUnique;
  prisma.form.findUnique = async ({ where }) => (where.id === form?.id ? form : null);
  try {
    return await fn();
  } finally {
    prisma.form.findUnique = originalFindUnique;
  }
}

async function withCreate(fn) {
  const originalCreate = prisma.form.create;
  const created = [];
  prisma.form.create = async ({ data }) => {
    const row = { ...data };
    created.push(row);
    return row;
  };
  try {
    const result = await fn(created);
    return result;
  } finally {
    prisma.form.create = originalCreate;
  }
}

test('exportFullForm wraps the migrated canonical form in a versioned export', async () => {
  const form = storedForm();
  const payload = await withStoredForm(form, () => exportFullForm('form-1'));

  assert.equal(payload.exportVersion, '1.0');
  assert.equal(payload.form.id, 'form-1');
  assert.equal(payload.form.name, 'Vitals');
  assert.equal(payload.form.schemaVersion, '1.0');
});

test('exportFullForm rejects an unknown form with 404', async () => {
  await withStoredForm(storedForm(), async () => {
    await assert.rejects(() => exportFullForm('missing'), (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.message, 'Form not found');
      return true;
    });
  });
});

test('importFullForm rejects a wrong exportVersion with 400', async () => {
  await assert.rejects(
    () => importFullForm({ exportVersion: '2.0', form: storedForm().canonical_json }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.message, 'Invalid full export payload format.');
      return true;
    },
  );
});

test('importFullForm creates a new draft lineage instead of reusing the exported id', async () => {
  const exported = await withStoredForm(storedForm(), () => exportFullForm('form-1'));

  const created = await withCreate(async (rows) => {
    const row = await importFullForm(exported);
    assert.equal(rows.length, 1);
    return row;
  });

  assert.notEqual(created.id, 'form-1');
  assert.equal(created.parent_id, created.id);
  assert.equal(created.status, 'draft');
  assert.equal(created.version, '0.1.0-draft');
  assert.equal(created.name, 'Vitals (Imported)');
  assert.equal(created.canonical_json.revision, 0);
  assert.equal(created.canonical_json.id, created.id);
});
