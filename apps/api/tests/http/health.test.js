const assert = require('node:assert/strict');
const test = require('node:test');
const { startTestServer } = require('../support/httpServer');

// The very first HTTP-layer test in this repo - every other existing test
// (229 of them, as of this writing) calls service functions directly
// against a mocked Prisma, never through Express itself. This file and its
// siblings under tests/http/ exercise the real request/response cycle:
// routing, express.json() body parsing, attachAuth/requirePermission
// middleware ordering, and errorHandler's response shape - none of which a
// service-level test can catch a regression in.
test('GET /api/health responds 200 with a timestamped ok status, unauthenticated', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.timestamp, 'string');
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
  } finally {
    await server.close();
  }
});

test('an unknown route falls through to Express\' own 404, not the app\'s errorHandler', async () => {
  const server = await startTestServer();
  try {
    const response = await fetch(`${server.baseUrl}/api/this-route-does-not-exist`);
    assert.equal(response.status, 404);
  } finally {
    await server.close();
  }
});
