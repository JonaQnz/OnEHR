import prisma from '../db/prisma';
import { HttpError } from '../middleware/errorHandler';
import type { CompositionVersion, FormSessionValues, SemanticDiff } from 'core';
import { isFormSessionChangeType, migrateCanonicalFormToV1 } from 'core';
import { compareRuntimeValues, fromOpenEhrFlatComposition } from 'openehr-engine';
import { getRemoteWebTemplate } from './ehrbaseService';
import { getCompositionRepository } from './compositionRepository';
import { resolveFormSessionHistoryContext, type SessionActor } from './formSessionService';

/**
 * Overlays a CDR-sourced CompositionVersion with the local, honest record of
 * what Forms itself intended for that exact version (see
 * CompositionVersionEvent) - never the other way around. Everything the CDR
 * *does* reliably report (version existence/order/timestamp/committer/
 * contribution/creation-vs-modification) is left untouched; only the two
 * fields confirmed (live) NOT to survive into this CDR's real audit trail
 * (lifecycle_state, and the modification-vs-amendment distinction) are
 * upgraded when we have our own record of the save that produced them.
 */
export function enrichVersionWithLocalEvent(version: CompositionVersion, event?: { lifecycleState: string; changeType?: string | null; changeDescription?: string | null } | undefined): CompositionVersion {
  if (!event) return version;
  const changeType = isFormSessionChangeType(event.changeType) ? event.changeType : version.changeType;
  return {
    ...version,
    lifecycleState: (event.lifecycleState as CompositionVersion['lifecycleState']) || version.lifecycleState,
    lifecycleConfirmed: true,
    changeType,
    changeTypeConfirmed: true,
    changeDescription: event.changeDescription || version.changeDescription,
  };
}

async function enrichAll(versions: CompositionVersion[]): Promise<CompositionVersion[]> {
  if (versions.length === 0) return versions;
  const events = await prisma.compositionVersionEvent.findMany({
    where: { versionUid: { in: versions.map((version) => version.versionUid) } },
  });
  const byVersionUid = new Map(events.map((event) => [event.versionUid, event]));
  return versions.map((version) => enrichVersionWithLocalEvent(version, byVersionUid.get(version.versionUid)));
}

function sortByVersionNumberDesc(versions: CompositionVersion[]): CompositionVersion[] {
  return [...versions].sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));
}

export async function getCompositionHistory(sessionId: string, actor: SessionActor): Promise<CompositionVersion[]> {
  const resolved = await resolveFormSessionHistoryContext(sessionId, actor);
  if (!resolved.compositionUid) return [];
  const repository = getCompositionRepository(resolved.providerId);
  if (!repository) throw new HttpError(501, `Provider '${resolved.providerId}' does not support version history`, { code: 'HISTORY_NOT_SUPPORTED' });
  try {
    const versions = await repository.getVersionHistory(resolved.context, resolved.compositionUid);
    return sortByVersionNumberDesc(await enrichAll(versions));
  } catch (error) {
    throw new HttpError(502, 'Composition-Historie konnte nicht geladen werden.', { code: 'HISTORY_LOAD_FAILED' });
  }
}

export interface VersionDetail {
  version: CompositionVersion;
  values: FormSessionValues;
}

export async function getCompositionVersionDetail(sessionId: string, versionUid: string, actor: SessionActor): Promise<VersionDetail> {
  const resolved = await resolveFormSessionHistoryContext(sessionId, actor);
  const repository = getCompositionRepository(resolved.providerId);
  if (!repository) throw new HttpError(501, `Provider '${resolved.providerId}' does not support version history`, { code: 'HISTORY_NOT_SUPPORTED' });
  const form = await prisma.form.findUnique({ where: { id: resolved.session.formId } });
  if (!form) throw new HttpError(404, 'Form definition not found');
  const definition = migrateCanonicalFormToV1({ ...(form.canonical_json as any), id: form.id }, form.id);
  let content;
  try {
    content = await repository.getVersionContent(resolved.context, versionUid);
  } catch (error) {
    throw new HttpError(502, 'Version konnte nicht geladen werden.', { code: 'HISTORY_VERSION_LOAD_FAILED' });
  }
  if (!content) throw new HttpError(404, 'Version not found');
  const templateId = (definition as any).sourceTemplates?.[0]?.id as string | undefined;
  const webTemplateTree = templateId ? await getRemoteWebTemplate(templateId).then((wt) => wt?.tree).catch(() => undefined) : undefined;
  const [enriched] = await enrichAll([content.version]);
  const values = fromOpenEhrFlatComposition(definition as any, content.flat, webTemplateTree);
  return { version: enriched, values };
}

export interface CompositionVersionCompareResult {
  from: VersionDetail;
  to: VersionDetail;
  diff: SemanticDiff;
}

/**
 * Both versions belong to the same session's form, so the same layout/
 * binding definition is used to enumerate fields on both sides - the actual
 * Semantic Diff is only ever computed here, on demand (§29 - never
 * precomputed for the whole history list), reusing compareRuntimeValues
 * (openehr-engine) directly on the two already-mapped RuntimeValues.
 */
export async function getCompositionVersionsForCompare(sessionId: string, fromVersionUid: string, toVersionUid: string, actor: SessionActor): Promise<CompositionVersionCompareResult> {
  const [from, to] = await Promise.all([
    getCompositionVersionDetail(sessionId, fromVersionUid, actor),
    getCompositionVersionDetail(sessionId, toVersionUid, actor),
  ]);
  const resolved = await resolveFormSessionHistoryContext(sessionId, actor);
  const form = await prisma.form.findUnique({ where: { id: resolved.session.formId } });
  if (!form) throw new HttpError(404, 'Form definition not found');
  const definition = migrateCanonicalFormToV1({ ...(form.canonical_json as any), id: form.id }, form.id);
  const diff = compareRuntimeValues(definition as any, from.values as any, to.values as any);
  return { from, to, diff };
}
