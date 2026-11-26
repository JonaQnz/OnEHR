'use strict';

// Smoke-test harness tests.
//
// scripts/smoke-test.mjs normally runs against a real deployment. Here a local
// stub server plays that deployment, so the smoke flow itself - including the
// steps that must fail - is verified without touching a real environment.
//
// The stub lives in this process, so the script must be run asynchronously
// with execFile: spawnSync/execFileSync would deadlock (the server could never
// answer).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
// Arbitrary stub credential for the local fake login endpoint - deliberately
// short and obviously fake; no real secret is involved anywhere in this test.
const PASSWORD = 'stub-pass';
const COOKIE_VALUE = 'stub-cookie-value';
const SESSION_COOKIE = `forms_session=${COOKIE_VALUE}`;

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// options.notReadyCalls: how many /api/health/ready calls answer 503 first.
// options.meAnonymous: /api/auth/me reports authenticated: false even with a cookie.
async function startStub(options = {}) {
  const notReadyCalls = options.notReadyCalls ?? 0;
  const meAnonymous = options.meAnonymous === true;
  let readyCalls = 0;
  let storedName = '';

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const hasCookie = (req.headers.cookie || '').includes(SESSION_COOKIE);

    if (pathname === '/api/health') {
      return sendJson(res, 200, { status: 'ok', version: 'abc123def456' });
    }

    if (pathname === '/api/health/ready') {
      readyCalls += 1;
      if (readyCalls <= notReadyCalls) return sendJson(res, 503, { status: 'starting' });
      return sendJson(res, 200, { status: 'ready' });
    }

    if (pathname === '/' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html></html>');
      return;
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      const body = parseJson(await readBody(req));
      if (body && body.username === 'admin' && body.password === PASSWORD) {
        return sendJson(res, 200, { authenticated: true }, {
          'set-cookie': `${SESSION_COOKIE}; HttpOnly; Path=/`,
        });
      }
      return sendJson(res, 401, { error: 'Invalid username or password' });
    }

    if (pathname === '/api/auth/me') {
      return sendJson(res, 200, { authenticated: hasCookie && !meAnonymous });
    }

    if (pathname.startsWith('/api/forms') && !hasCookie) {
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    if (pathname === '/api/forms' && req.method === 'POST') {
      const body = parseJson(await readBody(req));
      storedName = body && typeof body.name === 'string' ? body.name : '';
      return sendJson(res, 201, { form: { id: 'form-1', name: storedName } });
    }

    if (pathname === '/api/forms/form-1' && req.method === 'GET') {
      return sendJson(res, 200, { id: 'form-1', name: storedName });
    }

    if (pathname === '/api/forms/form-1/delete' && req.method === 'POST') {
      return sendJson(res, 200, {});
    }

    return sendJson(res, 404, { error: 'Not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function runSmoke(env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT, 'scripts', 'smoke-test.mjs')],
      { env: { ...process.env, ...env }, timeout: 60000 },
      (error, stdout) => {
        resolve({ code: error ? (error.code ?? 1) : 0, stdout });
      },
    );
  });
}

function baseEnv(baseUrl) {
  return {
    SMOKE_BASE_URL: baseUrl,
    SMOKE_USERNAME: 'admin',
    SMOKE_PASSWORD: PASSWORD,
    SMOKE_EXPECT_VERSION: '',
    SMOKE_WAIT_S: '0',
  };
}

test('runs the full authenticated flow without printing secrets', async () => {
  const { server, baseUrl } = await startStub();
  try {
    const { code, stdout } = await runSmoke(baseEnv(baseUrl));
    assert.equal(code, 0, stdout);
    for (const line of [
      'PASS GET /api/forms (no session)',
      'PASS GET /api/auth/me',
      'PASS POST /api/forms',
      'PASS GET /api/forms/:id',
      'PASS POST /api/forms/:id/delete',
    ]) {
      assert.ok(stdout.includes(line), `missing "${line}" in:\n${stdout}`);
    }
    assert.ok(!stdout.includes(PASSWORD), `stdout leaked the password:\n${stdout}`);
    assert.ok(!stdout.includes(COOKIE_VALUE), `stdout leaked the cookie:\n${stdout}`);
  } finally {
    await closeServer(server);
  }
});

test('fails when /api/auth/me is not authenticated', async () => {
  const { server, baseUrl } = await startStub({ meAnonymous: true });
  try {
    const { code, stdout } = await runSmoke(baseEnv(baseUrl));
    assert.equal(code, 1, stdout);
    assert.ok(stdout.includes('FAIL GET /api/auth/me'), stdout);
    assert.ok(!stdout.includes('PASS POST /api/forms'), `flow continued after the failure:\n${stdout}`);
  } finally {
    await closeServer(server);
  }
});

test('waits for readiness with SMOKE_WAIT_S', async () => {
  const { server, baseUrl } = await startStub({ notReadyCalls: 2 });
  try {
    const { code, stdout } = await runSmoke({ ...baseEnv(baseUrl), SMOKE_WAIT_S: '10' });
    assert.equal(code, 0, stdout);
    assert.ok(stdout.includes('PASS wait ready'), stdout);
  } finally {
    await closeServer(server);
  }
});

test('fails when readiness never arrives within SMOKE_WAIT_S', async () => {
  const { server, baseUrl } = await startStub({ notReadyCalls: 1000 });
  try {
    const { code, stdout } = await runSmoke({ ...baseEnv(baseUrl), SMOKE_WAIT_S: '1' });
    assert.equal(code, 1, stdout);
    assert.ok(stdout.includes('FAIL wait ready'), stdout);
  } finally {
    await closeServer(server);
  }
});

test('fails on a version mismatch', async () => {
  const { server, baseUrl } = await startStub();
  try {
    const { code, stdout } = await runSmoke({ ...baseEnv(baseUrl), SMOKE_EXPECT_VERSION: 'other' });
    assert.equal(code, 1, stdout);
    assert.ok(stdout.includes('FAIL GET /api/health'), stdout);
  } finally {
    await closeServer(server);
  }
});
