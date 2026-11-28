#!/usr/bin/env node
// Post-deploy smoke test for a running OnEHR environment.
//
// Usage:
//   SMOKE_BASE_URL=https://onehr-test.example \
//   SMOKE_USERNAME=admin SMOKE_PASSWORD=... \
//   SMOKE_EXPECT_VERSION=<commit-sha> \
//   SMOKE_WAIT_S=180 \
//   node scripts/smoke-test.mjs
//
// Steps:
//   wait ready                 - with SMOKE_WAIT_S > 0, poll /api/health/ready
//                                every second until it answers 200 or time is up
//   GET /api/health            - liveness (and version, if SMOKE_EXPECT_VERSION)
//   GET /api/health/ready      - readiness
//   GET /                      - the SPA shell is served as text/html
//   GET /api/forms (no session)- anonymous /api/forms?summary=true is rejected
//   POST /api/auth/login       - log in with SMOKE_USERNAME/SMOKE_PASSWORD
//   GET /api/auth/me           - the session reports authenticated === true
//   POST /api/forms            - create a synthetic smoke-synthetic-<ts> form
//   GET /api/forms/:id         - read that form back
//   POST /api/forms/:id/delete - delete that form again
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
const parsedWaitS = Number.parseInt(process.env.SMOKE_WAIT_S ?? '', 10);
const waitS = Number.isInteger(parsedWaitS) && parsedWaitS > 0 ? parsedWaitS : 0;

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
  return fetch(url(pathname), { ...init, signal: AbortSignal.timeout(15000) });
}

async function waitReady() {
  if (waitS === 0) return;

  const deadline = Date.now() + waitS * 1000;
  for (;;) {
    try {
      const response = await request('/api/health/ready');
      if (response.status === 200) {
        pass('wait ready', `after ${waitS}s`);
        return;
      }
    } catch {
      // A thrown fetch error (connection refused) simply means "not ready yet".
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  fail('wait ready', `not ready after ${waitS}s`);
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

async function stepAuthenticatedFlow() {
  const anonymous = await request('/api/forms?summary=true');
  if (anonymous.status !== 401 && anonymous.status !== 403) {
    fail('GET /api/forms (no session)', `HTTP ${anonymous.status}`);
    return;
  }
  pass('GET /api/forms (no session)', `HTTP ${anonymous.status}`);

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

  // The /me route also answers 200 to anonymous callers (authRoutes.ts:8), so
  // the status alone proves nothing - the body must report authenticated.
  const me = await request('/api/auth/me', {
    headers: { cookie },
  });
  const meBody = await me.json().catch(() => null);
  if (me.status !== 200 || !meBody || meBody.authenticated !== true) {
    fail('GET /api/auth/me', 'not authenticated');
    return;
  }
  pass('GET /api/auth/me', 'authenticated');

  // Read-only: the patient-cockpit setting PatientDetail resolves the Cockpit
  // tab from must reach signed-in users (no config is changed here).
  const defaults = await request('/api/config/runtime-defaults', { headers: { cookie } });
  const defaultsBody = await defaults.json().catch(() => null);
  if (defaults.status !== 200 || !defaultsBody || typeof defaultsBody.patientCockpitFormParentId !== 'string') {
    fail('GET /api/config/runtime-defaults', `HTTP ${defaults.status}`);
    return;
  }
  pass('GET /api/config/runtime-defaults', 'patientCockpitFormParentId present');

  // Synthetic data only: created here, read back and deleted again.
  const name = `smoke-synthetic-${Date.now()}`;
  const created = await request('/api/forms', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name }),
  });
  const createdBody = await created.json().catch(() => null);
  const id = createdBody && createdBody.form ? createdBody.form.id : undefined;
  if (created.status !== 201 || typeof id !== 'string') {
    fail('POST /api/forms', `HTTP ${created.status}`);
    return;
  }
  pass('POST /api/forms', `synthetic form ${id}`);

  const read = await request(`/api/forms/${encodeURIComponent(id)}`, {
    headers: { cookie },
  });
  const readBody = await read.json().catch(() => null);
  if (read.status !== 200 || !readBody || readBody.name !== name) {
    fail('GET /api/forms/:id', `HTTP ${read.status}`);
    return;
  }
  pass('GET /api/forms/:id');

  const deleted = await request(`/api/forms/${encodeURIComponent(id)}/delete`, {
    method: 'POST',
    headers: { cookie },
  });
  if (deleted.status !== 200) {
    fail('POST /api/forms/:id/delete', `HTTP ${deleted.status}`);
    return;
  }
  pass('POST /api/forms/:id/delete', 'cleaned up');
}

async function main() {
  try {
    await waitReady();
  } catch (error) {
    fail('wait ready', error instanceof Error ? error.message : String(error));
  }

  for (const step of [stepHealth, stepReady, stepSpa, stepAuthenticatedFlow]) {
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
