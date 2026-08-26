import assert from 'node:assert/strict';
import test from 'node:test';
import { EhrbaseClient, EhrbaseError } from '../dist/ehrbaseClient.js';

function textResponse(status, text) {
  return new Response(text, { status });
}

function connection() {
  return { id: 'test-conn', name: 'Test', url: 'https://ehrbase.test/rest/openehr/v1', authPlugin: 'none' };
}

function deps(fetchImpl, overrides = {}) {
  return { getConnection: () => connection(), resolveAuth: async () => 'Bearer token-123', fetchImpl, ...overrides };
}

test('listTemplates GETs /definition/template/adl1.4 and parses the JSON array', async () => {
  const calls = [];
  const fetchStub = async (url, init) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers });
    return textResponse(200, JSON.stringify([{ template_id: 'vg_Procedure.v1.1.0', version: '1.1.0', concept: 'vg_Procedure.v1.1.0', archetype_id: 'openEHR-EHR-COMPOSITION.report.v1', created_timestamp: '2026-01-01T00:00:00Z' }]));
  };
  const client = new EhrbaseClient(deps(fetchStub));

  const result = await client.listTemplates();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ehrbase.test/rest/openehr/v1/definition/template/adl1.4');
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, 'Bearer token-123');
  assert.deepEqual(result, [{ template_id: 'vg_Procedure.v1.1.0', version: '1.1.0', concept: 'vg_Procedure.v1.1.0', archetype_id: 'openEHR-EHR-COMPOSITION.report.v1', created_timestamp: '2026-01-01T00:00:00Z' }]);
});

test('getTemplateWebTemplate requests Accept: application/openehr.wt+json on the detail path', async () => {
  let seenAccept;
  const fetchStub = async (url, init) => {
    seenAccept = init.headers.Accept;
    assert.equal(String(url), 'https://ehrbase.test/rest/openehr/v1/definition/template/adl1.4/vg_Procedure.v1.1.0');
    return textResponse(200, JSON.stringify({ templateId: 'vg_Procedure.v1.1.0', tree: {} }));
  };
  const client = new EhrbaseClient(deps(fetchStub));

  const result = await client.getTemplateWebTemplate('vg_Procedure.v1.1.0');

  assert.equal(seenAccept, 'application/openehr.wt+json');
  assert.deepEqual(result, { templateId: 'vg_Procedure.v1.1.0', tree: {} });
});

test('getTemplateOpt requests Accept: application/xml and returns the raw text unparsed', async () => {
  let seenAccept;
  const fetchStub = async (url, init) => {
    seenAccept = init.headers.Accept;
    return textResponse(200, '<template><template_id>vg_Procedure.v1.1.0</template_id></template>');
  };
  const client = new EhrbaseClient(deps(fetchStub));

  const result = await client.getTemplateOpt('vg_Procedure.v1.1.0');

  assert.equal(seenAccept, 'application/xml');
  assert.equal(result, '<template><template_id>vg_Procedure.v1.1.0</template_id></template>');
});

test('uploadTemplate POSTs Content-Type: application/xml with the OPT body and reports "created" on 2xx', async () => {
  let seen;
  const fetchStub = async (url, init) => {
    seen = { url: String(url), method: init.method, contentType: init.headers['Content-Type'], body: init.body };
    return textResponse(201, '');
  };
  const client = new EhrbaseClient(deps(fetchStub));

  const result = await client.uploadTemplate('<template>...</template>');

  assert.equal(seen.url, 'https://ehrbase.test/rest/openehr/v1/definition/template/adl1.4');
  assert.equal(seen.method, 'POST');
  assert.equal(seen.contentType, 'application/xml');
  assert.equal(seen.body, '<template>...</template>');
  assert.deepEqual(result, { status: 'created' });
});

test('uploadTemplate reports "already_exists" (not an error) on a 409', async () => {
  const fetchStub = async () => textResponse(409, 'template already exists');
  const client = new EhrbaseClient(deps(fetchStub));

  const result = await client.uploadTemplate('<template>...</template>');

  assert.deepEqual(result, { status: 'already_exists' });
});

test('a genuine validation failure (4xx other than 409) throws EhrbaseError with the response body', async () => {
  const fetchStub = async () => textResponse(400, JSON.stringify({ error: 'Invalid ADL: unresolved at-code at0099' }));
  const client = new EhrbaseClient(deps(fetchStub));

  await assert.rejects(client.uploadTemplate('<template>broken</template>'), (error) => {
    assert.ok(error instanceof EhrbaseError);
    assert.equal(error.status, 400);
    assert.deepEqual(error.body, { error: 'Invalid ADL: unresolved at-code at0099' });
    return true;
  });
});

test('the "none" auth plugin sends no Authorization header', async () => {
  let seenAuth = 'not-checked';
  const fetchStub = async (url, init) => { seenAuth = init.headers.Authorization; return textResponse(200, '[]'); };
  const client = new EhrbaseClient(deps(fetchStub, { resolveAuth: async () => undefined }));

  await client.listTemplates();

  assert.equal(seenAuth, undefined);
});
