import { v4 as uuidv4 } from 'uuid';
import { FORM_DEFINITION_SCHEMA_VERSION, migrateCanonicalFormToV1 } from 'core';
import prisma from '../db/prisma';
import { HttpError } from '../middleware/errorHandler';
import { findLatestPublishedVersion, formLineageId, FormLineageId, FormVersionId } from './formIdentity';
import {
  assertCompositionDependencies,
  compileDefinitionScripts,
  prepareConnectors,
} from './formDefinitionPreparation';

/**
 * Increment version logic: "0.1.0-draft" -> "1.0.0". Every fresh form is
 * seeded at "0.1.0-draft" (major 0, minor 1) - a first-ever publish must
 * land on "1.0.0", not carry the seed minor through. Re-drafts of an
 * already-published form (via nextDraftVersion) start from major >= 1
 * instead, so that branch's minor/patch already encode the real next
 * version and must pass through unchanged.
 */
export function nextPublishedVersion(currentVersion: string): string {
  const match = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return '1.0.0';
  return match[1] === '0' ? '1.0.0' : `${match[1]}.${match[2]}.${match[3]}`;
}

/**
 * QA review finding: create-draft and restore used to each hand-roll their
 * own "what draft version comes next" logic, and disagreed - create-draft
 * only looked at the ONE form being drafted from (`match[2] + 1`), while
 * restore correctly scanned every sibling under the same parent_id for the
 * true max major.minor across the whole lineage. Creating two drafts from
 * the same published version (without publishing between) used to produce
 * two forms both labeled e.g. "1.1.0-draft" - a real version-string
 * collision. One shared implementation (restore's, the more careful one)
 * instead of two that can drift apart again.
 */
export async function nextDraftVersion(parentId: string): Promise<string> {
  const siblings = await prisma.form.findMany({ where: { parent_id: parentId } });
  let maxMajor = 0;
  let maxMinor = 0;
  for (const sibling of siblings) {
    const match = sibling.version.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match) continue;
    const major = parseInt(match[1], 10);
    const minor = parseInt(match[2], 10);
    if (major > maxMajor) { maxMajor = major; maxMinor = minor; }
    else if (major === maxMajor && minor > maxMinor) { maxMinor = minor; }
  }
  return `${maxMajor}.${maxMinor + 1}.0-draft`;
}

/** Publishes one version and archives the previously published sibling of the same lineage. */
export async function publishFormVersion(formId: FormVersionId) {
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  if (form.status === 'published') throw new HttpError(400, 'Form is already published');

  const newVersion = nextPublishedVersion(form.version);

  const canonicalForm = prepareConnectors(migrateCanonicalFormToV1({
    ...(form.canonical_json as any),
    schemaVersion: (form.canonical_json as any).schemaVersion || FORM_DEFINITION_SCHEMA_VERSION,
    revision: ((form.canonical_json as any).revision ?? 0) + 1,
    extensions: (form.canonical_json as any).extensions || {},
    version: newVersion,
    status: 'published',
  }, formId));
  await assertCompositionDependencies(canonicalForm, formId);
  const compiledDefinition = compileDefinitionScripts(canonicalForm);
  const parentId = formLineageId(form);
  // At most one published version per form identity is the invariant every
  // consumer of `status` already assumes (latest-published lookups, the
  // "published" filter on the form list) - archiving is otherwise a
  // separate manual action, easy to forget, which silently produced two
  // simultaneously "published" versions of the same form with no way for a
  // filter-by-status caller to tell which one is actually current. Publish
  // and supersede as one atomic step instead of trusting a follow-up click.
  const supersededSiblings = await prisma.form.findMany({
    where: { parent_id: parentId, status: 'published', id: { not: formId } },
  });
  const [published] = await prisma.$transaction([
    prisma.form.update({
      where: { id: formId },
      data: { status: 'published', version: newVersion, canonical_json: compiledDefinition as any },
    }),
    ...supersededSiblings.map((sibling) => prisma.form.update({
      where: { id: sibling.id },
      data: { status: 'archived', canonical_json: { ...(sibling.canonical_json as any), status: 'archived' } },
    })),
  ]);
  return published;
}

/** Creates a new draft version of the given form under the same lineage. */
export async function createDraftFromVersion(formId: FormVersionId) {
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');

  // create a new draft with incremented minor version
  const newId = uuidv4();
  const newVersion = await nextDraftVersion(formLineageId(form));

  const canonicalForm = { ...(form.canonical_json as any), id: newId, schemaVersion: (form.canonical_json as any).schemaVersion || FORM_DEFINITION_SCHEMA_VERSION, revision: 0, extensions: (form.canonical_json as any).extensions || {}, version: newVersion, status: 'draft' };
  return prisma.form.create({
    data: {
      id: newId,
      parent_id: formLineageId(form),
      name: form.name,
      version: newVersion,
      status: 'draft',
      canonical_json: canonicalForm
    }
  });
}

/** Restores any version as a fresh draft under the same lineage. */
export async function restoreVersionAsDraft(formId: FormVersionId) {
  const oldForm = await prisma.form.findUnique({ where: { id: formId } });
  if (!oldForm) throw new HttpError(404, 'Form not found');

  const parentId = formLineageId(oldForm);
  const newId = uuidv4();
  const newVersion = await nextDraftVersion(parentId);

  const canonicalForm = { ...(oldForm.canonical_json as any), id: newId, revision: 0, version: newVersion, status: 'draft' };
  return prisma.form.create({
    data: {
      id: newId,
      parent_id: parentId,
      name: oldForm.name,
      version: newVersion,
      status: 'draft',
      canonical_json: canonicalForm
    }
  });
}

/** Archives or deletes one version (the row and its stored definition's status). */
export async function setFormVersionStatus(formId: FormVersionId, status: 'archived' | 'deleted') {
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');

  const canonicalForm = { ...(form.canonical_json as any), status };
  return prisma.form.update({
    where: { id: formId },
    data: { status, canonical_json: canonicalForm }
  });
}

/** The newest published version of a lineage, migrated to the current definition schema. */
export async function getLatestPublishedVersion(lineageId: FormLineageId) {
  const latest = await findLatestPublishedVersion(lineageId);
  if (!latest) throw new HttpError(404, 'No active published form found');

  const canonicalForm = migrateCanonicalFormToV1({ ...(latest.canonical_json as any), id: latest.id }, latest.id);
  return { ...latest, canonical_json: canonicalForm };
}

/** All versions of a lineage, newest first, without their full definitions. */
export async function listLineageVersions(lineageId: FormLineageId) {
  return prisma.form.findMany({
    where: { parent_id: lineageId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, parent_id: true, name: true, version: true, status: true, createdAt: true, updatedAt: true }
  });
}
