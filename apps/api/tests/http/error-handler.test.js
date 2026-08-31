const assert = require('node:assert/strict');
const test = require('node:test');
const { startTestServer } = require('../support/httpServer');
const { installTestAuth } = require('../support/testAuth');
const { HttpError } = require('../../dist/middleware/errorHandler');
const compositionSessionService = require('../../dist/services/compositionSessionService');

// errorHandler.ts's response-formatting can only really be proven correct
// at the HTTP boundary - a service-level test sees the thrown Error
// directly and never observes what actually gets serialized into the
// response body. This is exactly where the "never leak an unexpected
// error's raw .message" QA fix (errorHandler.ts) lives - the one behavior
// in this whole file that is structurally impossible to regression-test
// without a real HTTP round trip.
test('an HttpError thrown by a route\'s service call becomes exactly {status, error} on the wire, plus any details', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  const original = compositionSessionService.getCompositionSession;
  compositionSessionService.getCompositionSession = async () => {
    throw new HttpError(404, 'Composition session not found');
  };
  try {
    auth.asUser(['form.execute']);
    const response = await fetch(`${server.baseUrl}/api/composition-sessions/missing-id`);
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.deepEqual(body, { error: 'Composition session not found' });
  } finally {
    compositionSessionService.getCompositionSession = original;
    auth.restore();
    await server.close();
  }
});

test('an HttpError\'s details.messages/code survive onto the response body', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  const original = compositionSessionService.getCompositionSession;
  compositionSessionService.getCompositionSession = async () => {
    throw new HttpError(422, 'Composition session invalid', { code: 'COMPOSITION_INVALID', messages: [{ severity: 'error', path: 'block-1', message: 'missing value' }] });
  };
  try {
    auth.asUser(['form.execute']);
    const response = await fetch(`${server.baseUrl}/api/composition-sessions/some-id`);
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error, 'Composition session invalid');
    assert.equal(body.code, 'COMPOSITION_INVALID');
    assert.deepEqual(body.messages, [{ severity: 'error', path: 'block-1', message: 'missing value' }]);
  } finally {
    compositionSessionService.getCompositionSession = original;
    auth.restore();
    await server.close();
  }
});

test('an unexpected (non-HttpError) exception is reported as a bare 500 - its real message is never echoed back to the client', async () => {
  const server = await startTestServer();
  const auth = installTestAuth();
  const original = compositionSessionService.getCompositionSession;
  compositionSessionService.getCompositionSession = async () => {
    throw new Error('duplicate key value violates unique constraint "composition_sessions_pkey" on internal-db-host:5432');
  };
  try {
    auth.asUser(['form.execute']);
    const response = await fetch(`${server.baseUrl}/api/composition-sessions/some-id`);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.deepEqual(body, { error: 'Unexpected server error' });
    assert.ok(!JSON.stringify(body).includes('internal-db-host'), 'the internal error message must never reach the response body');
  } finally {
    compositionSessionService.getCompositionSession = original;
    auth.restore();
    await server.close();
  }
});
