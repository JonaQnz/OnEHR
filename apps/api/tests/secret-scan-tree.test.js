const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  scanText,
  scanTree,
  loadAllowlist,
  applyAllowlist,
} = require('../../../scripts/secret-scan');

const root = path.resolve(__dirname, '..', '..', '..');

function inGitCheckout() {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const skipGit = inGitCheckout() ? false : 'not a git checkout';

const allowlistFile = path.join(root, 'scripts', 'secret-scan-allowlist.json');
const docFile = path.join(root, 'docs', 'security', 'credential-audit.md');

// Findings are reported as path:line + rule only; values stay hidden.
function describe(findings) {
  return findings.map((finding) => `${finding.path}:${finding.line} ${finding.rule}`).join('\n');
}

test('no unclassified credential findings in the tracked tree', { skip: skipGit }, () => {
  const { remaining } = applyAllowlist(scanTree(root), loadAllowlist(allowlistFile));
  assert.equal(remaining.length, 0, `unclassified findings:\n${describe(remaining)}`);
});

test('allowlist entries are well formed and never cover runtime config', () => {
  const entries = loadAllowlist(allowlistFile);
  assert.ok(entries.length > 0, 'allowlist must not be empty');

  for (const entry of entries) {
    assert.ok(entry && typeof entry.path === 'string' && entry.path.trim(), `entry without path: ${JSON.stringify(entry && entry.path)}`);
    assert.ok(typeof entry.rule === 'string' && entry.rule.trim(), `entry without rule: ${entry.path}`);
    assert.ok(typeof entry.reason === 'string' && entry.reason.trim(), `entry without reason: ${entry.path}`);
    assert.ok(
      ['dev-default', 'test-fixture', 'doc-example'].includes(entry.class),
      `invalid class for ${entry.path}: ${entry.class}`,
    );

    assert.notEqual(entry.path, 'compose.yaml', 'compose.yaml deploys TEST/PROD and must not be allowlisted');
    assert.ok(!entry.path.startsWith('apps/data/'), `runtime config must not be allowlisted: ${entry.path}`);
    assert.ok(!entry.path.startsWith('.data/'), `runtime config must not be allowlisted: ${entry.path}`);
    assert.ok(!entry.path.includes('.env'), `env file must not be allowlisted: ${entry.path}`);
    assert.notEqual(
      entry.path,
      'docs/security/credential-audit.md',
      'the audit document must not allowlist itself',
    );
  }
});

test('the audit document and allowlist contain no credential findings', () => {
  for (const file of [docFile, allowlistFile]) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const findings = scanText(fs.readFileSync(file, 'utf8'), relative);
    assert.equal(findings.length, 0, `findings in ${relative}:\n${describe(findings)}`);
  }
});
