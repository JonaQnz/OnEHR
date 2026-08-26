import prisma from '../db/prisma';
import {
  assertFormSessionTransition,
  isFormRuntimeMode,
  isFormSessionChangeType,
  isFormSessionStatus,
  validateRuntimeValues,
  type FormDataProviderContext,
  type FormRuntimeMode,
  type FormSession,
  type FormSessionChangeType,
  type FormSessionLifecycleState,
  type FormSessionRuntimeContext,
  type FormSessionMessage,
  type FormSessionPatchInput,
  type FormSessionStatus,
  type FormSessionValues,
  type SessionValidationIssue,
  type UserAuthMode,
} from 'core';
import { HttpError } from '../middleware/errorHandler';
import { migrateCanonicalFormToV1 } from 'core';
import { getDataProvider } from './dataProviderRegistry';
import { EhrbaseProviderError } from './ehrbaseDataProvider';
import { N8nProviderError } from './n8nDataProvider';
import { getCompositionRepository } from './compositionRepository';
import { recordCompositionVersionEvent } from './compositionVersionEvents';
import { getPluginSettings } from './configService';
import { pluginRegistry } from '../plugins/pluginRegistry';
import type { PluginHookName, PluginHookResult } from 'plugin-api';
import { resolvePatientReference } from './patientService';
import { buildSessionRuntimeContext } from './aqlFunctionService';

export interface SessionActor {
  userId: string;
  authMode: UserAuthMode;
}

export interface CreateSessionInput {
  formId: string;
  patientId: string;
  patientNamespace?: string;
  values?: FormSessionValues;
  mode?: FormRuntimeMode;
  providerId?: string;
  providerReference?: string;
  /** Skips the resumable-session reuse below and always creates a fresh one -
   * only meaningful for edit/prefill (create/view never reuse regardless). */
  forceNew?: boolean;
}
type SessionHookInput = {
  name: PluginHookName;
  formId: string;
  form: Record<string, unknown>;
  data: Record<string, unknown>;
  patientId: string;
  sessionId?: string;
  actor: SessionActor;
  metadata?: Record<string, unknown>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function sessionValues(value: unknown): FormSessionValues {
  return isObject(value) ? value : {};
}

function sessionValidation(value: unknown): SessionValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isObject(item) || typeof item.code !== 'string' || typeof item.message !== 'string') return [];
    const severity = item.severity === 'info' || item.severity === 'warning' || item.severity === 'error'
      ? item.severity
      : undefined;
    return [{
      code: item.code,
      message: item.message,
      ...(typeof item.path === 'string' ? { path: item.path } : {}),
      ...(severity ? { severity } : {}),
    }];
  });
}

function runtimeContext(value: unknown): FormSessionRuntimeContext {
  if (!isObject(value)) return { aql: {}, codeFunctions: [] };
  const aql = isObject(value.aql) ? value.aql : {};
  const composition = isObject(value.composition) && isObject(value.composition.flat)
    && typeof value.composition.ehrId === 'string'
    && typeof value.composition.templateId === 'string'
    && typeof value.composition.loadedAt === 'string'
    ? {
      ehrId: value.composition.ehrId,
      templateId: value.composition.templateId,
      ...(typeof value.composition.reference === 'string' ? { reference: value.composition.reference } : {}),
      flat: value.composition.flat,
      loadedAt: value.composition.loadedAt,
    }
    : undefined;
  const errors: FormSessionRuntimeContext['errors'] = Array.isArray(value.errors) ? value.errors.flatMap((item) => (
    isObject(item) && (item.source === 'composition' || item.source === 'aql') && typeof item.message === 'string'
      ? [{ source: item.source as 'composition' | 'aql', ...(typeof item.function === 'string' ? { function: item.function } : {}), message: item.message }]
      : []
  )) : undefined;
  const codeFunctions = Array.isArray(value.codeFunctions) ? value.codeFunctions.flatMap((item) => (
    isObject(item) && typeof item.packageName === 'string' && typeof item.name === 'string' && typeof item.source === 'string'
      ? [{ packageName: item.packageName, name: item.name, source: item.source }]
      : []
  )) : [];
  return { ...(composition ? { composition } : {}), aql, codeFunctions, ...(errors && errors.length > 0 ? { errors } : {}) };
}

function persistedStatus(value: unknown): FormSessionStatus {
  if (!isFormSessionStatus(value)) throw new HttpError(500, 'Stored form session has an invalid status');
  return value;
}

function persistedMode(value: unknown): FormRuntimeMode {
  if (!isFormRuntimeMode(value)) throw new HttpError(500, 'Stored form session has an invalid mode');
  return value;
}

function transitionStatus(current: FormSessionStatus, next: FormSessionStatus): FormSessionStatus {
  try {
    assertFormSessionTransition(current, next);
  } catch {
    throw new HttpError(409, `Invalid form-session transition: ${current} -> ${next}`);
  }
  return next;
}

function assertSessionIsEditable(status: FormSessionStatus, lifecycleState?: unknown): void {
  if (lifecycleState === 'deleted') {
    throw new HttpError(409, 'This document has been withdrawn and can no longer be edited');
  }
  if (status === 'submitted' || status === 'cancelled') {
    throw new HttpError(409, 'Form session is no longer editable');
  }
}

function persistedLifecycleState(value: unknown): FormSessionLifecycleState {
  return value === 'new' || value === 'incomplete' || value === 'complete' || value === 'deleted' ? value : 'new';
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
  } catch {
    return false;
  }
}
async function runSessionHook(input: SessionHookInput) {
  return pluginRegistry.runHook(input.name, {
    formId: input.formId,
    patientId: input.patientId,
    sessionId: input.sessionId,
    userId: input.actor.userId,
    form: input.form as any,
    data: input.data as any,
    metadata: {
      ...(input.metadata || {}),
      authMode: input.actor.authMode,
      pluginSettings: getPluginSettings('org.example.n8n'),
    } as any,
  });
}

function messagesFromHook(result: PluginHookResult): FormSessionMessage[] {
  const messages = result.notices || [
    ...(result.warnings || []),
    ...(result.errors || []).map((error) => ({ severity: 'error' as const, path: error.path, message: error.message })),
  ];
  const normalized: FormSessionMessage[] = messages.map((message) => ({ severity: message.severity, message: message.message, ...(('code' in message && message.code) ? { code: message.code } : {}), ...(message.path ? { path: message.path } : {}) }));
  if (result.stop && !normalized.some((message) => message.severity === 'error')) normalized.push({ severity: 'error', code: 'PLUGIN_STOPPED', message: result.stopMessage || 'Plugin hat den Vorgang angehalten.' });
  return normalized;
}

function messagesFromProvider(result: unknown): FormSessionMessage[] {
  if (!isObject(result)) return [];
  const metadata = isObject(result.metadata) ? result.metadata : undefined;
  const response = metadata && isObject(metadata.response) ? metadata.response : undefined;
  if (!response) return [];
  const raw = Array.isArray(response.notices) ? response.notices : [];
  return raw.filter(isObject).map((item) => {
    const severity = item.severity === 'error' || item.severity === 'warning' ? item.severity : 'info';
    return { severity, message: typeof item.message === 'string' ? item.message : 'n8n Workflow beendet.', ...(typeof item.code === 'string' ? { code: item.code } : {}), ...(typeof item.path === 'string' ? { path: item.path } : {}) };
  });
}

function dataFromProvider(result: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!isObject(result)) return fallback;
  const metadata = isObject(result.metadata) ? result.metadata : undefined;
  const response = metadata && isObject(metadata.response) ? metadata.response : undefined;
  return response && isObject(response.data) ? response.data : fallback;
}
function throwHookErrors(name: PluginHookName, result: PluginHookResult): void {
  const messages = messagesFromHook(result);
  const errors = messages.filter((message) => message.severity === 'error');

  if (result.stop || errors.length > 0) {
    const reason = result.stopMessage || errors.map((error) => error.message).join('; ') || 'Plugin hat den Vorgang angehalten.';
    throw new HttpError(422, `Plugin ${name}: ${reason}`, { messages });
  }
}

async function runRequiredHook(input: SessionHookInput): Promise<{ data: Record<string, unknown>; messages: FormSessionMessage[] }> {
  const result = await runSessionHook(input);
  throwHookErrors(input.name, result);
  return { data: isObject(result.data) ? result.data : input.data, messages: messagesFromHook(result) };
}

async function runBestEffortHook(input: SessionHookInput): Promise<{ data: Record<string, unknown>; messages: FormSessionMessage[] }> {
  const result = await runSessionHook(input);
  const messages = messagesFromHook(result);
  if (messages.some((message) => message.severity === 'error')) console.warn(`[PLUGIN] ${input.name} completed with errors`, messages);
  return { data: isObject(result.data) ? result.data : input.data, messages };
}

async function formForSession(record: any): Promise<Record<string, unknown>> {
  const form = await prisma.form.findUnique({ where: { id: record.formId } });
  if (!form) throw new HttpError(404, 'Form definition not found');
  return migrateCanonicalFormToV1({ ...(form.canonical_json as any), id: form.id }, form.id) as unknown as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, `${field} is required`);
  return value.trim();
}

export interface ResolvedSessionPatient {
  patientId: string;
  patientNamespace?: string;
  ehrId?: string;
  id?: string;
  origin?: string;
}

async function resolveSessionPatient(
  patientId: string,
  patientNamespace?: string | null,
): Promise<ResolvedSessionPatient> {
  const patient = await resolvePatientReference(patientId, patientNamespace || undefined);
  if (!patient) {
    return {
      patientId,
      ...(patientNamespace ? { patientNamespace } : {}),
    };
  }
  return {
    patientId: patient.patientId,
    patientNamespace: patient.patientNamespace,
    ehrId: patient.ehrId,
    id: patient.id,
    origin: patient.origin,
  };
}

function providerContext(
  patient: ResolvedSessionPatient,
  sessionId: string,
  actor: SessionActor,
  mode: FormRuntimeMode,
): FormDataProviderContext {
  return {
    mode,
    patientId: patient.patientId,
    ...(patient.patientNamespace ? { patientNamespace: patient.patientNamespace } : {}),
    ...(patient.ehrId ? { ehrId: patient.ehrId } : {}),
    sessionId,
    userId: actor.userId,
    authMode: actor.authMode,
  };
}

function publicSession(
  record: any,
  messages?: FormSessionMessage[],
  patient?: ResolvedSessionPatient,
): FormSession {
  const mode = persistedMode(record.mode || 'create');
  const status = persistedStatus(record.status);
  return {
    id: record.id,
    formId: record.formId,
    formVersion: record.formVersion,
    mode,
    patientId: patient?.patientId || record.patientId,
    ...((patient?.patientNamespace || record.patientNamespace)
      ? { patientNamespace: patient?.patientNamespace || record.patientNamespace }
      : {}),
    ...(patient?.ehrId ? { ehrId: patient.ehrId } : {}),
    userId: record.userId,
    authMode: record.authMode,
    status,
    values: sessionValues(record.values),
    runtimeContext: runtimeContext(record.runtimeContext),
    validation: sessionValidation(record.validation),
    ...(messages && messages.length > 0 ? { messages } : {}),
    revision: record.revision,
    ...(record.providerId ? { providerId: record.providerId } : {}),
    ...(record.providerReference ? { providerReference: record.providerReference } : {}),
    ...(record.draftReference ? { draftReference: record.draftReference } : {}),
    ...((record.draftReference || record.providerReference) ? { baseVersionUid: record.draftReference || record.providerReference } : {}),
    lifecycleState: persistedLifecycleState(record.lifecycleState),
    lifecycleConfirmed: Boolean(record.lifecycleConfirmed),
    ...(isFormSessionChangeType(record.changeType) ? { changeType: record.changeType as FormSessionChangeType } : {}),
    ...(record.changeDescription ? { changeDescription: record.changeDescription } : {}),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function assertOwner(record: any, actor: SessionActor): void {
  if (record.userId !== actor.userId && actor.userId !== 'anonymous') throw new HttpError(403, 'You do not have access to this form session');
}

export async function createFormSession(input: CreateSessionInput, actor: SessionActor): Promise<FormSession> {
  const formId = requiredText(input.formId, 'formId');
  const requestedPatientId = requiredText(input.patientId, 'patientId');
  const patient = await resolveSessionPatient(
    requestedPatientId,
    typeof input.patientNamespace === 'string' ? input.patientNamespace.trim() || undefined : undefined,
  );
  // Adding a form to a patient is the "this patient is really being used in
  // Forms now" moment - an imported-from-EHRbase stub graduates to native
  // here and stays native from then on (syncPatientsFromEhrbase never
  // downgrades it back).
  if (patient.id && patient.origin === 'imported') {
    await prisma.patient.update({ where: { id: patient.id }, data: { origin: 'native' } });
  }
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  const mode = input.mode === undefined ? 'create' : input.mode;
  if (!isFormRuntimeMode(mode)) throw new HttpError(400, 'mode must be create, edit, view, or prefill');

  // Editing (or resuming a prefill of) something that already exists should
  // never spawn a second, disconnected editing attempt at the same
  // composition just because the user opened it again - unlike `create`,
  // where every launch is deliberately a brand-new clinical event and must
  // keep creating fresh sessions. Reuse is scoped to this user's own,
  // still-open (non-terminal) sessions for the same form+patient+mode; when
  // a specific composition is targeted (providerReference), it's matched by
  // base composition uid, not the full versioned reference (which changes
  // on every save) or object identity/string format.
  if ((mode === 'edit' || mode === 'prefill') && !input.forceNew) {
    const targetCompositionUid = compositionUidFromReference(input.providerReference);
    const candidates = await prisma.formSession.findMany({
      where: {
        formId,
        patientId: patient.patientId,
        patientNamespace: patient.patientNamespace || null,
        userId: actor.userId,
        mode,
        status: { notIn: ['submitted', 'cancelled'] },
      },
      orderBy: { updatedAt: 'desc' },
    });
    const reusable = targetCompositionUid
      ? candidates.find((candidate) => {
        const candidateUid = compositionUidFromReference(candidate.providerReference) || compositionUidFromReference(candidate.draftReference);
        return candidateUid === targetCompositionUid;
      })
      : candidates[0];
    if (reusable) return publicSession(reusable, undefined, patient);
  }

  const record = await prisma.formSession.create({ data: {
    formId,
    formVersion: form.version,
    mode,
    patientId: patient.patientId,
    patientNamespace: patient.patientNamespace || null,
    userId: actor.userId,
    authMode: actor.authMode,
    status: 'draft',
    values: (input.values || {}) as any,
    validation: [] as any,
    runtimeContext: { aql: {}, codeFunctions: [] } as any,
    revision: 0,
    providerId: input.providerId || null,
    providerReference: input.providerReference || null,
  } });
  const definition = migrateCanonicalFormToV1({ ...(form.canonical_json as any), id: form.id }, form.id);
  const context = providerContext(patient, record.id, actor, mode);
  const loadedContext = await buildSessionRuntimeContext(
    { id: form.id, version: form.version, definition },
    context,
  );
  const updated = await prisma.formSession.update({
    where: { id: record.id },
    data: { runtimeContext: loadedContext as any },
  });
  return publicSession(updated, undefined, patient);
}

export async function getFormSession(id: string, actor: SessionActor): Promise<FormSession> {
  const sessionId = requiredText(id, 'id');
  const record = await prisma.formSession.findUnique({ where: { id: sessionId } });
  if (!record) throw new HttpError(404, 'Form session not found');
  assertOwner(record, actor);
  const patient = await resolveSessionPatient(record.patientId, record.patientNamespace);
  return publicSession(record, undefined, patient);
}

export async function listFormSessions(actor: SessionActor, patientId?: string, formId?: string): Promise<FormSession[]> {
  const formFilter = formId ? { formId } : {};
  const records = await prisma.formSession.findMany({
    where: actor.userId === 'anonymous' ? { ...(patientId ? { patientId } : {}), ...formFilter } : { userId: actor.userId, ...(patientId ? { patientId } : {}), ...formFilter },
    orderBy: { updatedAt: 'desc' },
  });
  return Promise.all(records.map(async (record) => {
    const patient = await resolveSessionPatient(record.patientId, record.patientNamespace);
    return publicSession(record, undefined, patient);
  }));
}

export async function patchFormSession(id: string, input: FormSessionPatchInput, actor: SessionActor): Promise<FormSession> {
  const sessionId = requiredText(id, 'id');
  const record = await prisma.formSession.findUnique({ where: { id: sessionId } });
  if (!record) throw new HttpError(404, 'Form session not found');
  assertOwner(record, actor);
  const currentStatus = persistedStatus(record.status);
  if (input.expectedRevision !== undefined && input.expectedRevision !== record.revision) {
    const sameValues = input.values === undefined || sameJson(record.values, input.values);
    const sameStatus = input.status === undefined || input.status === record.status;
    if (sameValues && sameStatus) {
      const patient = await resolveSessionPatient(record.patientId, record.patientNamespace);
      return publicSession(record, undefined, patient);
    }
    throw new HttpError(409, 'Form session was changed by another request');
  }
  assertSessionIsEditable(currentStatus, record.lifecycleState);
  if (input.status !== undefined && !isFormSessionStatus(input.status)) {
    throw new HttpError(400, 'status is invalid');
  }
  if (input.status === 'ready' || input.status === 'submitted' || input.status === 'failed') {
    throw new HttpError(400, 'ready, submitted, and failed are managed by validation or provider submission');
  }
  const form = await formForSession(record);
  const beforeSave = await runRequiredHook({ name: 'beforeSave', formId: record.formId, form, data: input.values === undefined ? sessionValues(record.values) : input.values, patientId: record.patientId, sessionId, actor, metadata: { status: input.status || currentStatus } });
  const values = beforeSave.data;
  const requestedStatus = input.status || (input.values ? 'in_progress' : currentStatus);
  const status = transitionStatus(currentStatus, requestedStatus);
  const updated = await prisma.formSession.update({ where: { id: sessionId }, data: { values: values as any, status, revision: { increment: 1 } } });
  const afterSave = await runBestEffortHook({ name: 'afterSave', formId: record.formId, form, data: (updated.values || {}) as Record<string, unknown>, patientId: record.patientId, sessionId, actor, metadata: { status: updated.status } });
  const patient = await resolveSessionPatient(record.patientId, record.patientNamespace);
  return publicSession(updated, [...beforeSave.messages, ...afterSave.messages], patient);
}

export async function validateFormSession(id: string, actor: SessionActor): Promise<{ session: FormSession; valid: boolean; issues: SessionValidationIssue[] }> {
  const sessionId = requiredText(id, 'id');
  const record = await prisma.formSession.findUnique({ where: { id: sessionId } });
  if (!record) throw new HttpError(404, 'Form session not found');
  assertOwner(record, actor);
  const currentStatus = persistedStatus(record.status);
  assertSessionIsEditable(currentStatus, record.lifecycleState);
  const form = await formForSession(record);
  const beforeValidate = await runRequiredHook({ name: 'beforeValidate', formId: record.formId, form, data: (record.values || {}) as Record<string, unknown>, patientId: record.patientId, sessionId, actor });
  const result = validateRuntimeValues(form as any, beforeValidate.data as any, { mode: 'final' });
  const after = await runSessionHook({ name: 'afterValidate', formId: record.formId, form, data: beforeValidate.data, patientId: record.patientId, sessionId, actor, metadata: { valid: result.valid, issues: result.issues } });
  const afterMessages = messagesFromHook(after);
  const pluginIssues = afterMessages.filter((message) => message.severity === 'error').map((message) => ({ path: message.path || `plugin:${record.formId}`, code: message.code || 'plugin', message: message.message, severity: 'error' as const }));
  const issues = [...(result.issues as SessionValidationIssue[]), ...pluginIssues];
  const finalValues = isObject(after.data) ? after.data : beforeValidate.data;
  const valid = result.valid && pluginIssues.length === 0;
  const status = transitionStatus(currentStatus, valid ? 'ready' : 'in_progress');
  const updated = await prisma.formSession.update({ where: { id: sessionId }, data: { values: finalValues as any, validation: issues as any, status, revision: { increment: 1 } } });
  const patient = await resolveSessionPatient(record.patientId, record.patientNamespace);
  return { session: publicSession(updated, [...beforeValidate.messages, ...afterMessages], patient), valid, issues };
}

export async function submitFormSession(_id: string, _actor: SessionActor): Promise<never> {
  throw new HttpError(409, 'Submitting a session requires POST /provider/submit so a data provider confirms the submission');
}

function isVersionConflict(error: unknown): boolean {
  return error instanceof EhrbaseProviderError && error.code === 'COMPOSITION_VERSION_CONFLICT';
}

function mapProviderError(error: unknown): never {
  if (error instanceof EhrbaseProviderError) throw new HttpError(error.status || 502, error.message, { code: error.code });
  if (error instanceof N8nProviderError) throw new HttpError(error.status && error.status >= 400 && error.status < 500 ? error.status : 502, error.message, { code: error.code, messages: error.messages || [{ severity: 'error', code: error.code, message: error.message }] });
  throw error;
}

async function providerInput(id: string, providerId: string, actor: SessionActor) {
  const sessionId = requiredText(id, 'id');
  const session = await prisma.formSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, 'Form session not found');
  assertOwner(session, actor);
  assertSessionIsEditable(persistedStatus(session.status), session.lifecycleState);
  const form = await prisma.form.findUnique({ where: { id: session.formId } });
  if (!form) throw new HttpError(404, 'Form definition not found');
  const patient = await resolveSessionPatient(session.patientId, session.patientNamespace);
  return {
    session,
    patient,
    context: providerContext(patient, session.id, actor, persistedMode(session.mode)),
    provider: getDataProvider(requiredText(providerId, 'providerId')),
    form: { id: form.id, version: form.version, definition: migrateCanonicalFormToV1({ ...(form.canonical_json as any), id: form.id }, form.id) },
  };
}

function compositionUidFromReference(reference: string | null | undefined): string | undefined {
  if (!reference) return undefined;
  const last = reference.includes('/') ? reference.split('/').pop() : reference;
  return last ? last.split('::')[0] : undefined;
}

/**
 * Resolves a session's provider context for read-only history/audit access
 * - deliberately NOT `providerInput()`: history must stay visible on an
 * already-`submitted` or withdrawn (`deleted`) session, which
 * `assertSessionIsEditable` would otherwise reject. Viewing what happened is
 * never itself an edit.
 */
export async function resolveFormSessionHistoryContext(id: string, actor: SessionActor): Promise<{
  session: any;
  patient: ResolvedSessionPatient;
  context: FormDataProviderContext;
  providerId: string;
  compositionUid?: string;
}> {
  const sessionId = requiredText(id, 'id');
  const session = await prisma.formSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, 'Form session not found');
  assertOwner(session, actor);
  const patient = await resolveSessionPatient(session.patientId, session.patientNamespace);
  return {
    session,
    patient,
    context: providerContext(patient, session.id, actor, persistedMode(session.mode)),
    providerId: session.providerId || 'ehrbase',
    compositionUid: compositionUidFromReference(session.providerReference) || compositionUidFromReference(session.draftReference),
  };
}

export async function loadFormSessionFromProvider(id: string, providerId: string, actor: SessionActor): Promise<{ session: FormSession; provider: unknown }> {
  const input = await providerInput(id, providerId, actor);
  const form = input.form.definition as unknown as Record<string, unknown>;
  const beforeLoad = await runRequiredHook({ name: 'beforeLoad', formId: input.form.id, form, data: (input.session.values || {}) as Record<string, unknown>, patientId: input.session.patientId, sessionId: input.session.id, actor, metadata: { providerId } });
  let result;
  try {
    result = await input.provider.load({ 
      context: input.context, 
      form: input.form,
      ...(input.session.providerReference ? { reference: input.session.providerReference } : {})
    });
  } catch (error) {
    return mapProviderError(error);
  }
  const afterLoad = await runRequiredHook({ name: 'afterLoad', formId: input.form.id, form, data: (result.values || {}) as Record<string, unknown>, patientId: input.session.patientId, sessionId: input.session.id, actor, metadata: { providerId } });
  // A reference here means an existing Composition was actually loaded (the
  // data provider never sets one for prefill mode, precisely so a copied
  // source composition is never mistaken for what this session is editing).
  // That loaded Composition is, by this app's own save pipeline, only ever
  // 'complete' - a session's own drafts always clear draftReference on
  // finalize - so this is a safe inference, not a CDR readback; hence
  // lifecycleConfirmed stays false here.
  const loadedExistingComposition = Boolean(result.reference);
  const updated = await prisma.formSession.update({ where: { id: input.session.id }, data: {
    values: afterLoad.data as any,
    validation: [] as any,
    status: transitionStatus(persistedStatus(input.session.status), persistedStatus(input.session.status) === 'draft' ? 'in_progress' : persistedStatus(input.session.status)),
    providerId: result.providerId,
    providerReference: result.reference || input.session.providerReference || null,
    ...(loadedExistingComposition ? { lifecycleState: 'complete' as const, lifecycleConfirmed: false } : {}),
    revision: { increment: 1 },
  } });
  return { session: publicSession(updated, [...beforeLoad.messages, ...afterLoad.messages], input.patient), provider: result };
}

/**
 * Persists an in-progress, possibly-incomplete set of values as the
 * session's running draft. Unlike patchFormSession (local DB only), this
 * also best-effort pushes the same values to the session's data provider
 * (e.g. EHRbase) as a real, versioned composition update, using real
 * openEHR draft semantics (lifecycle_state=incomplete) when the provider
 * supports it - so a draft genuinely lives on the server that ultimately
 * owns the data, not only in Forms' own database. The local write always
 * happens first and always succeeds independently of the provider push:
 * it's the fast/resilient mirror, never the sole record, so a transient
 * provider failure can never lose what the user just typed - the next
 * debounced autosave retries.
 *
 * A real openEHR draft is explicitly allowed to have missing required
 * fields, but never an invalid typed value (e.g. a DV_QUANTITY that isn't a
 * number) - so this DOES validate, in 'draft' mode, and rejects the whole
 * autosave (nothing is persisted, locally or remotely) when that fails.
 */
export async function autosaveFormSessionDraft(id: string, providerId: string, actor: SessionActor, values: FormSessionValues): Promise<FormSession> {
  const input = await providerInput(id, providerId, actor);
  if (persistedMode(input.session.mode) === 'view') throw new HttpError(403, 'Session is in view mode and cannot be autosaved');
  const form = input.form.definition as unknown as Record<string, unknown>;
  const beforeSave = await runRequiredHook({ name: 'beforeSave', formId: input.form.id, form, data: values, patientId: input.session.patientId, sessionId: input.session.id, actor, metadata: { status: 'in_progress', draft: true } });
  const draftValues = beforeSave.data;
  const draftValidation = validateRuntimeValues(form as any, draftValues as any, { mode: 'draft' });
  if (!draftValidation.valid) {
    const messages = draftValidation.issues.map((item) => ({ severity: 'error' as const, code: item.code, path: item.path, message: item.message }));
    throw new HttpError(422, `${draftValidation.issues.length} Formular-Validierungsfehler verhindern das Speichern des Entwurfs`, { messages });
  }
  const status = transitionStatus(persistedStatus(input.session.status), 'in_progress');
  let updated = await prisma.formSession.update({ where: { id: input.session.id }, data: {
    values: draftValues as any,
    status,
    revision: { increment: 1 },
  } });
  let providerResult: unknown;
  const repository = getCompositionRepository(providerId);
  if (repository) {
    // Continue this session's own prior draft if one exists. Otherwise, for
    // an edit-mode session, seed from providerReference (the composition
    // actually being edited) so autosave progressively updates that same
    // record instead of spawning a separate draft composition. A
    // create/prefill-mode session with no draft yet gets no seed - its
    // providerReference, if any, is a prefill *source* that must never be
    // silently overwritten by autosave.
    const seedReference = updated.draftReference || (persistedMode(updated.mode) === 'edit' ? updated.providerReference : undefined) || undefined;
    try {
      const result = await repository.commit({
        context: input.context,
        form: input.form,
        values: draftValues,
        ...(seedReference ? { reference: seedReference } : {}),
        desiredLifecycleState: 'incomplete',
      }, 'draft');
      providerResult = result;
      updated = await prisma.formSession.update({ where: { id: input.session.id }, data: {
        providerId: result.providerId,
        draftReference: result.reference || seedReference || null,
        lifecycleState: result.lifecycleState,
        lifecycleConfirmed: result.lifecycleConfirmed,
      } });
      const eventEhrId = typeof result.metadata?.ehrId === 'string' ? result.metadata.ehrId : undefined;
      if (result.reference && eventEhrId) {
        void recordCompositionVersionEvent({
          versionUid: result.reference,
          compositionUid: compositionUidFromReference(result.reference) || result.reference,
          ehrId: eventEhrId,
          formSessionId: input.session.id,
          lifecycleState: result.lifecycleState,
        });
      }
    } catch (error) {
      // A version conflict is never a transient provider hiccup - it means
      // someone else's newer version already exists, so silently degrading
      // here (as every other push failure does) would hide a real risk of
      // overwriting it. Surface it distinctly instead of swallowing it.
      if (isVersionConflict(error)) return mapProviderError(error);
      console.warn(`[formSessionService] Draft autosave to provider '${providerId}' failed for session ${input.session.id}; local draft was still saved:`, error instanceof Error ? error.message : error);
    }
  } else if (input.provider.capabilities.includes('draft') && input.provider.draft) {
    const seedReference = updated.draftReference || (persistedMode(updated.mode) === 'edit' ? updated.providerReference : undefined) || undefined;
    try {
      const result = await input.provider.draft({
        context: input.context,
        form: input.form,
        values: draftValues,
        ...(seedReference ? { reference: seedReference } : {}),
      });
      providerResult = result;
      updated = await prisma.formSession.update({ where: { id: input.session.id }, data: {
        providerId: result.providerId,
        draftReference: result.reference || seedReference || null,
        // No lifecycle mechanism on this provider - Forms' own tracked
        // state still advances (there IS a real draft now), just never
        // CDR-confirmed.
        lifecycleState: 'incomplete',
        lifecycleConfirmed: false,
      } });
    } catch (error) {
      // A version conflict is never a transient provider hiccup - it means
      // someone else's newer version already exists, so silently degrading
      // here (as every other push failure does) would hide a real risk of
      // overwriting it. Surface it distinctly instead of swallowing it.
      if (isVersionConflict(error)) return mapProviderError(error);
      console.warn(`[formSessionService] Draft autosave to provider '${providerId}' failed for session ${input.session.id}; local draft was still saved:`, error instanceof Error ? error.message : error);
    }
  }
  const afterSave = await runBestEffortHook({ name: 'afterSave', formId: input.form.id, form, data: (updated.values || {}) as Record<string, unknown>, patientId: input.session.patientId, sessionId: input.session.id, actor, metadata: { status: updated.status, draft: true } });
  return publicSession(updated, [...beforeSave.messages, ...afterSave.messages, ...(providerResult ? messagesFromProvider(providerResult) : [])], input.patient);
}

export async function submitFormSessionToProvider(
  id: string,
  providerId: string,
  actor: SessionActor,
  options: { validatedRevision?: number; changeType?: string; changeDescription?: string } = {},
): Promise<{ session: FormSession; provider: unknown }> {
  const input = await providerInput(id, providerId, actor);
  if (persistedMode(input.session.mode) === 'view') throw new HttpError(403, 'Session is in view mode and cannot be submitted');
  // A matching revision alone is not proof that validation ran: normal saves
  // also increment it. Reuse a client-side validation only after it placed the
  // persisted session in `ready`; otherwise validate server-side before submit.
  const canReuseValidation = options.validatedRevision !== undefined
    && options.validatedRevision === input.session.revision
    && persistedStatus(input.session.status) === 'ready';
  const validation = canReuseValidation
    ? { session: publicSession(input.session, undefined, input.patient), valid: !Array.isArray(input.session.validation) || input.session.validation.length === 0, issues: (Array.isArray(input.session.validation) ? input.session.validation : []) as unknown as SessionValidationIssue[] }
    : await validateFormSession(id, actor);
  if (!validation.valid) {
    const messages = (validation.issues || []).map((item) => ({ severity: 'error' as const, code: item.code, path: item.path, message: item.message }));
    throw new HttpError(422, `${validation.issues.length} Formular-Validierungsfehler verhindern das Absenden`, { messages });
  }
  transitionStatus(validation.session.status, 'submitted');
  const form = input.form.definition as unknown as Record<string, unknown>;
  const beforeSubmit = await runRequiredHook({ name: 'beforeSubmit', formId: input.form.id, form, data: validation.session.values as Record<string, unknown>, patientId: input.session.patientId, sessionId: input.session.id, actor, metadata: { providerId } });
  const submitValues = beforeSubmit.data;
  // Prefer this session's own autosaved draft over providerReference: for a
  // create/prefill-mode session that's been autosaving, providerReference
  // (if set at all) is a prefill *source*, not something to update - the
  // draft is what should be finalized. continuesDraft is what tells the
  // provider it's safe to update that reference outside edit mode.
  const draftReference = input.session.draftReference || undefined;
  const submitReference = draftReference || input.session.providerReference || undefined;
  // A composition already `complete` (this session loaded and is re-editing
  // an already-finalized document) needs an explicit change_type - a
  // routine update vs. a correction of a documentation error. A first-time
  // finalize of a new/incomplete draft has none: openEHR records that as a
  // plain creation.
  const editingCompleteComposition = persistedLifecycleState(input.session.lifecycleState) === 'complete';
  const desiredChangeType: FormSessionChangeType | undefined = editingCompleteComposition
    ? (isFormSessionChangeType(options.changeType) ? options.changeType : (isFormSessionChangeType(input.session.changeType) ? input.session.changeType : 'modification'))
    : undefined;
  const changeDescription = options.changeDescription ?? (input.session.changeDescription || undefined);
  const repository = getCompositionRepository(providerId);
  let result: { providerId: string; reference?: string; metadata?: { ehrId?: string; templateId?: string }; lifecycleState?: FormSessionLifecycleState; lifecycleConfirmed?: boolean };
  try {
    if (repository) {
      result = await repository.commit({
        context: input.context,
        form: input.form,
        values: submitValues,
        ...(submitReference ? { reference: submitReference } : {}),
        continuesDraft: Boolean(draftReference),
        desiredLifecycleState: 'complete',
        ...(desiredChangeType ? { desiredChangeType } : {}),
        ...(changeDescription ? { changeDescription } : {}),
      }, 'submit');
    } else {
      result = await input.provider.submit({
        context: input.context,
        form: input.form,
        values: submitValues,
        ...(submitReference ? { reference: submitReference } : {}),
        continuesDraft: Boolean(draftReference),
      });
    }
  } catch (error) {
    return mapProviderError(error);
  }
  const providerValues = dataFromProvider(result, submitValues);
  const afterSubmit = await runBestEffortHook({ name: 'afterSubmit', formId: input.form.id, form, data: providerValues, patientId: input.session.patientId, sessionId: input.session.id, actor, metadata: { providerId, providerReference: result.reference, provider: result } });
  const updated = await prisma.formSession.update({ where: { id: input.session.id }, data: {
    status: 'submitted',
    providerId: result.providerId,
    values: afterSubmit.data as any,
    providerReference: result.reference || submitReference || null,
    draftReference: null, // finalized - providerReference above is now authoritative
    lifecycleState: result.lifecycleState || 'complete',
    lifecycleConfirmed: Boolean(result.lifecycleConfirmed),
    ...(desiredChangeType ? { changeType: desiredChangeType } : {}),
    ...(changeDescription ? { changeDescription } : {}),
    revision: { increment: 1 },
  } });
  if (result.reference && result.metadata?.ehrId) {
    void recordCompositionVersionEvent({
      versionUid: result.reference,
      compositionUid: compositionUidFromReference(result.reference) || result.reference,
      ehrId: result.metadata.ehrId,
      formSessionId: input.session.id,
      lifecycleState: result.lifecycleState || 'complete',
      changeType: desiredChangeType,
      changeDescription,
    });
  }
  return {
    session: publicSession(
      updated,
      [...(validation.session.messages || []), ...beforeSubmit.messages, ...afterSubmit.messages, ...messagesFromProvider(result)],
      input.patient,
    ),
    provider: result,
  };
}

/**
 * Logical withdrawal ("Dokument zurückziehen") of an already-finalized
 * Composition, via the CDR's real DELETE (confirmed logical-delete, not a
 * physical purge - the withdrawn version stays fully retrievable). Only a
 * `complete` document can be withdrawn; a withdrawn one becomes read-only
 * (assertSessionIsEditable rejects further edits on it). This intentionally
 * does NOT go through providerInput()'s status-based edit gate: a session
 * that just finished finalizing is FormSessionStatus 'submitted' - a
 * terminal *editing* status, but the composition it produced is very much
 * still withdrawable.
 */
export async function withdrawFormSessionFromProvider(id: string, providerId: string, actor: SessionActor, reason?: string): Promise<{ session: FormSession; provider: unknown }> {
  const sessionId = requiredText(id, 'id');
  const session = await prisma.formSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, 'Form session not found');
  assertOwner(session, actor);
  const lifecycleState = persistedLifecycleState(session.lifecycleState);
  if (lifecycleState === 'deleted') throw new HttpError(409, 'This document has already been withdrawn');
  if (lifecycleState !== 'complete') throw new HttpError(409, 'Only a finalized document can be withdrawn');
  if (!session.providerReference) throw new HttpError(409, 'No finalized composition reference to withdraw');
  const repository = getCompositionRepository(providerId);
  if (!repository) throw new HttpError(501, `Provider '${providerId}' does not support withdrawing a composition`);
  const patient = await resolveSessionPatient(session.patientId, session.patientNamespace);
  const context = providerContext(patient, session.id, actor, persistedMode(session.mode));
  let result;
  try {
    result = await repository.withdraw({ context, reference: session.providerReference, ...(reason ? { reason } : {}) });
  } catch (error) {
    return mapProviderError(error);
  }
  const updated = await prisma.formSession.update({ where: { id: session.id }, data: {
    lifecycleState: 'deleted',
    ...(reason ? { changeDescription: reason } : {}),
    revision: { increment: 1 },
  } });
  // patient.ehrId is what resolveEhrId() itself would have used here (it's
  // only resolved differently, via subject lookup, when context.ehrId is
  // unset) - if it's genuinely unavailable, skip the local event write
  // rather than guess; history for this version then simply falls back to
  // the CDR's own (accurate, for a delete) default.
  if (patient.ehrId) {
    void recordCompositionVersionEvent({
      versionUid: result.versionUid,
      compositionUid: compositionUidFromReference(result.versionUid) || result.versionUid,
      ehrId: patient.ehrId,
      formSessionId: session.id,
      lifecycleState: 'deleted',
      changeDescription: reason,
    });
  }
  return { session: publicSession(updated, undefined, patient), provider: result };
}
