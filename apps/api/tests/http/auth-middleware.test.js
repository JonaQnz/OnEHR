const assert = require('node:assert/strict');
const test = require('node:test');
const { startTestServer } = require('../support/httpServer');
const { installTestAuth } = require('../support/testAuth');
const compositionSessionService = require('../../dist/services/compositionSessionService');

// Every existing composition-session test calls
// compositionSessionService.* functions directly - none of them ever go
// through requirePermission('form.execute') (compositionSessionRoutes.ts's
// router-level middleware), because there is no Express request object to
// carry it. These tests prove the middleware itself actually blocks a real
// HTTP request end to end - not just that the service function behaves
// correctly once already called.
test('GET /api/composition-sessions without any session is rejected 401 before the route handler runs', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  const original = compositionSessionService.getCompositionSessionsForPatient;
  let called = false;
  compositionSessionService.getCompositionSessionsForPatient = async () => { called = true; return []; };
  try {
    auth.asAnonymous();
    const response = await fetch(`${server.baseUrl}/api/composition-sessions?patientId=p1`);
    assert.equal(response.status, 401);
    const body = await response.json();
    assert.equal(body.authRequired, true);
    assert.equal(called, false, 'the route handler must never run for an unauthenticated request');
  } finally {
    compositionSessionService.getCompositionSessionsForPatient = original;
    auth.restore();
    await server.close();
  }
});

test('GET /api/composition-sessions with a session that lacks form.execute is rejected 403', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  const original = compositionSessionService.getCompositionSessionsForPatient;
  let called = false;
  compositionSessionService.getCompositionSessionsForPatient = async () => { called = true; return []; };
  try {
    auth.asUser(['patient.read']); // authenticated, but missing form.execute
    const response = await fetch(`${server.baseUrl}/api/composition-sessions?patientId=p1`);
    assert.equal(response.status, 403);
    assert.equal(called, false, 'the route handler must never run without the required permission');
  } finally {
    compositionSessionService.getCompositionSessionsForPatient = original;
    auth.restore();
    await server.close();
  }
});

test('GET /api/composition-sessions with form.execute reaches the route handler and returns its result as JSON', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  const original = compositionSessionService.getCompositionSessionsForPatient;
  const seen = [];
  compositionSessionService.getCompositionSessionsForPatient = async (patientId, actor) => {
    seen.push({ patientId, actor });
    return [{ id: 'session-1', patientId, status: 'draft' }];
  };
  try {
    auth.asUser(['form.execute']);
    const response = await fetch(`${server.baseUrl}/api/composition-sessions?patientId=p1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, [{ id: 'session-1', patientId: 'p1', status: 'draft' }]);
    // The route's actor() helper must have derived the real principal off
    // req.principal, not some default - proves attachAuth's context
    // actually flowed all the way through to the handler.
    assert.equal(seen[0].patientId, 'p1');
    assert.equal(seen[0].actor.userId, 'test-user');
  } finally {
    compositionSessionService.getCompositionSessionsForPatient = original;
    auth.restore();
    await server.close();
  }
});

test('a missing patientId query param is rejected 400 by the route itself, before ever calling the service', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  const original = compositionSessionService.getCompositionSessionsForPatient;
  let called = false;
  compositionSessionService.getCompositionSessionsForPatient = async () => { called = true; return []; };
  try {
    auth.asUser(['form.execute']);
    const response = await fetch(`${server.baseUrl}/api/composition-sessions`);
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    compositionSessionService.getCompositionSessionsForPatient = original;
    auth.restore();
    await server.close();
  }
});
