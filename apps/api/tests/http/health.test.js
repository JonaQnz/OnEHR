const assert = require('node:assert/strict');
const test = require('node:test');
const { startTestServer } = require('../support/httpServer');
const prisma = require('../../dist/db/prisma').default;

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

test('GET /api/health reports APP_VERSION when set and dev when unset', async () => {
  const originalVersion = process.env.APP_VERSION;
  const server = await startTestServer();
  try {
    process.env.APP_VERSION = 'test-version-123';
    let response = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).version, 'test-version-123');

    delete process.env.APP_VERSION;
    response = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).version, 'dev');
  } finally {
    await server.close();
    if (originalVersion === undefined) {
      delete process.env.APP_VERSION;
    } else {
      process.env.APP_VERSION = originalVersion;
    }
  }
});

test('GET /api/health/ready responds 200 ready when the database answers', async () => {
  const originalQueryRaw = prisma.$queryRaw;
  let server;
  try {
    prisma.$queryRaw = async () => [{ '?column?': 1 }];
    server = await startTestServer();
    const response = await fetch(`${server.baseUrl}/api/health/ready`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'ready');
    assert.equal(typeof body.version, 'string');
  } finally {
    if (server) await server.close();
    prisma.$queryRaw = originalQueryRaw;
  }
});

test('GET /api/health/ready responds 503 without error details when the database fails', async () => {
  const originalQueryRaw = prisma.$queryRaw;
  let server;
  try {
    prisma.$queryRaw = async () => {
      throw new Error('connection refused postgres://user:secret@db:5432/onehr');
    };
    server = await startTestServer();
    const response = await fetch(`${server.baseUrl}/api/health/ready`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.deepEqual(body, { status: 'unavailable' });
    assert.ok(!JSON.stringify(body).includes('secret'));
  } finally {
    if (server) await server.close();
    prisma.$queryRaw = originalQueryRaw;
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
