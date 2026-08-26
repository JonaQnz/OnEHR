const assert = require('node:assert/strict');
const test = require('node:test');

const { getConfig, getSafeConfig, parseAdminAllowlist } = require('../dist/services/configService');
const { getEhrbaseRequestConfig } = require('../dist/services/ehrbaseConnectionPlugins');

test('configuration never falls back to a source-code EHRbase password', () => {
  const previous = process.env.EHRBASE_PASS;
  delete process.env.EHRBASE_PASS;

  try {
    assert.equal(getConfig().ehrbasePass, undefined);
    assert.equal(getSafeConfig().ehrbasePass, '');
  } finally {
    if (previous === undefined) delete process.env.EHRBASE_PASS;
    else process.env.EHRBASE_PASS = previous;
  }
});

test('safe configuration masks an explicitly configured password', () => {
  const previous = process.env.EHRBASE_PASS;
  process.env.EHRBASE_PASS = 'test-secret';

  try {
    assert.equal(getConfig().ehrbasePass, 'test-secret');
    assert.equal(getSafeConfig().ehrbasePass, '***');
  } finally {
    if (previous === undefined) delete process.env.EHRBASE_PASS;
    else process.env.EHRBASE_PASS = previous;
  }
});

test('AI provider keys remain server-only and are masked in safe configuration', () => {
  const previousFormScriptKey = process.env.FORM_SCRIPT_AI_API_KEY;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.FORM_SCRIPT_AI_API_KEY = 'ai-test-secret';
  process.env.OPENAI_API_KEY = 'fallback-secret';

  try {
    assert.equal(getConfig().scriptAiApiKey, 'ai-test-secret');
    assert.equal(getSafeConfig().scriptAiApiKey, '***');
  } finally {
    if (previousFormScriptKey === undefined) delete process.env.FORM_SCRIPT_AI_API_KEY;
    else process.env.FORM_SCRIPT_AI_API_KEY = previousFormScriptKey;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  }
});

test('connection plugins keep no-auth requests credential-free and isolate Basic Auth', async () => {
  const noAuth = await getEhrbaseRequestConfig({
    id: 'test-no-auth', name: 'No auth', url: 'http://ehrbase.test/rest/openehr/v1/', authPlugin: 'none',
  });
  assert.equal(noAuth.ehrbaseUrl, 'http://ehrbase.test/rest/openehr/v1');
  assert.equal(noAuth.auth, undefined);
  assert.equal(noAuth.headers.Authorization, undefined);

  const basic = await getEhrbaseRequestConfig({
    id: 'test-basic', name: 'Basic', url: 'http://ehrbase.test/rest/openehr/v1', authPlugin: 'basic', username: 'test-user', password: 'test-secret',
  });
  assert.deepEqual(basic.auth, { username: 'test-user', password: 'test-secret' });
  assert.equal(basic.headers.Authorization, undefined);
});

test('parseAdminAllowlist normalizes a comma-separated env value: trims, lowercases, drops blanks', () => {
  assert.deepEqual(parseAdminAllowlist('Jona.Kunze@VitaGroup.ag, another@example.com ,, '), ['jona.kunze@vitagroup.ag', 'another@example.com']);
  assert.deepEqual(parseAdminAllowlist(undefined), []);
  assert.deepEqual(parseAdminAllowlist(''), []);
  assert.deepEqual(parseAdminAllowlist('   '), []);
});

test('autosave and atomic-commit defaults preserve the pre-existing hardcoded behavior when nothing is configured', () => {
  const config = getConfig();
  assert.equal(config.autosaveEnabledByDefault, true);
  assert.equal(config.autosaveDebounceMsDefault, 2500);
  assert.equal(config.requireAtomicCommitByDefault, true);
  const safe = getSafeConfig();
  assert.equal(safe.autosaveEnabledByDefault, true);
  assert.equal(safe.autosaveDebounceMsDefault, 2500);
  assert.equal(safe.requireAtomicCommitByDefault, true);
});
