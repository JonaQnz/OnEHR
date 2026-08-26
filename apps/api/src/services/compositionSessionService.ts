import prisma from '../db/prisma';
import { getCompositionDefinition, isFormRuntimeMode, summarizeCompositionSession, type FormRuntimeMode } from 'core';
import { HttpError } from '../middleware/errorHandler';
import { getFormSession, validateFormSession, type SessionActor } from './formSessionService';
import { resolvePatientReference } from './patientService';

export type CompositionSessionActor = SessionActor;
type ChildMap = Record<string, string>;
type ChildSummary = { blockId: string; sessionId?: string; formId: string; status: string; valid?: boolean; issues?: Array<{ path: string; code: string; message: string }> };

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
  children: ChildSummary[];
  progress: { total: number; started: number; ready: number; submitted: number };
  revision: number;
  createdAt: string;
  updatedAt: string;
}

function text(value: unknown, field: string): string { if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, `${field} is required`); return value.trim(); }
function isMap(value: unknown): value is ChildMap { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) && Object.values(value as Record<string, unknown>).every((id) => typeof id === 'string'); }
function owner(record: { userId: string }, actor: CompositionSessionActor): void { if (record.userId !== actor.userId && actor.userId !== 'anonymous') throw new HttpError(403, 'You do not have access to this composition session'); }

async function compositionFor(id: string, publishedOnly = false) {
  const form = await prisma.form.findUnique({ where: { id } });
  if (!form) throw new HttpError(404, 'Composition not found');
  if (publishedOnly && form.status !== 'published') throw new HttpError(409, 'Only published compositions can be run');
  const definition = getCompositionDefinition((form.canonical_json as any).extensions || {});
  if (!definition) throw new HttpError(422, 'Form is not a Composition');
  const expected = definition.pages.flatMap((page) => page.blocks).filter((block) => block.type === 'form').map((block) => ({ blockId: block.id, formId: block.formId }));
  return { form, expected };
}

async function publicSession(record: any, actor: CompositionSessionActor): Promise<PublicCompositionSession> {
  const { expected } = await compositionFor(record.compositionFormId);
  const childSessions = isMap(record.childSessions) ? record.childSessions : {};
  const ids = Object.values(childSessions) as string[];
  const rows = ids.length ? await prisma.formSession.findMany({ where: { id: { in: ids } }, select: { id: true, formId: true, status: true, validation: true } }) : [];
  const children = expected.map((expectedChild): ChildSummary => {
    const sessionId = childSessions[expectedChild.blockId];
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
    };
  });
  const { progress, status: nextStatus } = summarizeCompositionSession(children);
  const persisted = record.status === nextStatus ? record : await prisma.compositionSession.update({ where: { id: record.id }, data: { status: nextStatus, revision: { increment: 1 } } });
  return { id: persisted.id, compositionFormId: persisted.compositionFormId, compositionVersion: persisted.compositionVersion, patientId: persisted.patientId, ...(persisted.patientNamespace ? { patientNamespace: persisted.patientNamespace } : {}), ...(persisted.ehrId ? { ehrId: persisted.ehrId } : {}), mode: persisted.mode as FormRuntimeMode, status: persisted.status, childSessions, children, progress, revision: persisted.revision, createdAt: persisted.createdAt.toISOString(), updatedAt: persisted.updatedAt.toISOString() };
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
  if (!input.forceNew) {
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

export async function attachCompositionChild(id: string, blockId: string, childSessionId: string, actor: CompositionSessionActor): Promise<PublicCompositionSession> {
  const record = await prisma.compositionSession.findUnique({ where: { id: text(id, 'id') } });
  if (!record) throw new HttpError(404, 'Composition session not found'); owner(record, actor);
  const { expected } = await compositionFor(record.compositionFormId);
  const expectedChild = expected.find((item) => item.blockId === text(blockId, 'blockId'));
  if (!expectedChild) throw new HttpError(404, 'Composition form block not found');
  const child = await getFormSession(text(childSessionId, 'childSessionId'), actor);
  const parentPatient = await resolvePatientReference(record.patientId, record.patientNamespace || undefined);
  const canonicalParentId = parentPatient?.patientId || record.patientId;
  if (child.formId !== expectedChild.formId || child.patientId !== canonicalParentId) throw new HttpError(422, 'Child form session does not match this composition context');
  const children = isMap(record.childSessions) ? record.childSessions : {};
  // Optimistic concurrency, same pattern as formSessionService.patchFormSession:
  // this is a read-modify-write on childSessions, so two concurrent attach
  // calls against the same parent (e.g. the same Composition open in two
  // tabs, or two blocks finishing their launch at once) could otherwise
  // silently drop one another's attachment. A conditional update on
  // revision - retried once against the now-current record - closes that
  // race without requiring the caller to know/send an expected revision.
  const updated = await prisma.compositionSession.updateMany({ where: { id: record.id, revision: record.revision }, data: { patientId: canonicalParentId, patientNamespace: parentPatient?.patientNamespace || record.patientNamespace, ehrId: parentPatient?.ehrId || record.ehrId, childSessions: { ...children, [expectedChild.blockId]: child.id }, status: 'in_progress', revision: { increment: 1 } } });
  if (updated.count === 0) {
    const fresh = await prisma.compositionSession.findUnique({ where: { id: record.id } });
    if (!fresh) throw new HttpError(404, 'Composition session not found');
    const freshChildren = isMap(fresh.childSessions) ? fresh.childSessions : {};
    if (freshChildren[expectedChild.blockId] === child.id) return publicSession(fresh, actor); // another request already attached the same block/session - no-op
    const retried = await prisma.compositionSession.update({ where: { id: record.id }, data: { patientId: canonicalParentId, patientNamespace: parentPatient?.patientNamespace || fresh.patientNamespace, ehrId: parentPatient?.ehrId || fresh.ehrId, childSessions: { ...freshChildren, [expectedChild.blockId]: child.id }, status: 'in_progress', revision: { increment: 1 } } });
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
