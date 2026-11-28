'use strict';

// Documentation command tests.
//
// Every command that the developer-facing docs tell someone to run must
// actually exist: compose files, scripts, script subcommands and npm
// scripts. The checks only read text files, so they work in a pipeline
// checkout without .git and without js-yaml.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

const DOCS = [
  'README.md',
  'docs/architecture/current-state.md',
  'docs/debug-ehrbase.md',
  'docs/testing/ehrbase-integration.md',
  'debug/ehrbase/templates/README.md',
  'docs/deployment.md',
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function exists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function workspacePackages() {
  const packages = [];
  for (const dir of ['apps', 'packages']) {
    const absolute = path.join(ROOT, dir);
    if (!fs.existsSync(absolute)) continue;
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = path.posix.join(dir, entry.name, 'package.json');
      if (!exists(relative)) continue;
      packages.push({ dir: path.posix.join(dir, entry.name), manifest: readJson(relative) });
    }
  }
  return packages;
}

function fencedBlocks(text) {
  const blocks = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('```')) {
      if (current === null) {
        current = [];
      } else {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    if (current !== null) current.push(line);
  }
  return blocks;
}

test('every docker compose -f file named in the docs exists', () => {
  for (const doc of DOCS) {
    for (const line of read(doc).split(/\r?\n/)) {
      if (!/\bdocker compose\b/.test(line)) continue;
      for (const match of line.matchAll(/(?:^|\s)-f\s+(\S+)/g)) {
        const file = match[1].replace(/^['"]|['"]$/g, '');
        assert.ok(exists(file), `${doc} references missing compose file ${file}`);
      }
    }
  }
});

test('every script named in the docs exists', () => {
  for (const doc of DOCS) {
    for (const match of read(doc).matchAll(/(?:\.\/|bash\s+)(scripts\/[\w./-]+)/g)) {
      const script = match[1];
      assert.ok(exists(script), `${doc} references missing script ${script}`);
    }
  }
});

test('every npm run script named in the docs exists', () => {
  const workspaces = workspacePackages();
  const rootManifest = readJson('package.json');

  for (const doc of DOCS) {
    for (const block of fencedBlocks(read(doc))) {
      let cwd = null;
      for (const line of block) {
        const cd = line.match(/^\s*cd\s+(\S+)\s*$/);
        if (cd) {
          if (cd[1] === '../..') cwd = null;
          else if (/^(apps|packages)\/[\w.-]+$/.test(cd[1])) cwd = cd[1];
          continue;
        }

        for (const match of line.matchAll(/\bnpm run ([\w:.-]+)/g)) {
          const script = match[1];
          const workspace = line.match(/--workspace=([\w.-]+)/);
          if (workspace) {
            const ws = workspace[1];
            const pkg = workspaces.find((candidate) => candidate.manifest.name === ws);
            assert.ok(pkg, `${doc} runs script ${script} in unknown workspace ${ws}`);
            assert.ok(
              pkg.manifest.scripts && pkg.manifest.scripts[script],
              `${doc} runs missing script ${script} in workspace ${ws}`,
            );
            continue;
          }

          if (cwd) {
            const pkg = workspaces.find((candidate) => candidate.dir === cwd);
            assert.ok(pkg, `${doc} runs a script in unknown directory ${cwd}`);
            assert.ok(
              pkg.manifest.scripts && pkg.manifest.scripts[script],
              `${doc} runs missing script ${script} in ${cwd}`,
            );
            continue;
          }

          assert.ok(
            rootManifest.scripts && rootManifest.scripts[script],
            `${doc} runs missing root script ${script}`,
          );
        }
      }
    }
  }
});

test('every debug-ehrbase.sh subcommand named in the docs exists', () => {
  const script = read('scripts/debug-ehrbase.sh');
  for (const doc of DOCS) {
    for (const match of read(doc).matchAll(/\.\/scripts\/debug-ehrbase\.sh\s+([\w-]+)/g)) {
      const subcommand = match[1];
      assert.ok(
        script.includes(`${subcommand})`),
        `${doc} uses unknown debug-ehrbase.sh subcommand ${subcommand}`,
      );
    }
  }
});

test('README uses the current commands', () => {
  const readme = read('README.md');
  assert.ok(!readme.includes('prisma migrate dev'), 'README must not document prisma migrate dev');
  assert.ok(!readme.includes('docker-compose up'), 'README must not document docker-compose up');
});

test('the product is named OnEHR, not WatEHR', () => {
  const files = [
    'README.md',
    'docs/architecture/current-state.md',
    'docs/architecture/target-state.md',
    'docs/architecture/migration-plan.md',
    'docs/integration/form-launch-v1.md',
  ];
  for (const file of files) {
    // The lowercase wire constant `watehr.form-launch.v1`
    // (packages/core/src/form-launch) is a protocol value and stays.
    assert.ok(!/WatEHR|WatEhr/.test(read(file)), `${file} must use the OnEHR name`);
  }
});

test('current-state.md documents the real CI workflow', () => {
  const currentState = read('docs/architecture/current-state.md');
  assert.ok(
    currentState.includes('.github/workflows/ci.yml'),
    'current-state.md must name .github/workflows/ci.yml',
  );
  assert.ok(
    !currentState.includes('No CI pipeline'),
    'current-state.md must not claim there is no CI pipeline',
  );
});
