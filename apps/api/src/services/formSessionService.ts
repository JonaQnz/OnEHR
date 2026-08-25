import prisma from '../db/prisma';
import {
  assertFormSessionTransition,
  isFormRuntimeMode,
  isFormSessionStatus,
  validateRuntimeValues,
  type FormDataProviderContext,
  type FormRuntimeMode,
  type FormSession,
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

function assertSessionIsEditable(status: FormSessionStatus): void {
  if (status === 'submitted' || status === 'cancelled') {
    throw new HttpError(409, 'Form session is no longer editable');
  }
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

interface ResolvedSessionPatient {
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
  assertSessionIsEditable(currentStatus);
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
  assertSessionIsEditable(currentStatus);
  const form = await formForSession(record);
  const beforeValidate = await runRequiredHook({ name: 'beforeValidate', formId: record.formId, form, data: (record.values || {}) as Record<string, unknown>, patientId: record.patientId, sessionId, actor });
  const result = validateRuntimeValues(form as any, beforeValidate.data as any);
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

function mapProviderError(error: unknown): never {
  if (error instanceof EhrbaseProviderError) throw new HttpError(error.status || 502, error.message);
  if (error instanceof N8nProviderError) throw new HttpError(error.status && error.status >= 400 && error.status < 500 ? error.status : 502, error.message, { code: error.code, messages: error.messages || [{ severity: 'error', code: error.code, message: error.message }] });
  throw error;
}

async function providerInput(id: string, providerId: string, actor: SessionActor) {
  const sessionId = requiredText(id, 'id');
  const session = await prisma.formSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new HttpError(404, 'Form session not found');
  assertOwner(session, actor);
  assertSessionIsEditable(persistedStatus(session.status));
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
  const updated = await prisma.formSession.update({ where: { id: input.session.id }, data: {
    values: afterLoad.data as any,
    validation: [] as any,
    status: transitionStatus(persistedStatus(input.session.status), persistedStatus(input.session.status) === 'draft' ? 'in_progress' : persistedStatus(input.session.status)),
    providerId: result.providerId,
    providerReference: result.reference || input.session.providerReference || null,
    revision: { increment: 1 },
  } });
  return { session: publicSession(updated, [...beforeLoad.messages, ...afterLoad.messages], input.patient), provider: result };
}

export async function submitFormSessionToProvider(id: string, providerId: string, actor: SessionActor, options: { validatedRevision?: number } = {}): Promise<{ session: FormSession; provider: unknown }> {
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
  let result;
  try {
    result = await input.provider.submit({
      context: input.context,
      form: input.form,
      values: submitValues,
      ...(input.session.providerReference ? { reference: input.session.providerReference } : {}),
    });
  } catch (error) {
    return mapProviderError(error);
  }
  const providerValues = dataFromProvider(result, submitValues);
  const afterSubmit = await runBestEffortHook({ name: 'afterSubmit', formId: input.form.id, form, data: providerValues, patientId: input.session.patientId, sessionId: input.session.id, actor, metadata: { providerId, providerReference: result.reference, provider: result } });
  const updated = await prisma.formSession.update({ where: { id: input.session.id }, data: {
    status: 'submitted',
    providerId: result.providerId,
    values: afterSubmit.data as any,
    providerReference: result.reference || input.session.providerReference || null,
    revision: { increment: 1 },
  } });
  return {
    session: publicSession(
      updated,
      [...(validation.session.messages || []), ...beforeSubmit.messages, ...afterSubmit.messages, ...messagesFromProvider(result)],
      input.patient,
    ),
    provider: result,
  };
}
