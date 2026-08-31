const assert = require('node:assert/strict');
const test = require('node:test');
const prisma = require('../dist/db/prisma').default;
const { nextDraftVersion } = require('../dist/routes/formRoutes');

// QA review finding: create-draft and restore used to each hand-roll their
// own "what draft version comes next" logic and had already drifted apart
// - create-draft only looked at the ONE form being drafted from, while
// restore correctly scanned every sibling under the same parent_id for the
// true max major.minor across the whole lineage. Creating two drafts from
// the same published version (without publishing between) used to produce
// two forms both labeled e.g. "1.1.0-draft" - a real version-string
// collision. Both routes now share this one implementation.

function withForms(versions, fn) {
  const original = prisma.form.findMany;
  prisma.form.findMany = async () => versions.map((version) => ({ version }));
  return fn().finally(() => { prisma.form.findMany = original; });
}

test('bumps the minor version of the highest version among all siblings, not just the source form', async () => {
  // The exact repro: drafting from an old published version (1.0.0) while a
  // newer draft (1.2.0-draft) already exists under the same lineage must
  // not produce a collision with - or a version lower than - that draft.
  await withForms(['1.0.0', '1.2.0-draft'], async () => {
    assert.equal(await nextDraftVersion('parent-1'), '1.3.0-draft');
  });
});

test('two drafts created from the same published version in a row never collide', async () => {
  // First draft: only "1.0.0" exists yet.
  const firstVersion = await withForms(['1.0.0'], () => nextDraftVersion('parent-1'));
  assert.equal(firstVersion, '1.1.0-draft');
  // Second draft, created before the first was published: the first draft
  // now exists as a sibling too, so the second must bump past it, not
  // repeat "1.1.0-draft".
  const secondVersion = await withForms(['1.0.0', firstVersion], () => nextDraftVersion('parent-1'));
  assert.equal(secondVersion, '1.2.0-draft');
  assert.notEqual(secondVersion, firstVersion);
});

test('a higher major version wins over a higher minor on a lower major', async () => {
  await withForms(['1.5.0', '2.0.0'], async () => {
    assert.equal(await nextDraftVersion('parent-1'), '2.1.0-draft');
  });
});

test('a lineage with no version-like strings at all falls back to 0.1.0-draft', async () => {
  await withForms([], async () => {
    assert.equal(await nextDraftVersion('parent-1'), '0.1.0-draft');
  });
});
