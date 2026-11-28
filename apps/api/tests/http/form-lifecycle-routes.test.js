const assert = require('node:assert/strict');
const test = require('node:test');
const { startTestServer } = require('../support/httpServer');
const { installTestAuth } = require('../support/testAuth');
const prisma = require('../../dist/db/prisma').default;

const LINEAGE_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = '22222222-2222-4222-8222-222222222222';
const PUBLISHED_ID = '33333333-3333-4333-8333-333333333333';

/**
 * Lifecycle endpoints (publish, create-draft, restore, archive, delete,
 * latest-published, versions) only parse, check permissions and delegate to
 * formLifecycleService. These tests drive them through the real HTTP stack
 * against an in-memory forms table, so the route wiring and the service's
 * lineage rules are proven together.
 */
function canonical(overrides = {}) {
  return {
    id: DRAFT_ID,
    name: 'Vitals',
    version: '0.1.0-draft',
    schemaVersion: '1.0',
    revision: 0,
    sourceTemplates: [],
    layout: { type: 'form', children: [{ type: 'container', children: [] }] },
    bindings: {},
    locales: { en: {} },
    extensions: {},
    ...overrides,
  };
}

function formRow(id, definition, overrides = {}) {
  return {
    id,
    parent_id: LINEAGE_ID,
    name: definition.name,
    version: definition.version,
    status: 'draft',
    canonical_json: definition,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function matches(row, where = {}) {
  if (where.id !== undefined) {
    if (typeof where.id === 'string' && row.id !== where.id) return false;
    if (where.id && typeof where.id === 'object' && where.id.not !== undefined && row.id === where.id.not) return false;
  }
  if (where.parent_id !== undefined && row.parent_id !== where.parent_id) return false;
  if (where.status !== undefined && row.status !== where.status) return false;
  return true;
}

/**
 * In-memory stand-in for the forms table: findUnique, findMany, update, create
 * and $transaction behave the way the lifecycle service uses them, including
 * `orderBy: { createdAt: 'desc' }` and Prisma's `select` projection.
 */
function installFormStore(initialRows) {
  const original = {
    findUnique: prisma.form.findUnique,
    findMany: prisma.form.findMany,
    findFirst: prisma.form.findFirst,
    update: prisma.form.update,
    create: prisma.form.create,
    transaction: prisma.$transaction,
  };
  let table = initialRows.map((row) => structuredClone(row));
  prisma.form.findUnique = async ({ where }) => {
    const row = table.find((candidate) => candidate.id === where.id);
    return row ? structuredClone(row) : null;
  };
  prisma.form.findMany = async ({ where, orderBy, select } = {}) => {
    let rows = table.filter((row) => matches(row, where));
    if (orderBy && orderBy.createdAt === 'desc') {
      rows = [...rows].sort((left, right) => right.createdAt - left.createdAt);
    }
    return rows.map((row) => {
      const value = structuredClone(row);
      if (!select) return value;
      return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, value[key]]));
    });
  };
  prisma.form.findFirst = async ({ where, orderBy, select } = {}) => {
    const rows = await prisma.form.findMany({ where, orderBy, select });
    return rows.length > 0 ? rows[0] : null;
  };
  prisma.form.update = async ({ where, data }) => {
    const index = table.findIndex((row) => row.id === where.id);
    if (index === -1) throw new Error(`Form ${where.id} not found`);
    table[index] = { ...table[index], ...structuredClone(data), updatedAt: new Date() };
    return structuredClone(table[index]);
  };
  prisma.form.create = async ({ data }) => {
    const row = {
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
      updatedAt: new Date('2026-02-01T00:00:00.000Z'),
      ...structuredClone(data),
    };
    table.push(row);
    return structuredClone(row);
  };
  prisma.$transaction = async (operations) => Promise.all(operations);
  return {
    get: (id) => structuredClone(table.find((row) => row.id === id)),
    all: () => structuredClone(table),
    restore: () => {
      prisma.form.findUnique = original.findUnique;
      prisma.form.findMany = original.findMany;
      prisma.form.findFirst = original.findFirst;
      prisma.form.update = original.update;
      prisma.form.create = original.create;
      prisma.$transaction = original.transaction;
    },
  };
}

async function withServer(authSetup, run) {
  const server = await startTestServer();
  const auth = installTestAuth();
  authSetup(auth);
  try {
    return await run(server);
  } finally {
    auth.restore();
    await server.close();
  }
}

function post(server, path) {
  return fetch(`${server.baseUrl}/api/forms${path}`, { method: 'POST' });
}

test('POST /:id/publish by a principal without form.publish is rejected 403 before any write', async () => {
  const store = installFormStore([formRow(DRAFT_ID, canonical())]);
  try {
    await withServer((auth) => auth.asUser(['form.design']), async (server) => {
      const response = await post(server, `/${DRAFT_ID}/publish`);
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.ok(body.error, 'the 403 body carries an error message');
      assert.equal(store.get(DRAFT_ID).status, 'draft');
    });
  } finally {
    store.restore();
  }
});

test('publishing a draft archives the previously published sibling of the same lineage', async () => {
  const published = formRow(PUBLISHED_ID, canonical({ id: PUBLISHED_ID, version: '1.0.0', status: 'published' }), { status: 'published' });
  const store = installFormStore([formRow(DRAFT_ID, canonical()), published]);
  try {
    await withServer((auth) => auth.asAdmin(), async (server) => {
      const response = await post(server, `/${DRAFT_ID}/publish`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.message, 'Form published');
      assert.equal(body.form.id, DRAFT_ID);
      assert.equal(body.form.status, 'published');
      assert.equal(body.form.version, '1.0.0');
      assert.equal(store.get(DRAFT_ID).status, 'published');
      assert.equal(store.get(PUBLISHED_ID).status, 'archived');
      assert.equal(store.get(PUBLISHED_ID).canonical_json.status, 'archived');
    });
  } finally {
    store.restore();
  }
});

test('publishing an already published form is rejected 400', async () => {
  const store = installFormStore([
    formRow(PUBLISHED_ID, canonical({ id: PUBLISHED_ID, version: '1.0.0', status: 'published' }), { status: 'published' }),
  ]);
  try {
    await withServer((auth) => auth.asAdmin(), async (server) => {
      const response = await post(server, `/${PUBLISHED_ID}/publish`);
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error, 'Form is already published');
      assert.equal(store.get(PUBLISHED_ID).version, '1.0.0');
    });
  } finally {
    store.restore();
  }
});

test('GET /parent/:parentId/latest-published returns the newest published row', async () => {
  const older = formRow(PUBLISHED_ID, canonical({ id: PUBLISHED_ID, version: '1.0.0', status: 'published' }), {
    status: 'published',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  const newer = formRow(DRAFT_ID, canonical({ id: DRAFT_ID, version: '1.1.0', status: 'published' }), {
    status: 'published',
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
  });
  const draft = formRow('44444444-4444-4444-8444-444444444444', canonical({ id: '44444444-4444-4444-8444-444444444444' }), {
    createdAt: new Date('2026-04-01T00:00:00.000Z'),
  });
  const store = installFormStore([older, newer, draft]);
  try {
    await withServer((auth) => auth.asAdmin(), async (server) => {
      const response = await fetch(`${server.baseUrl}/api/forms/parent/${LINEAGE_ID}/latest-published`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.id, DRAFT_ID);
      assert.equal(body.version, '1.1.0');
      assert.equal(body.canonical_json.id, DRAFT_ID);
    });
  } finally {
    store.restore();
  }
});

test('GET /parent/:parentId/latest-published returns 404 when nothing is published', async () => {
  const store = installFormStore([formRow(DRAFT_ID, canonical())]);
  try {
    await withServer((auth) => auth.asAdmin(), async (server) => {
      const response = await fetch(`${server.baseUrl}/api/forms/parent/${LINEAGE_ID}/latest-published`);
      assert.equal(response.status, 404);
      const body = await response.json();
      assert.equal(body.error, 'No active published form found');
    });
  } finally {
    store.restore();
  }
});

test('create-draft takes its version from nextDraftVersion and parents it to the lineage', async () => {
  const source = formRow(PUBLISHED_ID, canonical({ id: PUBLISHED_ID, version: '1.0.0', status: 'published' }), { status: 'published' });
  // A newer draft already exists under the same lineage - the shared
  // implementation must bump past it instead of repeating "1.1.0-draft".
  const existingDraft = formRow('55555555-5555-4555-8555-555555555555', canonical({ id: '55555555-5555-4555-8555-555555555555', version: '1.2.0-draft' }));
  const store = installFormStore([source, existingDraft]);
  try {
    await withServer((auth) => auth.asAdmin(), async (server) => {
      const response = await post(server, `/${PUBLISHED_ID}/create-draft`);
      assert.equal(response.status, 201);
      const body = await response.json();
      assert.equal(body.message, 'Draft created');
      assert.equal(body.form.version, '1.3.0-draft');
      assert.equal(body.form.parent_id, LINEAGE_ID);
      assert.equal(body.form.status, 'draft');
      assert.notEqual(body.form.id, PUBLISHED_ID);
      assert.equal(store.get(body.form.id).version, '1.3.0-draft');
    });
  } finally {
    store.restore();
  }
});
