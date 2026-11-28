import type { Form } from '@prisma/client';
import prisma from '../db/prisma';

/** Stable id of a form's version lineage: parent_id, or the row's own id for a lineage root. */
export type FormLineageId = string;
/** Row id of one concrete form version (draft/published/archived). */
export type FormVersionId = string;
/** openEHR composition UID without '::system::version' (from a version UID or reference). */
export type CompositionUid = string;

/**
 * The lineage anchor a version belongs to: `parent_id` for a version row, or
 * the row's own id for a lineage root (drafts/published copies all point at
 * that root through `parent_id`).
 */
export function formLineageId(form: { id: string; parent_id: string | null }): FormLineageId {
  return form.parent_id || form.id;
}

/** Newest published row under a lineage, or null when nothing is published there yet. */
export async function findLatestPublishedVersion(lineageId: FormLineageId): Promise<Form | null> {
  return prisma.form.findFirst({
    where: { parent_id: lineageId, status: 'published' },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * The published version to actually run: a published form is already it,
 * anything else (draft/archived) resolves to the newest published sibling.
 */
export async function resolvePublishedVersion<T extends { id: string; parent_id: string | null; status: string }>(
  form: T,
): Promise<T | Form | null> {
  if (form.status === 'published') return form;
  return findLatestPublishedVersion(formLineageId(form));
}

/** Composition UID of a version UID or reference, i.e. without the `::system::version` suffix. */
export function compositionUidFromReference(reference: string | null | undefined): CompositionUid | undefined {
  if (!reference) return undefined;
  const last = reference.includes('/') ? reference.split('/').pop() : reference;
  return last ? last.split('::')[0] : undefined;
}
