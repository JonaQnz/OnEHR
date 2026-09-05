const assert = require('node:assert/strict');
const test = require('node:test');
const { startTestServer } = require('../support/httpServer');
const { installTestAuth } = require('../support/testAuth');
const registryModule = require('../../dist/services/terminologyProviderRegistry');
const auditService = require('../../dist/services/auditService');

// terminologyRoutes.ts (apps/api/src/routes/terminologyRoutes.ts) is a thin,
// provider-agnostic dispatcher - these tests exercise it exactly the same
// way auth-middleware.test.js exercises compositionSessionRoutes: a real
// Express request against the real app, with the one service-module
// function it touches (terminologyProviderRegistry.get) monkeypatched, per
// this suite's own established convention (see that file's own comment).

function fakeProvider(overrides = {}) {
  return {
    id: 'fake-terminology',
    displayName: 'Fake Terminology',
    capabilities: ['search', 'lookup', 'validate', 'discover', 'manage'],
    search: async () => [{ namespace: 'urn:test', code: 'A01', display: 'Test concept' }],
    lookup: async () => ({ namespace: 'urn:test', code: 'A01', display: 'Test concept' }),
    validate: async () => ({ status: 'unreachable', message: 'boom' }),
    discover: { searchBindings: async () => [{ bindingId: 'b1', label: 'Binding 1' }], getBinding: async () => undefined },
    manage: {
      listTerminologies: async () => [],
      createTerminology: async (input) => ({ bindingId: input.id, label: input.label, status: 'draft' }),
      listConcepts: async () => [],
      upsertConcept: async () => ({ revision: 'rev-2' }),
      removeConcept: async () => ({ revision: 'rev-3' }),
      publishVersion: async () => ({ bindingId: 't1', label: 'T1', status: 'published', bindingVersion: 'v1' }),
      retireVersion: async () => ({ bindingId: 't1', label: 'T1', status: 'retired', bindingVersion: 'v1' }),
    },
    ...overrides,
  };
}

function withProvider(provider, run) {
  const originalGet = registryModule.terminologyProviderRegistry.get;
  const originalList = registryModule.terminologyProviderRegistry.list;
  registryModule.terminologyProviderRegistry.get = (id) => (id === provider.id ? provider : undefined);
  registryModule.terminologyProviderRegistry.list = () => [{ id: provider.id, displayName: provider.displayName, capabilities: provider.capabilities }];
  return run().finally(() => {
    registryModule.terminologyProviderRegistry.get = originalGet;
    registryModule.terminologyProviderRegistry.list = originalList;
  });
}

test('GET /api/terminology/providers requires terminology.read, then lists registered providers', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  try {
    await withProvider(fakeProvider(), async () => {
      auth.asAnonymous();
      const anon = await fetch(`${server.baseUrl}/api/terminology/providers`);
      assert.equal(anon.status, 401);

      auth.asUser(['patient.read']); // authenticated, missing terminology.read
      const forbidden = await fetch(`${server.baseUrl}/api/terminology/providers`);
      assert.equal(forbidden.status, 403);

      auth.asUser(['terminology.read']);
      const ok = await fetch(`${server.baseUrl}/api/terminology/providers`);
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.deepEqual(body, [{ id: 'fake-terminology', displayName: 'Fake Terminology', capabilities: ['search', 'lookup', 'validate', 'discover', 'manage'] }]);
    });
  } finally {
    auth.restore();
    await server.close();
  }
});

test('GET /api/terminology/search: missing provider is 400, unknown provider is 404, a capability the provider lacks is 404', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  try {
    auth.asUser(['terminology.read']);
    const noProvider = await fetch(`${server.baseUrl}/api/terminology/search?query=x`);
    assert.equal(noProvider.status, 400);

    const unknown = await fetch(`${server.baseUrl}/api/terminology/search?provider=nope&query=x`);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'Unknown or unavailable terminology provider: nope');

    await withProvider(fakeProvider({ capabilities: ['lookup'] }), async () => {
      const noSearch = await fetch(`${server.baseUrl}/api/terminology/search?provider=fake-terminology&query=x`);
      assert.equal(noSearch.status, 404);
    });
  } finally {
    auth.restore();
    await server.close();
  }
});

test('GET /api/terminology/search dispatches query params through to the resolved provider and returns its concepts', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  try {
    auth.asUser(['terminology.read']);
    const seen = [];
    const provider = fakeProvider({ search: async (input) => { seen.push(input); return [{ namespace: 'urn:test', code: 'A01', display: 'Test' }]; } });
    await withProvider(provider, async () => {
      const response = await fetch(`${server.baseUrl}/api/terminology/search?provider=fake-terminology&query=diabetes&bindingId=b1&limit=5&activeOnly=false`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), [{ namespace: 'urn:test', code: 'A01', display: 'Test' }]);
      assert.deepEqual(seen[0], { bindingId: 'b1', bindingVersion: undefined, namespace: undefined, namespaceVersion: undefined, query: 'diabetes', limit: 5, activeOnly: false });
    });
  } finally {
    auth.restore();
    await server.close();
  }
});

test('GET /api/terminology/validate passes the typed outcome through structurally - "unreachable" is never collapsed into a boolean', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  try {
    auth.asUser(['terminology.read']);
    await withProvider(fakeProvider(), async () => {
      const response = await fetch(`${server.baseUrl}/api/terminology/validate?provider=fake-terminology&code=A01`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { status: 'unreachable', message: 'boom' });
    });
  } finally {
    auth.restore();
    await server.close();
  }
});

test('manage routes require terminology.manage (search-level terminology.read is not enough)', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  try {
    await withProvider(fakeProvider(), async () => {
      auth.asUser(['terminology.read']);
      const forbidden = await fetch(`${server.baseUrl}/api/terminology/manage/terminologies?provider=fake-terminology`);
      assert.equal(forbidden.status, 403);

      auth.asUser(['terminology.read', 'terminology.manage']);
      const ok = await fetch(`${server.baseUrl}/api/terminology/manage/terminologies?provider=fake-terminology`);
      assert.equal(ok.status, 200);
    });
  } finally {
    auth.restore();
    await server.close();
  }
});

test('publish/retire require terminology.publish specifically - terminology.manage alone is not enough', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  const originalWrite = auditService.writeAuditEvent;
  auditService.writeAuditEvent = async () => {};
  try {
    await withProvider(fakeProvider(), async () => {
      auth.asUser(['terminology.manage']);
      const forbidden = await fetch(`${server.baseUrl}/api/terminology/manage/terminologies/t1/publish?provider=fake-terminology`, { method: 'POST' });
      assert.equal(forbidden.status, 403);

      auth.asUser(['terminology.manage', 'terminology.publish']);
      const ok = await fetch(`${server.baseUrl}/api/terminology/manage/terminologies/t1/publish?provider=fake-terminology`, { method: 'POST' });
      assert.equal(ok.status, 200);
      assert.deepEqual(await ok.json(), { bindingId: 't1', label: 'T1', status: 'published', bindingVersion: 'v1' });
    });
  } finally {
    auditService.writeAuditEvent = originalWrite;
    auth.restore();
    await server.close();
  }
});

test('creating a custom terminology writes an audit event with actor/provider/label', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  const originalWrite = auditService.writeAuditEvent;
  const events = [];
  auditService.writeAuditEvent = async (event) => { events.push(event); };
  try {
    await withProvider(fakeProvider(), async () => {
      auth.asUser(['terminology.manage'], { userId: 'admin-1' });
      const response = await fetch(`${server.baseUrl}/api/terminology/manage/terminologies?provider=fake-terminology`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'internal-list', label: 'Interne Liste' }),
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { bindingId: 'internal-list', label: 'Interne Liste', status: 'draft' });
      assert.equal(events.length, 1);
      assert.equal(events[0].action, 'terminology.created');
      assert.equal(events[0].actorUserId, 'admin-1');
      assert.equal(events[0].resourceId, 'internal-list');
      assert.equal(events[0].metadata.provider, 'fake-terminology');
    });
  } finally {
    auditService.writeAuditEvent = originalWrite;
    auth.restore();
    await server.close();
  }
});

test('PUT .../concepts requires expectedRevision (optimistic locking) - rejected 400 without it', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  const originalWrite = auditService.writeAuditEvent;
  auditService.writeAuditEvent = async () => {};
  try {
    auth.asUser(['terminology.manage']);
    await withProvider(fakeProvider(), async () => {
      const missingRevision = await fetch(`${server.baseUrl}/api/terminology/manage/terminologies/t1/concepts?provider=fake-terminology`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ concept: { namespace: 'urn:test', code: 'A01', display: 'Test' } }),
      });
      assert.equal(missingRevision.status, 400);

      const withRevision = await fetch(`${server.baseUrl}/api/terminology/manage/terminologies/t1/concepts?provider=fake-terminology`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ concept: { namespace: 'urn:test', code: 'A01', display: 'Test' }, expectedRevision: 'rev-1' }),
      });
      assert.equal(withRevision.status, 200);
      assert.deepEqual(await withRevision.json(), { revision: 'rev-2' });
    });
  } finally {
    auditService.writeAuditEvent = originalWrite;
    auth.restore();
    await server.close();
  }
});
