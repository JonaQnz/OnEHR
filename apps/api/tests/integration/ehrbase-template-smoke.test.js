const assert = require('node:assert/strict');
const test = require('node:test');

const baseUrl = (process.env.EHRBASE_TEST_URL || 'http://localhost:8082/ehrbase/rest/openehr/v1').replace(/\/$/, '');
const credentials = Buffer.from(`${process.env.EHRBASE_TEST_USER || 'ehrbase-user'}:${process.env.EHRBASE_TEST_PASSWORD || 'SuperSecretPassword'}`).toString('base64');
const modelsBaseUrl = 'https://raw.githubusercontent.com/vitagroupag/openEHR_models/main/local';
const optionalOptUrl = process.env.EHRBASE_TEST_VG_OPT_URL;
const optionalOptTemplateId = process.env.EHRBASE_TEST_VG_OPT_TEMPLATE_ID;

// Deliberately small, versioned subset of the requested vg_ catalogue.
const models = [
  { file: 'vg_BodyWeight.v1.0.1.t.json', templateId: 'vg_BodyWeight.v1.0.1' },
  { file: 'vg_HeartRate.v1.0.1.t.json', templateId: 'vg_HeartRate.v1.0.1' },
];

async function request(path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${credentials}`,
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
}

async function readBody(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : undefined; } catch { return text; }
}

test('selected vg_ template JSON fixtures are recognised, while EHRbase rejects their incompatible import format', async () => {
  for (const model of models) {
    const fixtureResponse = await fetch(`${modelsBaseUrl}/${model.file}`);
    assert.equal(fixtureResponse.status, 200, `fixture ${model.file} is available`);
    const fixture = await fixtureResponse.json();
    assert.equal(fixture.templateId, model.templateId);
    assert.equal(fixture['@type'], 'TEMPLATE');
    assert.equal(fixture.adlVersion, '1.4');

    // EHRbase currently accepts ADL 1.4 OPT XML at this endpoint, not the
    // JSON serialisation published by the requested model catalogue.
    // Keep this explicit so a future EHRbase change becomes visible rather
    // than making the integration suite silently claim a successful upload.
    const upload = await request('/definition/template/adl1.4', {
      method: 'POST',
      body: JSON.stringify(fixture),
    });
    assert.equal(upload.status, 415, `EHRbase unexpectedly accepted ADL2 JSON for ${model.templateId}: ${JSON.stringify(await readBody(upload))}`);
  }
});

test('local EHRbase imports a supplied vg_ ADL 1.4 OPT and exposes its WebTemplate', {
  skip: !optionalOptUrl || !optionalOptTemplateId,
}, async () => {
  const fixtureResponse = await fetch(optionalOptUrl);
  assert.equal(fixtureResponse.status, 200, 'configured ADL 1.4 OPT fixture is available');
  const opt = await fixtureResponse.text();
  assert.match(opt, /<template[ >]/);

  const upload = await request('/definition/template/adl1.4', {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: opt,
  });
  assert.ok(upload.ok || upload.status === 409, `OPT upload failed for ${optionalOptTemplateId}: ${JSON.stringify(await readBody(upload))}`);

  const webTemplate = await request(`/definition/template/adl1.4/${encodeURIComponent(optionalOptTemplateId)}/webtemplate`);
  assert.equal(webTemplate.status, 200, 'WebTemplate is available after OPT upload');
  const document = await readBody(webTemplate);
  assert.equal(document.templateId, optionalOptTemplateId);
  assert.ok(document.tree && typeof document.tree === 'object');
});
