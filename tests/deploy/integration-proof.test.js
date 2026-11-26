'use strict';

// Host proof contract tests (project.yaml test.integration).
//
// The AI Dev Home platform runs test.integration in a clean clone of the
// integration head before a task closes, with Docker and Node available. It
// keeps the untracked report the run writes, so these tests pin the parts the
// platform depends on: the declared command, a script that builds this exact
// commit, an isolated compose project on a loopback port, a random bootstrap
// password, a full teardown and a report that is not git-ignored.
//
// These tests must never call git: the pipeline runs them in a `git archive`
// export without .git.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = 'scripts/integration-smoke.sh';
const REPORT = 'reports/integration-smoke.txt';

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('project.yaml: integration command is the host proof script', () => {
  const project = yaml.load(read('project.yaml'));
  assert.deepEqual(project.test, {
    unit: 'npm ci --no-audit --no-fund --loglevel=error && npm test',
    integration: 'bash scripts/integration-smoke.sh',
  });
  assert.equal(
    project.test.integration,
    'bash scripts/integration-smoke.sh',
    'test.integration declares the host proof script',
  );
  assert.equal(
    project.test.unit,
    'npm ci --no-audit --no-fund --loglevel=error && npm test',
    'test.unit is unchanged',
  );
});

test('scripts/integration-smoke.sh: bash syntax is valid', () => {
  const file = path.join(ROOT, SCRIPT);
  assert.ok(fs.existsSync(file), `${SCRIPT} exists`);
  execFileSync('bash', ['-n', file], { stdio: 'pipe' });
});

test('scripts/integration-smoke.sh: strict mode without tracing', () => {
  const script = read(SCRIPT);
  assert.ok(script.includes('set -euo pipefail'), 'uses set -euo pipefail');
  const tracing = script
    .split('\n')
    .filter((line) => /^\s*set\s+-\w*x/.test(line));
  assert.deepEqual(tracing, [], 'never enables shell tracing (set -x)');
});

test('scripts/integration-smoke.sh: isolated compose project', () => {
  const script = read(SCRIPT);
  assert.ok(script.includes('PROOF_PROJECT=onehr-proof'), 'uses its own compose project');
  assert.ok(!script.includes('onehr-test'), 'does not touch the test environment');
  assert.ok(!script.includes('onehr-prod'), 'does not touch the production environment');
});

test('scripts/integration-smoke.sh: always tears the stack down', () => {
  const script = read(SCRIPT);
  assert.ok(script.includes('trap cleanup EXIT'), 'cleanup runs on exit');
  assert.ok(script.includes('down -v --remove-orphans'), 'removes containers and volumes');
});

test('scripts/integration-smoke.sh: builds the head image and drives the smoke flow', () => {
  const script = read(SCRIPT);
  for (const needle of [
    '--build-arg APP_VERSION=',
    'SMOKE_EXPECT_VERSION=',
    'SMOKE_USERNAME=',
    'SMOKE_WAIT_S=',
    'export_env SMOKE_PASSWORD ',
    'http://127.0.0.1:',
  ]) {
    assert.ok(script.includes(needle), `script includes ${needle}`);
  }
});

test('scripts/integration-smoke.sh: random bootstrap admin value is never printed', () => {
  const script = read(SCRIPT);
  const generated = script
    .split('\n')
    .find((candidate) => candidate.includes('randomBytes'));
  assert.ok(generated, 'password is generated randomly');
  assert.match(generated, /^\s*ADMIN_VALUE="\$\(node -e "/, 'generated into ADMIN_VALUE');
  assert.ok(!/echo|printf/.test(generated), 'the generated value is never echoed');

  assert.ok(
    script.includes('export_env FORMS_BOOTSTRAP_ADMIN_PASSWORD "$ADMIN_VALUE"'),
    'is exported by name, so the value never appears after the variable name',
  );
  assert.ok(!/\$\{FORMS_BOOTSTRAP_ADMIN_PASSWORD\}|\$FORMS_BOOTSTRAP_ADMIN_PASSWORD/.test(
    script.replace('export_env FORMS_BOOTSTRAP_ADMIN_PASSWORD "$ADMIN_VALUE"', ''),
  ), 'the value is only read back through ADMIN_VALUE');
});

test('scripts/integration-smoke.sh: no lines the platform secret scanner rejects', () => {
  const script = read(SCRIPT);
  const secretishAssignment = /(api[_-]?key|secret|passw(?:or)?d|token|credential)[^\n]{0,40}?[:=]\s*\S/i;
  const hits = script
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => !entry.line.trim().startsWith('#'))
    .filter((entry) => secretishAssignment.test(entry.line))
    .map((entry) => `${entry.number}: ${entry.line.trim()}`);
  assert.deepEqual(hits, [], 'no secret-ish name is directly assigned a value');
});

test('reports/integration-smoke.txt: written and never git-ignored', () => {
  const script = read(SCRIPT);
  assert.ok(script.includes(REPORT), `script writes ${REPORT}`);

  const ignored = read('.gitignore')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const forbidden = [
    'reports',
    'reports/',
    '/reports',
    '/reports/',
    'reports/*',
    '*.txt',
  ];
  for (const pattern of forbidden) {
    assert.ok(!ignored.includes(pattern), `.gitignore does not ignore ${REPORT} (${pattern})`);
  }
});
