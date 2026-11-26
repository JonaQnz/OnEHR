'use strict';

// Deployment contract tests.
//
// These mirror the platform's compose policy checks
// (ai-dev-studio/src/aidhub/cicd.py:130-153) and the webapp contract
// requirements. They read the deploy files straight from the repository
// root, so a change that would be rejected by the platform fails here
// first.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function loadYaml(relativePath) {
  return yaml.load(read(relativePath));
}

const FORBIDDEN_SERVICE_KEYS = [
  'privileged',
  'cap_add',
  'devices',
  'security_opt',
  'network_mode',
  'pid',
  'ipc',
];

test('compose.yaml: services are unprivileged', () => {
  const compose = loadYaml('compose.yaml');
  const services = compose.services || {};
  assert.ok(Object.keys(services).length > 0, 'compose.yaml defines services');

  for (const [name, service] of Object.entries(services)) {
    for (const key of FORBIDDEN_SERVICE_KEYS) {
      assert.ok(
        service[key] === undefined,
        `service "${name}" must not set ${key}`,
      );
    }
  }
});

test('compose.yaml: every volume is a named volume declared at the top level', () => {
  const compose = loadYaml('compose.yaml');
  const declared = compose.volumes || {};

  for (const [name, service] of Object.entries(compose.services || {})) {
    for (const entry of service.volumes || []) {
      const source = String(entry).split(':')[0];
      assert.ok(
        String(entry).includes(':'),
        `service "${name}" volume "${entry}" must use name:/path form`,
      );
      assert.ok(
        !source.startsWith('.') &&
          !source.startsWith('/') &&
          !source.startsWith('~') &&
          !source.startsWith('$'),
        `service "${name}" volume "${entry}" must not be a host path or variable`,
      );
      assert.ok(
        !source.includes('docker.sock'),
        `service "${name}" volume "${entry}" must not mount the docker socket`,
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(declared, source),
        `service "${name}" volume source "${source}" must be declared under top-level volumes`,
      );
    }
  }
});

test('compose.yaml: only app publishes a loopback port', () => {
  const compose = loadYaml('compose.yaml');
  const services = compose.services || {};

  for (const [name, service] of Object.entries(services)) {
    const ports = service.ports || [];
    if (name === 'app') {
      assert.ok(ports.length > 0, 'service "app" publishes a port');
    } else {
      assert.equal(ports.length, 0, `service "${name}" must not publish ports`);
    }

    for (const port of ports) {
      assert.ok(
        String(port).startsWith('127.0.0.1:${HOST_PORT'),
        `service "${name}" port "${port}" must be loopback-only and bound to HOST_PORT`,
      );
    }
  }

  assert.ok(services.db, 'compose.yaml defines a db service');
  assert.equal(services.db.ports, undefined, 'db must not publish ports');
});

test('project.yaml: valid webapp contract with TEST and PROD environments', () => {
  const contract = loadYaml('project.yaml');

  assert.equal(contract.type, 'webapp');
  assert.equal(contract.healthcheck.path, '/api/health/ready');
  assert.equal(contract.healthcheck.expect_status, 200);
  assert.equal(contract.environments.test.port, 18114);
  assert.equal(contract.environments.production.port, 18115);
  assert.equal(contract.environments.production.requires_approval, true);
  assert.notEqual(
    contract.environments.test.compose_project,
    contract.environments.production.compose_project,
  );
  assert.equal(contract.deploy.compose_file, 'compose.yaml');
});

test('Dockerfile: single image builds web assets and reports APP_VERSION', () => {
  const dockerfile = read('Dockerfile');

  assert.match(dockerfile, /ARG APP_VERSION/);
  assert.match(dockerfile, /VITE_API_URL=\//);
  assert.match(dockerfile, /WEB_DIST_DIR=\/app\/apps\/web\/dist/);
  assert.match(dockerfile, /prisma db push/);
  assert.doesNotMatch(dockerfile, /accept-data-loss/);
});

test('compose.yaml: no admin password literal', () => {
  const compose = read('compose.yaml');
  const matches = compose.match(/FORMS_BOOTSTRAP_ADMIN_PASSWORD:[^\n]*/g) || [];
  assert.ok(matches.length > 0, 'compose.yaml wires FORMS_BOOTSTRAP_ADMIN_PASSWORD');

  for (const line of matches) {
    assert.equal(
      line.trim(),
      'FORMS_BOOTSTRAP_ADMIN_PASSWORD: ${FORMS_BOOTSTRAP_ADMIN_PASSWORD:-}',
    );
  }
});
