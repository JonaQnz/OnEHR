const assert = require('node:assert/strict');
const test = require('node:test');
const prisma = require('../dist/db/prisma').default;
const {
  compositionUidFromReference,
  findLatestPublishedVersion,
  formLineageId,
  resolvePublishedVersion,
} = require('../dist/services/formIdentity');

// A form's version lineage is "the lineage anchor plus every version
// published under it" (see formIdentity.ts). These tests pin the two rules
// the launch path depends on: which row is the lineage, and which row is the
// currently published one.

function withFindFirst(impl, fn) {
  const original = prisma.form.findFirst;
  prisma.form.findFirst = impl;
  return fn().finally(() => { prisma.form.findFirst = original; });
}

test('formLineageId is the parent id for a version row', () => {
  assert.equal(formLineageId({ id: 'version-2', parent_id: 'root-1' }), 'root-1');
});

test('formLineageId is the row id for a lineage root', () => {
  assert.equal(formLineageId({ id: 'root-1', parent_id: null }), 'root-1');
});

test('resolvePublishedVersion returns a published form unchanged without querying', async () => {
  const published = { id: 'published-1', parent_id: 'root-1', status: 'published' };
  let queries = 0;
  await withFindFirst(async () => { queries += 1; return null; }, async () => {
    assert.equal(await resolvePublishedVersion(published), published);
  });
  assert.equal(queries, 0);
});

test('an archived version resolves to the newest published sibling under its lineage', async () => {
  const archived = { id: 'version-1', parent_id: 'root-1', status: 'archived' };
  const newest = { id: 'version-3', parent_id: 'root-1', status: 'published' };
  const calls = [];
  await withFindFirst(async (args) => { calls.push(args); return newest; }, async () => {
    assert.equal(await resolvePublishedVersion(archived), newest);
  });
  assert.deepEqual(calls, [{
    where: { parent_id: 'root-1', status: 'published' },
    orderBy: { createdAt: 'desc' },
  }]);
});

test('a lineage root resolves to its newest published sibling under its own id', async () => {
  const root = { id: 'root-1', parent_id: null, status: 'draft' };
  const published = { id: 'version-1', parent_id: 'root-1', status: 'published' };
  const calls = [];
  await withFindFirst(async (args) => { calls.push(args); return published; }, async () => {
    assert.equal(await resolvePublishedVersion(root), published);
  });
  assert.deepEqual(calls[0].where, { parent_id: 'root-1', status: 'published' });
});

test('resolvePublishedVersion is null when no sibling is published', async () => {
  await withFindFirst(async () => null, async () => {
    assert.equal(await resolvePublishedVersion({ id: 'version-1', parent_id: 'root-1', status: 'archived' }), null);
  });
});

test('findLatestPublishedVersion returns the row it finds', async () => {
  const published = { id: 'version-3', parent_id: 'root-1', status: 'published' };
  await withFindFirst(async () => published, async () => {
    assert.equal(await findLatestPublishedVersion('root-1'), published);
  });
});

test('compositionUidFromReference strips the version suffix from a version uid', () => {
  assert.equal(compositionUidFromReference('8849182c-82ad-4088-a07f-48ead4180515::local::2'), '8849182c-82ad-4088-a07f-48ead4180515');
});

test('compositionUidFromReference strips the path and version suffix from a reference', () => {
  assert.equal(compositionUidFromReference('ehr/1234/composition/8849182c-82ad-4088-a07f-48ead4180515::local::1'), '8849182c-82ad-4088-a07f-48ead4180515');
});

test('compositionUidFromReference returns a bare uuid as-is', () => {
  assert.equal(compositionUidFromReference('8849182c-82ad-4088-a07f-48ead4180515'), '8849182c-82ad-4088-a07f-48ead4180515');
});

test('compositionUidFromReference is undefined for an absent or empty reference', () => {
  assert.equal(compositionUidFromReference(null), undefined);
  assert.equal(compositionUidFromReference(undefined), undefined);
  assert.equal(compositionUidFromReference(''), undefined);
});
