import prisma from '../db/prisma';
import { getCompositionDefinition, isFormRuntimeMode, summarizeCompositionSession, type FormRuntimeMode } from 'core';
import { getOpenEhrFormOptions } from 'openehr-engine';
import { HttpError } from '../middleware/errorHandler';
import { formsShareLineage, getFormSession, validateFormSession, type SessionActor } from './formSessionService';
import { resolvePatientReference } from './patientService';
import { getConfig, resolveSessionAlwaysNew } from './configService';

export type CompositionSessionActor = SessionActor;
type ChildMap = Record<string, string>;
type ChildGroupMap = Record<string, string[]>;
type ChildSummary = { blockId: string; sessionId?: string; formId: string; status: string; valid?: boolean; issues?: Array<{ path: string; code: string; message: string }>; manualAdd?: boolean; instanceIndex?: number };
type ExpectedChild = { blockId: string; formId: string; manualAdd: boolean; requireAtLeastOne: boolean };

export interface PublicCompositionSession {
  id: string;
  compositionFormId: string;
  compositionVersion: string;
  patientId: string;
  patientNamespace?: string;
  ehrId?: string;
  mode: FormRuntimeMode;
  status: 'draft' | 'in_progress' | 'ready' | 'submitted' | 'failed' | 'cancelled';
  childSessions: Record<string, string>;
  /** Instance lists for manualAdd blocks only - see childSessionGroups on
   * the CompositionSession model. Always present (possibly {}) so callers
   * never have to special-case its absence. */
  childSessionGroups: Record<string, string[]>;
  children: ChildSummary[];
  progress: { total: number; started: number; ready: number; submitted: number };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function text(value: unknown, field: string): string { if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required`); return value.trim(); }
function isMap(value: unknown): value is ChildMap { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) && Object.values(value as Record<string, unknown>).every((id) => typeof id === 'string'); }
function isGroupMap(value: unknown): value is ChildGroupMap { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) && Object.values(value as Record<string, unknown>).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string')); }
function owner(record: { userId: string }, actor: CompositionSessionActor): void { if (record.userId !== actor.userId && actor.userId !== 'anonymous') throw new HttpError(403, 'You do not have access to this composition session'); }

async function compositionFor(id: string, publishedOnly = false) {
  const form = await prisma.form.findUnique({ where: { id } });
  if (!form) throw new HttpError(404, 'Composition not found');
  if (publishedOnly && form.status !== 'published') throw new HttpError(409, 'Only published compositions can be run');
  const definition = getCompositionDefinition((form.canonical_json as any).extensions || {});
  if (!definition) throw new HttpError(422, 'Form is not a Composition');
  const expected: ExpectedChild[] = definition.pages.flatMap((page) => page.blocks).filter((block) => block.type === 'form').map((block) => ({ blockId: block.id, formId: block.formId, manualAdd: block.manualAdd === true, requireAtLeastOne: block.requireAtLeastOne === true }));
  return { form, expected };
}

async function publicSession(record: any, actor: CompositionSessionActor): Promise<PublicCompositionSession> {
  const { expected } = await compositionFor(record.compositionFormId);
  const childSessions: ChildMap = isMap(record.childSessions) ? record.childSessions : {};
  const childSessionGroups: ChildGroupMap = isGroupMap(record.childSessionGroups) ? record.childSessionGroups : {};
  const ids: string[] = [...Object.values(childSessions), ...Object.values(childSessionGroups).flat()];
  const rows = ids.length ? await prisma.formSession.findMany({ where: { id: { in: ids } }, select: { id: true, formId: true, status: true, validation: true } }) : [];
  const summarize = (expectedChild: ExpectedChild, sessionId: string | undefined, instanceIndex?: number): ChildSummary => {
    const session = sessionId ? rows.find((row) => row.id === sessionId) : undefined;
    const issues = session && Array.isArray(session.validation) ? session.validation as any : [];
    // `valid: false` reads as "checked and found invalid" - only report it
    // once that's actually true. A freshly-attached or since-edited block
    // that simply hasn't been through validate_form_session/
    // validate_composition_session yet has neither a 'ready'/'submitted'
    // status nor any recorded issues, so `valid` is omitted entirely rather
    // than defaulting to false (which validate_composition_session already
    // correctly flips once it actually runs).
    const hasBeenAssessed = session ? (session.status === 'ready' || session.status === 'submitted' || issues.length > 0) : false;
    return {
      blockId: expectedChild.blockId,
      formId: expectedChild.formId,
      ...(sessionId ? { sessionId } : {}),
      status: session?.status || 'not_started',
      ...(session ? {
        ...(hasBeenAssessed ? { valid: session.status === 'ready' || session.status === 'submitted' } : {}),
        issues,
      } : {}),
      ...(expectedChild.manualAdd ? { manualAdd: true } : {}),
      ...(instanceIndex !== undefined ? { instanceIndex } : {}),
    };
  };
  const children = expected.flatMap((expectedChild): ChildSummary[] => {
    if (!expectedChild.manualAdd) return [summarize(expectedChild, childSessions[expectedChild.blockId])];
    const instanceIds = childSessionGroups[expectedChild.blockId] || [];
    if (instanceIds.length === 0) {
      // A manualAdd block the clinician hasn't touched at all contributes
      // nothing to progress unless the designer explicitly required at
      // least one instance - matching "nicht verpflichtend, außer explizit
      // konfiguriert". When required, a synthetic not-started entry (no
      // sessionId) keeps it visible in the progress panel and blocks
      // validateCompositionSession until an instance actually exists.
      return expectedChild.requireAtLeastOne ? [summarize(expectedChild, undefined)] : [];
    }
    return instanceIds.map((sessionId: string, index: number) => summarize(expectedChild, sessionId, index + 1));
  });
  const { progress, status: nextStatus } = summarizeCompositionSession(children);
  const persisted = record.status === nextStatus ? record : await prisma.compositionSession.update({ where: { id: record.id }, data: { status: nextStatus, revision: { increment: 1 } } });
  return { id: persisted.id, compositionFormId: persisted.compositionFormId, compositionVersion: persisted.compositionVersion, patientId: persisted.patientId, ...(persisted.patientNamespace ? { patientNamespace: persisted.patientNamespace } : {}), ...(persisted.ehrId ? { ehrId: persisted.ehrId } : {}), mode: persisted.mode as FormRuntimeMode, status: persisted.status, childSessions, childSessionGroups, children, progress, revision: persisted.revision, createdAt: persisted.createdAt.toISOString(), updatedAt: persisted.updatedAt.toISOString() };
}

export async function startCompositionSession(input: { compositionFormId: string; patientId: string; patientNamespace?: string; ehrId?: string; mode?: FormRuntimeMode; forceNew?: boolean }, actor: CompositionSessionActor): Promise<PublicCompositionSession> {
  const compositionFormId = text(input.compositionFormId, 'compositionFormId');
  const requestedPatientId = text(input.patientId, 'patientId');
  const requestedNamespace = input.patientNamespace?.trim() || undefined;
  // Form launches canonicalize a local patient UUID/EHR id to the clinical
  // subject id. Composition sessions must use the exact same identity.
  const patient = await resolvePatientReference(requestedPatientId, requestedNamespace);
  const patientId = patient?.patientId || requestedPatientId;
  const patientNamespace = patient?.patientNamespace || requestedNamespace;
  const ehrId = patient?.ehrId || input.ehrId?.trim() || undefined;
  const mode = input.mode || 'create';
  if (!isFormRuntimeMode(mode)) throw new HttpError(400, 'mode must be create, edit, view, or prefill');
  const { form } = await compositionFor(compositionFormId, true);
  // A Composition authored with storageStrategy 'always_new' opts out of
  // resuming a still-open session entirely - e.g. a Composition that just
  // groups a handful of single-shot forms and is meant to be launched fresh
  // every time, as opposed to the default (and far more common) case of a
  // long-running clinical process that should always pick back up where it
  // left off. Same override forceNew already gives per-launch, as the
  // form's own default. Unset defers to the connection-wide
  // sessionReuseDefault (see resolveSessionAlwaysNew), itself defaulting to
  // 'reuse' - unchanged behavior for every Composition that sets nothing.
  const alwaysNew = resolveSessionAlwaysNew(getOpenEhrFormOptions(form.canonical_json as any).storageStrategy, getConfig().sessionReuseDefault);
  if (!input.forceNew && !alwaysNew) {
    const reusable = await prisma.compositionSession.findFirst({ where: { compositionFormId, patientId, patientNamespace: patientNamespace || null, userId: actor.userId, mode, status: { in: ['draft', 'in_progress', 'ready', 'failed'] } }, orderBy: { updatedAt: 'desc' } });
    if (reusable) return publicSession(reusable, actor);
  }
  const created = await prisma.compositionSession.create({ data: { compositionFormId, compositionVersion: form.version, patientId, patientNamespace: patientNamespace || null, ehrId: ehrId || null, userId: actor.userId, authMode: actor.authMode, mode, status: 'draft', childSessions: {} } });
  return publicSession(created, actor);
}

export async function getCompositionSessionsForPatient(patientId: string, actor: CompositionSessionActor): Promise<PublicCompositionSession[]> {
  const patient = text(patientId, 'patientId');
  const records = await prisma.compositionSession.findMany({
    where: {
      patientId: patient,
      userId: actor.userId === 'anonymous' ? undefined : actor.userId,
    },
    orderBy: { createdAt: 'desc' },
  });
  const results = await Promise.allSettled(records.map(r => publicSession(r, actor)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') console.warn(`[compositionSessionService] Dropping composition session ${records[index]?.id} from patient ${patient}'s list - it failed to resolve:`, result.reason instanceof Error ? result.reason.message : result.reason);
  });
  return results.filter((r): r is PromiseFulfilledResult<PublicCompositionSession> => r.status === 'fulfilled').map(r => r.value);
}

export async function getCompositionSession(id: string, actor: CompositionSessionActor): Promise<PublicCompositionSession> {
  const record = await prisma.compositionSession.findUnique({ where: { id: text(id, 'id') } });
  if (!record) throw new HttpError(404, 'Composition session not found'); owner(record, actor); return publicSession(record, actor);
}

export async function attachCompositionChild(id: string, blockId: string, childSessionId: string, actor: CompositionSessionActor, options: { asNewInstance?: boolean } = {}): Promise<PublicCompositionSession> {
  const record = await prisma.compositionSession.findUnique({ where: { id: text(id, 'id') } });
  if (!record) throw new HttpError(404, 'Composition session not found'); owner(record, actor);
  const { expected } = await compositionFor(record.compositionFormId);
  const expectedChild = expected.find((item) => item.blockId === text(blockId, 'blockId'));
  if (!expectedChild) throw new HttpError(404, 'Composition form block not found');
  const asNewInstance = options.asNewInstance === true;
  if (asNewInstance && !expectedChild.manualAdd) throw new HttpError(422, `Composition block '${expectedChild.blockId}' does not allow multiple instances`);
  // A manualAdd block is never auto-attached through the ordinary 1:1 path -
  // it only ever grows through the explicit "+ instance" flow below, so a
  // plain (non-asNewInstance) attach against one is a caller bug, not a
  // legitimate resume.
  if (!asNewInstance && expectedChild.manualAdd) throw new HttpError(422, `Composition block '${expectedChild.blockId}' requires asNewInstance - use POST .../instances`);
  const child = await getFormSession(text(childSessionId, 'childSessionId'), actor);
  const parentPatient = await resolvePatientReference(record.patientId, record.patientNamespace || undefined);
  const canonicalParentId = parentPatient?.patientId || record.patientId;
  // expectedChild.formId is a snapshot from whenever this Composition's
  // block was authored - a Form Section republish (create_form_draft/
  // publish_form) archives that exact row and mints a new one under the
  // same parent_id, so the child session (launched via launchForm's own
  // latest-published resolution) legitimately carries a different, newer
  // id for the very same Form Section. See formsShareLineage's doc comment.
  if (!(await formsShareLineage(child.formId, expectedChild.formId)) || child.patientId !== canonicalParentId) {
    throw new HttpError(422, 'Child form session does not match this composition context');
  }
  const patientFields = { patientId: canonicalParentId, patientNamespace: parentPatient?.patientNamespace || record.patientNamespace, ehrId: parentPatient?.ehrId || record.ehrId };
  // Optimistic concurrency, same pattern as formSessionService.patchFormSession:
  // this is a read-modify-write on childSessions/childSessionGroups, so two
  // concurrent attach calls against the same parent (e.g. the same
  // Composition open in two tabs, or two blocks finishing their launch at
  // once) could otherwise silently drop one another's attachment. A
  // conditional update on revision - retried once against the now-current
  // record - closes that race without requiring the caller to know/send an
  // expected revision.
  const nextData = (base: { childSessions: unknown; childSessionGroups: unknown }) => {
    if (!asNewInstance) {
      const children = isMap(base.childSessions) ? base.childSessions : {};
      return { childSessions: { ...children, [expectedChild.blockId]: child.id } };
    }
    const groups = isGroupMap(base.childSessionGroups) ? base.childSessionGroups : {};
    const existing = groups[expectedChild.blockId] || [];
    if (existing.includes(child.id)) return { childSessionGroups: groups }; // already attached - no-op
    return { childSessionGroups: { ...groups, [expectedChild.blockId]: [...existing, child.id] } };
  };
  const updated = await prisma.compositionSession.updateMany({ where: { id: record.id, revision: record.revision }, data: { ...patientFields, ...nextData(record), status: 'in_progress', revision: { increment: 1 } } });
  if (updated.count === 0) {
    const fresh = await prisma.compositionSession.findUnique({ where: { id: record.id } });
    if (!fresh) throw new HttpError(404, 'Composition session not found');
    if (!asNewInstance) {
      const freshChildren = isMap(fresh.childSessions) ? fresh.childSessions : {};
      if (freshChildren[expectedChild.blockId] === child.id) return publicSession(fresh, actor); // another request already attached the same block/session - no-op
    } else {
      const freshGroups = isGroupMap(fresh.childSessionGroups) ? fresh.childSessionGroups : {};
      if ((freshGroups[expectedChild.blockId] || []).includes(child.id)) return publicSession(fresh, actor);
    }
    const retried = await prisma.compositionSession.update({ where: { id: record.id }, data: { patientId: canonicalParentId, patientNamespace: parentPatient?.patientNamespace || fresh.patientNamespace, ehrId: parentPatient?.ehrId || fresh.ehrId, ...nextData(fresh), status: 'in_progress', revision: { increment: 1 } } });
    return publicSession(retried, actor);
  }
  const fresh = await prisma.compositionSession.findUnique({ where: { id: record.id } });
  if (!fresh) throw new HttpError(404, 'Composition session not found');
  return publicSession(fresh, actor);
}

/**
 * Detaches one instance of a manualAdd block - metadata-only, never deletes
 * the underlying FormSession row (harmless to leave orphaned; a future
 * cleanup pass could sweep those, out of scope here). Refuses to detach an
 * already-submitted instance - once real clinical data has been saved for
 * it, removing it from the composition would silently hide, not undo, that
 * save.
 */
export async function removeCompositionInstance(id: string, blockId: string, childSessionId: string, actor: CompositionSessionActor): Promise<PublicCompositionSession> {
  const record = await prisma.compositionSession.findUnique({ where: { id: text(id, 'id') } });
  if (!record) throw new HttpError(404, 'Composition session not found'); owner(record, actor);
  const { expected } = await compositionFor(record.compositionFormId);
  const expectedChild = expected.find((item) => item.blockId === text(blockId, 'blockId'));
  if (!expectedChild) throw new HttpError(404, 'Composition form block not found');
  if (!expectedChild.manualAdd) throw new HttpError(422, `Composition block '${expectedChild.blockId}' does not allow multiple instances`);
  const sessionId = text(childSessionId, 'childSessionId');
  const child = await getFormSession(sessionId, actor).catch(() => undefined);
  if (child && (child.status === 'submitted')) throw new HttpError(409, 'Bereits abgesendete Einträge können nicht entfernt werden.');
  const removeFrom = (groups: unknown): ChildGroupMap => {
    const map = isGroupMap(groups) ? groups : {};
    const existing = map[expectedChild.blockId] || [];
    return { ...map, [expectedChild.blockId]: existing.filter((existingId) => existingId !== sessionId) };
  };
  const updated = await prisma.compositionSession.updateMany({ where: { id: record.id, revision: record.revision }, data: { childSessionGroups: removeFrom(record.childSessionGroups), revision: { increment: 1 } } });
  if (updated.count === 0) {
    const fresh = await prisma.compositionSession.findUnique({ where: { id: record.id } });
    if (!fresh) throw new HttpError(404, 'Composition session not found');
    const retried = await prisma.compositionSession.update({ where: { id: record.id }, data: { childSessionGroups: removeFrom(fresh.childSessionGroups), revision: { increment: 1 } } });
    return publicSession(retried, actor);
  }
  const fresh = await prisma.compositionSession.findUnique({ where: { id: record.id } });
  if (!fresh) throw new HttpError(404, 'Composition session not found');
  return publicSession(fresh, actor);
}

export async function validateCompositionSession(id: string, actor: CompositionSessionActor): Promise<{ session: PublicCompositionSession; valid: boolean; children: ChildSummary[] }> {
  const record = await prisma.compositionSession.findUnique({ where: { id: text(id, 'id') } });
  if (!record) throw new HttpError(404, 'Composition session not found'); owner(record, actor);
  const baseline = await publicSession(record, actor);
  for (const child of baseline.children) {
    if (!child.sessionId || child.status === 'submitted') continue;
    await validateFormSession(child.sessionId, actor);
  }
  const session = await getCompositionSession(record.id, actor);
  const valid = session.children.length > 0 && session.children.every((child) => child.status === 'ready' || child.status === 'submitted');
  return { session, valid, children: session.children };
}
