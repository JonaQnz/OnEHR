#!/usr/bin/env node
// Post-deploy smoke test for a running OnEHR environment.
//
// Usage:
//   SMOKE_BASE_URL=https://onehr-test.example \
//   SMOKE_USERNAME=admin SMOKE_PASSWORD=... \
//   SMOKE_EXPECT_VERSION=<commit-sha> \
//   node scripts/smoke-test.mjs
//
// Prints one PASS/FAIL line per step and exits 1 on any failure. It never
// prints the password or the session cookie.

const baseUrl = process.env.SMOKE_BASE_URL;
if (!baseUrl) {
  console.error('FAIL config: SMOKE_BASE_URL is required');
  process.exit(1);
}

const username = process.env.SMOKE_USERNAME || '';
const password = process.env.SMOKE_PASSWORD || '';
const expectVersion = process.env.SMOKE_EXPECT_VERSION || '';

let failures = 0;

function pass(step, detail) {
  console.log(`PASS ${step}${detail ? `: ${detail}` : ''}`);
}

function fail(step, detail) {
  failures += 1;
  console.log(`FAIL ${step}${detail ? `: ${detail}` : ''}`);
}

function url(pathname) {
  return new URL(pathname, baseUrl).toString();
}

async function request(pathname, init) {
  return fetch(url(pathname), init);
}

async function stepHealth() {
  const response = await request('/api/health');
  const body = await response.json().catch(() => null);
  if (response.status !== 200) {
    fail('GET /api/health', `HTTP ${response.status}`);
    return;
  }
  if (!body || body.status !== 'ok') {
    fail('GET /api/health', 'status is not ok');
    return;
  }
  if (expectVersion && body.version !== expectVersion) {
    fail(
      'GET /api/health',
      `version ${body.version ?? '<missing>'} != expected ${expectVersion}`,
    );
    return;
  }
  pass('GET /api/health', expectVersion ? `version ${expectVersion}` : undefined);
}

async function stepReady() {
  const response = await request('/api/health/ready');
  if (response.status === 200) {
    pass('GET /api/health/ready');
  } else {
    fail('GET /api/health/ready', `HTTP ${response.status}`);
  }
}

async function stepSpa() {
  const response = await request('/');
  const contentType = response.headers.get('content-type') || '';
  if (response.status !== 200) {
    fail('GET /', `HTTP ${response.status}`);
    return;
  }
  if (!contentType.includes('text/html')) {
    fail('GET /', `content-type "${contentType}" is not text/html`);
    return;
  }
  pass('GET /', 'text/html');
}

async function stepAuthenticatedRead() {
  if (!username || !password) {
    console.log('SKIP authenticated read: SMOKE_USERNAME/SMOKE_PASSWORD not set');
    return;
  }

  const login = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (login.status !== 200) {
    fail('POST /api/auth/login', `HTTP ${login.status}`);
    return;
  }

  const setCookies =
    typeof login.headers.getSetCookie === 'function'
      ? login.headers.getSetCookie()
      : [login.headers.get('set-cookie')].filter(Boolean);
  const cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
  if (!cookie) {
    fail('POST /api/auth/login', 'no session cookie returned');
    return;
  }
  pass('POST /api/auth/login');

  const me = await request('/api/auth/me', {
    headers: { cookie },
  });
  if (me.status === 200) {
    pass('GET /api/auth/me', 'authenticated');
  } else {
    fail('GET /api/auth/me', `HTTP ${me.status}`);
  }
}

async function main() {
  for (const step of [stepHealth, stepReady, stepSpa, stepAuthenticatedRead]) {
    try {
      await step();
    } catch (error) {
      fail(step.name, error instanceof Error ? error.message : String(error));
    }
  }

  if (failures > 0) {
    console.log(`\n${failures} step(s) failed`);
    process.exit(1);
  }
  console.log('\nAll smoke steps passed');
}

main();
