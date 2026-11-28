'use strict';

// Local compose layout tests.
//
// The debug EHRbase stack lives in docker-compose.ehrbase-test.yml only; the
// debug overlay adds the template importer and switches the api over to that
// stack. scripts/debug-ehrbase.sh combines all three files. These tests keep
// that layout, the published host ports and the remaining Dockerfiles intact.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');

const COMPOSE_FILES = [
  'docker-compose.yml',
  'docker-compose.ehrbase-test.yml',
  'docker-compose.debug-ehrbase.yml',
];

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadYaml(relativePath) {
  return yaml.load(read(relativePath));
}

function servicesOf(relativePath) {
  const compose = loadYaml(relativePath) || {};
  return compose.services || {};
}

function hostPort(entry) {
  if (typeof entry === 'number') return String(entry);
  if (entry && typeof entry === 'object' && entry.published !== undefined) {
    return String(entry.published);
  }
  const spec = String(entry).split('/')[0];
  const parts = spec.split(':');
  return parts.length === 1 ? parts[0] : parts[parts.length - 2];
}

test('debug script uses only existing compose files and keeps its subcommands', () => {
  const script = read('scripts/debug-ehrbase.sh');
  const files = [...script.matchAll(/-f\s+(\S+)/g)].map((match) => match[1].replace(/["']/g, ''));

  assert.deepEqual(files, COMPOSE_FILES);
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} must exist`);
  }

  for (const subcommand of ['on', 'off', 'import', 'reset']) {
    assert.match(script, new RegExp(`^\\s*${subcommand}\\)`, 'm'), `script must handle ${subcommand}`);
  }
});

test('the EHRbase image is defined by exactly one service, in the test stack', () => {
  const matches = [];
  for (const file of COMPOSE_FILES) {
    for (const [name, service] of Object.entries(servicesOf(file))) {
      if (typeof service.image === 'string' && service.image.startsWith('ehrbase/ehrbase:')) {
        matches.push({ file, name });
      }
    }
  }

  assert.deepEqual(matches, [{ file: 'docker-compose.ehrbase-test.yml', name: 'ehrbase-test' }]);
});

test('the merged stacks publish no duplicate host port', () => {
  const merged = {};
  for (const file of COMPOSE_FILES) {
    for (const [name, service] of Object.entries(servicesOf(file))) {
      merged[name] = { ...(merged[name] || {}), ...service };
    }
  }

  const seen = new Map();
  for (const [name, service] of Object.entries(merged)) {
    for (const entry of service.ports || []) {
      const port = hostPort(entry);
      assert.ok(!seen.has(port), `host port ${port} is published by ${seen.get(port)} and ${name}`);
      seen.set(port, name);
    }
  }
});

test('the debug overlay points at services of the test stack', () => {
  const testServices = Object.keys(servicesOf('docker-compose.ehrbase-test.yml'));
  const overlayApi = servicesOf('docker-compose.debug-ehrbase.yml').api || {};

  const debugUrl = overlayApi.environment && overlayApi.environment.DEBUG_EHRBASE_URL;
  assert.equal(typeof debugUrl, 'string', 'overlay api sets DEBUG_EHRBASE_URL');
  assert.ok(
    testServices.includes(new URL(debugUrl).hostname),
    `${debugUrl} must point at a service of docker-compose.ehrbase-test.yml`,
  );

  const importScript = read('debug/ehrbase/import-templates.sh');
  const baseUrl = importScript.match(/base_url="https?:\/\/([^/:"]+)/);
  assert.ok(baseUrl, 'import script sets base_url');
  assert.ok(
    testServices.includes(baseUrl[1]),
    `${baseUrl[1]} must point at a service of docker-compose.ehrbase-test.yml`,
  );
});

test('the debug overlay defines no profiles', () => {
  for (const [name, service] of Object.entries(servicesOf('docker-compose.debug-ehrbase.yml'))) {
    assert.equal(service.profiles, undefined, `${name} must not define profiles`);
  }
});

test('Dockerfile.web is gone and Dockerfile.api is the api build file', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'Dockerfile.web')), false, 'Dockerfile.web must be removed');
  assert.equal(fs.existsSync(path.join(ROOT, 'Dockerfile.api')), true, 'Dockerfile.api must exist');

  const api = servicesOf('docker-compose.yml').api || {};
  assert.equal((api.build || {}).dockerfile, 'Dockerfile.api');
});
