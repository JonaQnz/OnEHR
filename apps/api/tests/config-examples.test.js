const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { scanText } = require('../../../scripts/secret-scan');

const root = path.resolve(__dirname, '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
// redacted: file, line and rule id only, never a value
const findings = (text, file) => scanText(text, file).map((f) => `${file}:${f.line} ${f.rule}`);

const CONFIG_KEYS = ['ehrbaseUrl', 'ehrbaseUser', 'ehrbasePass', 'ehrbaseSubjectNamespace', 'authMode',
  'keycloakApi', 'keycloakTenantName', 'keycloakClientId', 'keycloakGrantType', 'mappingServiceApi',
  'pluginPackages', 'userAuthMode', 'localUsername', 'hipIssuerUrl', 'hipAuthorizationUrl', 'hipTokenUrl',
  'hipUserInfoUrl', 'hipClientId', 'hipRedirectUri', 'hipScopes', 'defaultEhrId', 'sessionCookieSecure',
  'scriptAiBaseUrl', 'scriptAiModel'];

const ENV_NAMES = ['DATABASE_URL', 'PORT', 'WEB_ORIGIN', 'DATA_DIR', 'EHRBASE_URL', 'EHRBASE_USER',
  'EHRBASE_PASS', 'AUTH_MODE', 'KEYCLOAK_API', 'KEYCLOAK_TENANT_NAME', 'KEYCLOAK_CLIENT_ID',
  'KEYCLOAK_GRANT_TYPE', 'EHRBASE_SUBJECT_NAMESPACE', 'DEFAULT_EHR_ID', 'MAPPING_SERVICE_API',
  'USER_AUTH_MODE', 'SESSION_LIFETIME_MINUTES', 'LOCAL_AUTH_USERNAME', 'LOCAL_AUTH_PASSWORD',
  'FORMS_BOOTSTRAP_ADMIN_USERNAME', 'FORMS_BOOTSTRAP_ADMIN_PASSWORD', 'FORMS_BOOTSTRAP_ADMIN_DISPLAY_NAME',
  'FORMS_BOOTSTRAP_ADMIN_EMAIL', 'FORMS_HIP_ADMIN_EMAILS', 'SESSION_COOKIE_SECURE', 'FORM_SCRIPT_AI_BASE_URL',
  'FORM_SCRIPT_AI_API_KEY', 'FORM_SCRIPT_AI_MODEL', 'OPENAI_API_KEY', 'FHIR_CDR_URL', 'FORM_BUILDER_PLUGINS'];

test('apps/data/config.example.json lists the runtime keys with empty credentials', () => {
  const file = 'apps/data/config.example.json';
  const text = read(file);
  const config = JSON.parse(text);
  assert.deepEqual(Object.keys(config).sort(), [...CONFIG_KEYS].sort());
  for (const key of ['ehrbaseUser', 'ehrbasePass', 'localUsername', 'hipClientId', 'defaultEhrId']) {
    assert.equal(config[key], '', `${key} must be empty`);
  }
  assert.deepEqual(findings(text, file), []);
});

test('apps/api/.env.example documents every variable with empty secrets', () => {
  const file = 'apps/api/.env.example';
  const text = read(file);
  const entries = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) entries.set(match[1], match[2]);
  }
  for (const name of ENV_NAMES) assert.ok(entries.has(name), `${name} is missing`);
  for (const [name, value] of entries) {
    if (name === 'DATABASE_URL' || /(PASS|PASSWORD|SECRET|API_KEY|TOKEN)$/.test(name)) {
      assert.equal(value, '', `${name} must be empty`);
    }
  }
  assert.deepEqual(findings(text, file), []);
});
