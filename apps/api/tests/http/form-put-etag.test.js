const assert = require('node:assert/strict');
const test = require('node:test');
const { startTestServer } = require('../support/httpServer');
const { installTestAuth } = require('../support/testAuth');
const prisma = require('../../dist/db/prisma').default;
const { pluginRegistry } = require('../../dist/plugins/pluginRegistry');

const FORM_ID = '11111111-1111-4111-8111-111111111111';

/**
 * Draft autosave concurrency: a form is guarded by a revision ETag. GET/PUT
 * expose it, PUT honours If-Match before running hooks, and the write itself
 * is a compare-and-set against the exact persisted canonical_json - so two
 * saves based on the same revision can never both win, even when the stored
 * definition predates the current schema (it is compared as stored, not as
 * migrated).
 */
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
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** In-memory stand-in for the forms table: updateMany applies the route's
 * compare-and-set predicate (id + exact persisted canonical_json) the same
 * way Postgres would, so genuinely concurrent PUTs race on it. */
function installFormStore(initialRow) {
  const original = { findUnique: prisma.form.findUnique, updateMany: prisma.form.updateMany };
  let row = structuredClone(initialRow);
  let failNextUpdate = false;
  prisma.form.findUnique = async ({ where }) => (row && row.id === where.id ? structuredClone(row) : null);
  prisma.form.updateMany = async ({ where, data }) => {
    if (failNextUpdate) {
      failNextUpdate = false;
      return { count: 0 };
    }
    if (!row || row.id !== where.id) return { count: 0 };
    const predicate = where.canonical_json && where.canonical_json.equals;
    if (predicate !== undefined && !jsonEqual(row.canonical_json, predicate)) return { count: 0 };
    row = { ...row, ...data, updatedAt: new Date() };
    return { count: 1 };
  };
  return {
    get: () => structuredClone(row),
    /** Simulate another request winning after this request's read. */
    loseRace: () => { failNextUpdate = true; },
    restore: () => {
      prisma.form.findUnique = original.findUnique;
      prisma.form.updateMany = original.updateMany;
    },
  };
}

async function withServer(run) {
  const server = await startTestServer();
  const auth = installTestAuth();
  auth.asAdmin();
  try {
    return await run(server, auth);
  } finally {
    auth.restore();
    await server.close();
  }
}

function installHookRecorder() {
  const original = pluginRegistry.runHook;
  const calls = [];
  pluginRegistry.runHook = async (name, context) => {
    calls.push(name);
    return original.call(pluginRegistry, name, context);
  };
  return { calls, restore: () => { pluginRegistry.runHook = original; } };
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

async function putForm(server, ifMatch, body = savePayload()) {
  const headers = { 'Content-Type': 'application/json' };
  if (ifMatch !== undefined) headers['If-Match'] = ifMatch;
  const response = await fetch(`${server.baseUrl}/api/forms/${FORM_ID}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

test('PUT with a matching If-Match bumps the revision once and preserves the response body', async () => {
  const store = installFormStore(formRow(canonical({ revision: 3 })));
  const hooks = installHookRecorder();
  try {
    await withServer(async (server) => {
      const { response, body } = await putForm(server, '"rev-3"', savePayload({ name: 'Vitals updated' }));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('etag'), '"rev-4"');
      assert.equal(body.id, FORM_ID);
      assert.equal(body.name, 'Vitals updated');
      assert.equal(body.version, '1.0.0');
      assert.equal(body.status, 'draft');
      assert.equal(body.canonical_json.revision, 4);
      assert.equal(body.canonical_json.name, 'Vitals updated');
      assert.equal(store.get().canonical_json.revision, 4);
      assert.deepEqual(hooks.calls, ['beforeFormSave', 'afterFormSave']);
    });
  } finally {
    hooks.restore();
    store.restore();
  }
});

test('a stale If-Match is rejected with 412 before any hook runs and writes nothing', async () => {
  const store = installFormStore(formRow(canonical({ revision: 3 })));
  const hooks = installHookRecorder();
  try {
    await withServer(async (server) => {
      const { response, body } = await putForm(server, '"rev-2"', savePayload({ name: 'Stale write' }));
      assert.equal(response.status, 412);
      assert.equal(body.code, 'FORM_REVISION_CONFLICT');
      assert.equal(store.get().canonical_json.revision, 3);
      assert.equal(store.get().canonical_json.name, 'Vitals');
      assert.deepEqual(hooks.calls, []);
    });
  } finally {
    hooks.restore();
    store.restore();
  }
});

test('a lost claim without If-Match is rejected with 409 and never runs afterFormSave', async () => {
  const store = installFormStore(formRow(canonical({ revision: 3 })));
  const hooks = installHookRecorder();
  try {
    await withServer(async (server) => {
      store.loseRace(); // another save wins between our read and our write
      const { response, body } = await putForm(server, undefined, savePayload({ name: 'Late write' }));
      assert.equal(response.status, 409);
      assert.equal(body.code, 'FORM_REVISION_CONFLICT');
      assert.equal(store.get().canonical_json.revision, 3);
      assert.equal(store.get().canonical_json.name, 'Vitals');
      assert.deepEqual(hooks.calls, ['beforeFormSave']);
    });
  } finally {
    hooks.restore();
    store.restore();
  }
});

test('two concurrent saves from the same revision cannot both win', async () => {
  const store = installFormStore(formRow(canonical({ revision: 3 })));
  const hooks = installHookRecorder();
  try {
    await withServer(async (server) => {
      const [first, second] = await Promise.all([
        putForm(server, '"rev-3"', savePayload({ name: 'First writer' })),
        putForm(server, '"rev-3"', savePayload({ name: 'Second writer' })),
      ]);
      const statuses = [first.response.status, second.response.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 412]);
      const winner = first.response.status === 200 ? first : second;
      assert.equal(winner.response.headers.get('etag'), '"rev-4"');
      assert.equal(store.get().canonical_json.revision, 4);
      assert.equal(store.get().canonical_json.name, winner.body.canonical_json.name);
      assert.equal(hooks.calls.filter((name) => name === 'afterFormSave').length, 1);
    });
  } finally {
    hooks.restore();
    store.restore();
  }
});

test('legacy stored definitions get a revision ETag and can still be saved without a false conflict', async () => {
  // No schemaVersion/revision/extensions at all - the compare-and-set must
  // use this exact persisted JSON, not the migrated v1 shape, or every save
  // of an old form would look like a lost claim.
  const legacy = {
    id: FORM_ID,
    name: 'Vitals',
    version: '1.0.0',
    sourceTemplates: [],
    layout: { type: 'form', children: [{ type: 'container', children: [] }] },
    bindings: {},
    locales: { en: {} },
  };
  const store = installFormStore(formRow(legacy));
  try {
    await withServer(async (server) => {
      const read = await fetch(`${server.baseUrl}/api/forms/${FORM_ID}`);
      assert.equal(read.status, 200);
      assert.equal(read.headers.get('etag'), '"rev-0"');
      const readBody = await read.json();

      const { response, body } = await putForm(server, '"rev-0"', { ...readBody.canonical_json, name: 'Vitals legacy edit' });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('etag'), '"rev-1"');
      assert.equal(body.canonical_json.schemaVersion, '1.0');
      assert.equal(body.canonical_json.revision, 1);
      assert.equal(store.get().canonical_json.revision, 1);
    });
  } finally {
    store.restore();
  }
});

test('If-Match must be exactly one formatted revision ETag', async () => {
  const store = installFormStore(formRow(canonical({ revision: 3 })));
  const hooks = installHookRecorder();
  try {
    await withServer(async (server) => {
      for (const ifMatch of ['3', 'W/"rev-3"', '"rev-3", "rev-4"', '*', '"rev-03"', '']) {
        const { response, body } = await putForm(server, ifMatch);
        assert.equal(response.status, 400, `If-Match ${JSON.stringify(ifMatch)} must be rejected`);
        assert.equal(body.code, 'FORM_IF_MATCH_INVALID');
      }
      assert.equal(store.get().canonical_json.revision, 3);
      assert.deepEqual(hooks.calls, []);
    });
  } finally {
    hooks.restore();
    store.restore();
  }
});

test('CORS allows If-Match on preflight and exposes the ETag to browser callers', async () => {
  const store = installFormStore(formRow(canonical({ revision: 3 })));
  try {
    await withServer(async (server) => {
      const preflight = await fetch(`${server.baseUrl}/api/forms/${FORM_ID}`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'if-match,content-type',
        },
      });
      assert.ok(preflight.status === 204 || preflight.status === 200);
      assert.match(preflight.headers.get('access-control-allow-headers') || '', /if-match/i);

      const read = await fetch(`${server.baseUrl}/api/forms/${FORM_ID}`, { headers: { Origin: 'http://localhost:3000' } });
      assert.match(read.headers.get('access-control-expose-headers') || '', /etag/i);
    });
  } finally {
    store.restore();
  }
});

test('GET /api/forms/:id returns the persisted revision as an ETag without changing the body', async () => {
  const definition = canonical({ revision: 7 });
  const store = installFormStore(formRow(definition));
  try {
    await withServer(async (server) => {
      const response = await fetch(`${server.baseUrl}/api/forms/${FORM_ID}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('etag'), '"rev-7"');
      const body = await response.json();
      assert.equal(body.id, FORM_ID);
      assert.equal(body.canonical_json.revision, 7);
      assert.equal(body.canonical_json.name, 'Vitals');
      assert.equal(body.name, 'Vitals');
    });
  } finally {
    store.restore();
  }
});
