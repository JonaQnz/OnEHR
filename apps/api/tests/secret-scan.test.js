const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const {
  RULES,
  scanText,
  assignGroups,
  applyAllowlist,
  summarize,
  scanPatch,
  summarizeHistory,
} = require('../../../scripts/secret-scan');

// Synthetic secret material is assembled at runtime so this test file does not
// itself contain a literal credential.
const AWS_KEY = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const GITHUB_TOKEN = 'gh' + 'p_' + 'a'.repeat(36);
const LLM_KEY = 'sk-' + 'a'.repeat(24);
const SLACK_TOKEN = 'xox' + 'b-' + '1234567890';
const URL_PASSWORD = 'hunter2pass';
const JSON_SECRET = 'json' + 'secretvalue123';
const ENV_SECRET = 'env' + 'secretvalue456';
const PRIVATE_KEY_HEADER = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----';

function rulesOf(text) {
  return scanText(text, 'sample.txt').map((finding) => finding.rule);
}

test('RULES exposes id and description for every rule', () => {
  assert.ok(Array.isArray(RULES));
  for (const rule of RULES) {
    assert.equal(typeof rule.id, 'string');
    assert.ok(rule.id.length > 0);
    assert.equal(typeof rule.description, 'string');
  }
});

test('each rule matches a synthetic line', () => {
  assert.deepEqual(rulesOf(PRIVATE_KEY_HEADER), ['private-key']);
  assert.deepEqual(rulesOf(`key = ${AWS_KEY}`), ['aws-access-key']);
  assert.deepEqual(rulesOf(`token: ${GITHUB_TOKEN}`), ['github-token']);
  assert.deepEqual(rulesOf(`OPENROUTER_API_KEY=${LLM_KEY}`), ['llm-api-key', 'env-secret-assignment']);
  assert.deepEqual(rulesOf(`slack = ${SLACK_TOKEN}`), ['slack-token']);
  assert.deepEqual(rulesOf(`db = postgres://user:${URL_PASSWORD}@db.example.com/app`), ['url-credentials']);
  assert.deepEqual(rulesOf(`{"clientSecret": "${JSON_SECRET}"}`), ['json-secret-field']);
  assert.deepEqual(rulesOf(`DOCKER_PASSWORD=${ENV_SECRET}`), ['env-secret-assignment']);
});

test('useful values and line numbers are reported', () => {
  const [finding] = scanText(`first line\nsecond ${AWS_KEY}`, 'config/env.txt');
  assert.equal(finding.path, 'config/env.txt');
  assert.equal(finding.line, 2);
  assert.equal(finding.rule, 'aws-access-key');
  assert.equal(finding.group, null);
});

test('url-credentials keeps only the password as internal value', () => {
  const [finding] = scanText(`db = postgres://user:${URL_PASSWORD}@db.example.com/app`, 'sample.txt');
  assert.equal(finding._value, URL_PASSWORD);
});

test('placeholders and references are not reported', () => {
  assert.deepEqual(rulesOf('{"token": ""}'), []);
  assert.deepEqual(rulesOf('{"token": "***"}'), []);
  assert.deepEqual(rulesOf('{"token": "CHANGEME"}'), []);
  assert.deepEqual(rulesOf('{"token": "placeholder"}'), []);
  assert.deepEqual(rulesOf('{"token": "<redacted>"}'), []);
  assert.deepEqual(rulesOf('{"apiKey": "example"}'), []);
  assert.deepEqual(rulesOf('{"secret": "xxx"}'), []);
  assert.deepEqual(rulesOf('EHRBASE_PASS=' + '${EHRBASE_PASS}'), []);
  assert.deepEqual(rulesOf('EHRBASE_PASS=' + '$EHRBASE_PASS'), []);
  assert.deepEqual(rulesOf('API_TOKEN=' + 'process.env.API_TOKEN'), []);
  assert.deepEqual(rulesOf(`db = postgres://user:${'${DB_PASS}'}@db.example.com/app`), []);
});

test('JSON serialization never contains the matched secret', () => {
  const findings = scanText(`key = ${AWS_KEY}\ntoken = ${GITHUB_TOKEN}`, 'sample.txt');
  assert.equal(findings.length, 2);
  const serialized = JSON.stringify(findings);
  assert.ok(!serialized.includes(AWS_KEY));
  assert.ok(!serialized.includes(GITHUB_TOKEN));
  for (const finding of findings) {
    assert.deepEqual(Object.keys(finding).sort(), ['group', 'line', 'path', 'rule']);
  }
});

test('assignGroups reuses one id for repeated values and leaves unique values null', () => {
  const repeatedA = scanText(`key = ${AWS_KEY}`, 'a.txt');
  const repeatedB = scanText(`key = ${AWS_KEY}`, 'b.txt');
  const unique = scanText(`token = ${GITHUB_TOKEN}`, 'c.txt');

  const findings = assignGroups([...repeatedA, ...repeatedB, ...unique]);

  assert.equal(typeof findings[0].group, 'number');
  assert.equal(findings[0].group, findings[1].group);
  assert.equal(findings[2].group, null);
  assert.ok(!JSON.stringify(findings).includes(AWS_KEY));
});

test('applyAllowlist splits findings by exact path and rule', () => {
  const findings = [
    ...scanText(`key = ${AWS_KEY}`, 'a.txt'),
    ...scanText(`key = ${AWS_KEY}`, 'b.txt'),
    ...scanText(`token = ${GITHUB_TOKEN}`, 'a.txt'),
  ];

  const allowlist = [
    { path: 'a.txt', rule: 'aws-access-key', reason: 'test fixture' },
    { path: 'b.txt', rule: 'github-token', reason: 'does not match' },
  ];

  const { remaining, allowed } = applyAllowlist(findings, allowlist);

  assert.equal(remaining.length, 2);
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].path, 'a.txt');
  assert.equal(allowed[0].rule, 'aws-access-key');
  assert.deepEqual(
    remaining.map((finding) => `${finding.path}:${finding.rule}`),
    ['b.txt:aws-access-key', 'a.txt:github-token'],
  );
});

test('summarize counts totals by rule and by path', () => {
  const findings = [
    ...scanText(`key = ${AWS_KEY}`, 'a.txt'),
    ...scanText(`key = ${AWS_KEY}`, 'b.txt'),
    ...scanText(`token = ${GITHUB_TOKEN}`, 'a.txt'),
  ];

  assert.deepEqual(summarize(findings), {
    total: 3,
    byRule: { 'aws-access-key': 2, 'github-token': 1 },
    byPath: { 'a.txt': 2, 'b.txt': 1 },
  });
});

const FAKE_A = 'fake' + '-history-a';
const FAKE_B = 'fake' + '-history-b';
const FAKE_C = 'fake' + '-history-c';

// Shaped like `git log -p --format='commit %H'` output.
const HISTORY_PATCH = [
  'commit ' + 'a'.repeat(40),
  '+++ b/apps/data/config.json',
  `+  "ehrbasePass": "${FAKE_A}",`,
  `-  "ehrbasePass": "${FAKE_C}",`,
  'commit ' + 'b'.repeat(40),
  '+++ b/docker-compose.yml',
  `+      SECURITY_AUTHPASSWORD: ${FAKE_A}`,
  `+      DB_PASS: ${FAKE_B}`,
  `+      DB_PASS_ADMIN: ${FAKE_B}`,
  '+++ /dev/null',
  `+      OTHER_PASSWORD: ${FAKE_C}`,
].join('\n');

test('scanPatch deduplicates history findings per commit, path, rule and value', () => {
  const findings = scanPatch(HISTORY_PATCH);
  assert.deepEqual(
    findings.map(({ commit, path, rule }) => ({ commit, path, rule })),
    [
      { commit: 'aaaaaaaaaa', path: 'apps/data/config.json', rule: 'json-secret-field' },
      { commit: 'bbbbbbbbbb', path: 'docker-compose.yml', rule: 'env-secret-assignment' },
      { commit: 'bbbbbbbbbb', path: 'docker-compose.yml', rule: 'env-secret-assignment' },
    ],
  );
});

test('history findings never serialize their values', () => {
  const findings = scanPatch(HISTORY_PATCH);
  const serialized = JSON.stringify(findings);
  assert.ok(!serialized.includes(FAKE_A));
  assert.ok(!serialized.includes(FAKE_B));
  assert.ok(!serialized.includes(FAKE_C));
  assert.deepEqual(Object.keys(findings[0]), ['commit', 'path', 'rule', 'group']);
  assert.equal(findings[0]._value, FAKE_A);
});

test('assignGroups shares ids between tree and history findings with the same value', () => {
  const all = assignGroups([
    ...scanText(`DB_PASSWORD=${FAKE_A}`, 'tree.env'),
    ...scanPatch(HISTORY_PATCH),
  ]);

  const treeFinding = all[0];
  const configFinding = all[1];
  const authFinding = all[2];
  const dbFinding = all[3];

  assert.equal(typeof treeFinding.group, 'number');
  assert.notEqual(treeFinding.group, null);
  assert.equal(configFinding.group, treeFinding.group);
  assert.equal(authFinding.group, treeFinding.group);
  assert.equal(dbFinding.group, null);
});

test('summarizeHistory groups commits by path and rule', () => {
  const findings = [
    { commit: 'c3', path: 'b.yml', rule: 'env-secret-assignment', group: 2 },
    { commit: 'c2', path: 'a.json', rule: 'json-secret-field', group: null },
    { commit: 'c1', path: 'b.yml', rule: 'env-secret-assignment', group: 1 },
    { commit: 'c1', path: 'b.yml', rule: 'env-secret-assignment', group: 2 },
  ];

  assert.deepEqual(summarizeHistory(findings), [
    { path: 'a.json', rule: 'json-secret-field', commits: 1, newest: 'c2', oldest: 'c2', groups: [] },
    { path: 'b.yml', rule: 'env-secret-assignment', commits: 2, newest: 'c3', oldest: 'c1', groups: [1, 2] },
  ]);
});

test('this test file contains no literal secret-like values', () => {
  const text = fs.readFileSync(__filename, 'utf8');
  assert.deepEqual(scanText(text, 'apps/api/tests/secret-scan.test.js'), []);
});
