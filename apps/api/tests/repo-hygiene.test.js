const assert = require('node:assert/strict');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

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

// Tracked = in the index AND on disk: a deletion the runner has not staged yet
// is already gone from disk, so the check holds before and after the commit.
function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
    .filter((file) => fs.existsSync(path.join(root, file)));
}

// --no-index tests the ignore rules themselves: git never reports a path that
// is still in the index as ignored.
function isIgnored(file) {
  try {
    execFileSync('git', ['check-ignore', '-q', '--no-index', file], { cwd: root, stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function lines(file) {
  return fs.readFileSync(path.join(root, file), 'utf8').split(/\r?\n/).map((line) => line.trim());
}

test('no runtime config.json or .env file is tracked', { skip: skipGit }, () => {
  const offending = trackedFiles().filter((file) => {
    const base = path.posix.basename(file);
    return /(^|\/)\.?data\/config\.json$/.test(file)
      || (/^\.env(\..+)?$/.test(base) && base !== '.env.example');
  });
  assert.deepEqual(offending, []);
});

test('runtime config and env files are git-ignored, examples are not', { skip: skipGit }, () => {
  for (const file of ['apps/data/config.json', '.data/config.json', 'data/config.json', 'apps/api/.env']) {
    assert.equal(isIgnored(file), true, `${file} must be ignored`);
  }
  for (const file of ['apps/data/config.example.json', 'apps/api/.env.example']) {
    assert.equal(isIgnored(file), false, `${file} must stay trackable`);
  }
});

test('.gitignore ignores .data by file pattern, not the directory', () => {
  const gitignore = lines('.gitignore');
  assert.ok(gitignore.includes('/.data/*'), '.gitignore must contain /.data/*');
  assert.ok(gitignore.includes('**/data/config.json'), '.gitignore must contain **/data/config.json');
  for (const dirPattern of ['/.data/', '.data/', '/.data', '.data']) {
    assert.ok(!gitignore.includes(dirPattern), `.gitignore must not contain ${dirPattern}`);
  }
});

test('.dockerignore keeps runtime config, env files and keys out of build contexts', () => {
  const dockerignore = lines('.dockerignore');
  for (const entry of ['**/data/config.json', '**/.data', '**/.env', '**/.env.*', '!**/.env.example', '**/*.pem', '**/*.key']) {
    assert.ok(dockerignore.includes(entry), `.dockerignore is missing ${entry}`);
  }
});
