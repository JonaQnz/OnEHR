import assert from 'node:assert/strict';
import test from 'node:test';
import { FormbuilderApiClient, FormbuilderApiError } from '../dist/apiClient.js';

function jsonResponse(status, body, headers = {}) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers });
}

function config() {
  return { baseUrl: 'http://forms.test', username: 'jona.kunze@vitagroup.ag', password: 'secret' };
}

test('logs in once, reuses the session cookie across subsequent calls', async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, cookie: init?.headers?.Cookie });
    if (String(url).endsWith('/api/auth/login')) return jsonResponse(200, { authenticated: true }, { 'Set-Cookie': 'forms_session=abc123; HttpOnly' });
    return jsonResponse(200, { ok: true });
  };
  const client = new FormbuilderApiClient(config(), fetchStub);

  await client.get('/api/forms');
  await client.get('/api/forms/1');

  assert.equal(calls.length, 3, 'expected one login call plus one call per request');
  assert.match(calls[0].url, /\/api\/auth\/login$/);
  assert.equal(calls[1].cookie, 'forms_session=abc123');
  assert.equal(calls[2].cookie, 'forms_session=abc123');
});

test('a failed login (no Set-Cookie, non-ok status) throws a descriptive FormbuilderApiError', async () => {
  const fetchStub = async () => jsonResponse(401, { error: 'Invalid username or password' });
  const client = new FormbuilderApiClient(config(), fetchStub);

  await assert.rejects(client.get('/api/forms'), (error) => {
    assert.ok(error instanceof FormbuilderApiError);
    assert.equal(error.status, 401);
    assert.match(error.message, /login failed/);
    return true;
  });
});

test('a 401 on a normal request triggers exactly one re-login retry, not an infinite loop', async () => {
  let loginCount = 0;
  let requestCount = 0;
  const fetchStub = async (url) => {
    if (String(url).endsWith('/api/auth/login')) {
      loginCount += 1;
      return jsonResponse(200, { authenticated: true }, { 'Set-Cookie': `forms_session=session-${loginCount}; HttpOnly` });
    }
    requestCount += 1;
    // Every real request 401s, simulating an always-expired/invalid session.
    return jsonResponse(401, { error: 'Session expired' });
  };
  const client = new FormbuilderApiClient(config(), fetchStub);

  await assert.rejects(client.get('/api/forms'), (error) => {
    assert.ok(error instanceof FormbuilderApiError);
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(loginCount, 2, 'expected the initial login plus exactly one re-login after the 401');
  assert.equal(requestCount, 2, 'expected the initial attempt plus exactly one retry');
});

test('a non-ok response surfaces the parsed error body through FormbuilderApiError', async () => {
  const fetchStub = async (url) => {
    if (String(url).endsWith('/api/auth/login')) return jsonResponse(200, {}, { 'Set-Cookie': 'forms_session=abc; HttpOnly' });
    return jsonResponse(422, { error: 'Form is not a Composition' });
  };
  const client = new FormbuilderApiClient(config(), fetchStub);

  await assert.rejects(client.post('/api/forms/1/composition-script/check', { source: '' }), (error) => {
    assert.ok(error instanceof FormbuilderApiError);
    assert.equal(error.status, 422);
    assert.equal(error.message, 'Form is not a Composition');
    assert.deepEqual(error.body, { error: 'Form is not a Composition' });
    return true;
  });
});

test('put/patch send the given body and method', async () => {
  const seen = [];
  const fetchStub = async (url, init) => {
    if (String(url).endsWith('/api/auth/login')) return jsonResponse(200, {}, { 'Set-Cookie': 'forms_session=abc; HttpOnly' });
    seen.push({ method: init?.method, body: init?.body ? JSON.parse(init.body) : undefined });
    return jsonResponse(200, { ok: true });
  };
  const client = new FormbuilderApiClient(config(), fetchStub);

  await client.put('/api/forms/1', { name: 'Updated' });
  await client.patch('/api/form-sessions/1', { values: { a: 1 } });

  assert.deepEqual(seen, [
    { method: 'PUT', body: { name: 'Updated' } },
    { method: 'PATCH', body: { values: { a: 1 } } },
  ]);
});
