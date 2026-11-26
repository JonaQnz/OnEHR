'use strict';

// Deployment documentation tests.
//
// These keep docs/deployment.md in sync with the deploy files and the host
// proof script. They only read text files, so they work in a pipeline
// checkout without .git.
//
// AGENTS.md is agent configuration and is not written by workers, so the
// conventions are documented here in docs/deployment.md instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('docs/deployment.md documents the deploy conventions and host proof', () => {
  const deployment = read('docs/deployment.md');
  for (const expected of [
    'tests/deploy/',
    '`Dockerfile`',
    '`compose.yaml`',
    'docs/deployment.md',
    'scripts/integration-smoke.sh',
    'test.integration',
    '## Host proof (test.integration)',
    'onehr-proof',
    'SMOKE_WAIT_S',
    'reports/integration-smoke.txt',
    'POST /api/forms',
  ]) {
    assert.ok(
      deployment.includes(expected),
      `docs/deployment.md must mention ${expected}`,
    );
  }
});
