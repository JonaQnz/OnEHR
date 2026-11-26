'use strict';

// API build contract tests.
//
// These guard the one build step that the repository layout breaks:
// @prisma/client's postinstall only looks for a schema at the install
// root, but this repo keeps it at apps/api/prisma/schema.prisma. Without
// an explicit `prisma generate` the api's tsc fails with errors such as
// "has no exported member 'ApplicationRole'" (TEST pipeline #329).
//
// The files are read straight from the repository root, so a build script
// that drops the generate step fails here before the pipeline does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('api build generates the Prisma client before compiling', () => {
  const build = JSON.parse(read('apps/api/package.json')).scripts.build;

  const generateAt = build.indexOf('prisma generate');
  const tscAt = build.indexOf('tsc');

  assert.ok(
    build.includes('prisma generate --schema=prisma/schema.prisma'),
    `api build must generate the Prisma client from its own schema, got: ${build}`
  );
  assert.ok(tscAt !== -1, `api build must run tsc, got: ${build}`);
  assert.ok(
    generateAt < tscAt,
    `api build must generate Prisma before tsc, got: ${build}`
  );
});

test('the schema the api build points at exists', () => {
  assert.ok(
    fs.existsSync(path.join(ROOT, 'apps', 'api', 'prisma', 'schema.prisma')),
    'apps/api/prisma/schema.prisma must exist'
  );
});
