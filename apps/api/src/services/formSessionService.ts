import prisma from '../db/prisma';
import { validateRuntimeValues, type FormSession, type FormSessionMessage, type FormSessionPatchInput, type FormSessionStatus, type FormSessionValues, type SessionValidationIssue, type UserAuthMode } from 'core';
import { HttpError } from '../middleware/errorHandler';
import { migrateCanonicalFormToV1 } from 'core';
import { getDataProvider } from './dataProviderRegistry';
import { EhrbaseProviderError } from './ehrbaseDataProvider';
import { N8nProviderError } from './n8nDataProvider';
import { getPluginSettings } from './configService';
import { pluginRegistry } from '../plugins/pluginRegistry';
import type { PluginHookName, PluginHookResult } from 'plugin-api';

export interface SessionActor {
  userId: string;
  authMode: UserAuthMode;
}

export interface CreateSessionInput {
  formId: string;
  patientId: string;
  patientNamespace?: string;
  values?: FormSessionValues;
  providerId?: string;
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

function publicSession(record: any, messages?: FormSessionMessage[]): FormSession {
  return {
    id: record.id,
    formId: record.formId,
    formVersion: record.formVersion,
    patientId: record.patientId,
    ...(record.patientNamespace ? { patientNamespace: record.patientNamespace } : {}),
    userId: record.userId,
    authMode: record.authMode,
    status: record.status,
    values: record.values || {},
    validation: record.validation || [],
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
  const patientId = requiredText(input.patientId, 'patientId');
  const form = await prisma.form.findUnique({ where: { id: formId } });
  if (!form) throw new HttpError(404, 'Form not found');
  const record = await prisma.formSession.create({ data: {
    formId,
    formVersion: form.version,
    patientId,
    patientNamespace: typeof input.patientNamespace === 'string' ? input.patientNamespace.trim() || null : null,
    userId: actor.userId,
    authMode: actor.authMode,
    status: 'draft',
    values: (input.values || {}) as any,
    validation: [] as any,
    revision: 0,
    providerId: input.providerId || null,
  } });
  return publicSession(record);
}

export async function getFormSession(id: string, actor: SessionActor): Promise<FormSession> {
  const sessionId = requiredText(id, 'id');
  const record = await prisma.formSession.findUnique({ where: { id: sessionId } });
  if (!record) throw new HttpError(404, 'Form session not found');
  assertOwner(record, actor);
  return publicSession(record);
}

export async function listFormSessions(actor: SessionActor, patientId?: string, formId?: string): Promise<FormSession[]> {
  const formFilter = formId ? { formId } : {};
  const records = await prisma.formSession.findMany({
    where: actor.userId === 'anonymous' ? { ...(patientId ? { patientId } : {}), ...formFilter } : { userId: actor.userId, ...(patientId ? { patientId } : {}), ...formFilter },
    orderBy: { updatedAt: 'desc' },
  });
  return records.map((record) => publicSession(record));
}

export async function patchFormSession(id: string, input: FormSessionPatchInput, actor: SessionActor): Promise<FormSession> {
  const sessionId = requiredText(id, 'id');
  const record = await prisma.formSession.findUnique({ where: { id: sessionId } });
  if (!record) throw new HttpError(404, 'Form session not found');
  assertOwner(record, actor);
  if (input.expectedRevision !== undefined && input.expectedRevision !== record.revision) {
    const sameValues = input.values === undefined || sameJson(record.values, input.values);
    const sameStatus = input.status === undefined || input.status === record.status;
    if (sameValues && sameStatus) return publicSession(record);
    throw new HttpError(409, 'Form session was changed by another request');
  }
  if (record.status === 'submitted' || record.status === 'cancelled') throw new HttpError(409, 'Form session is no longer editable');
  const form = await formForSession(record);
  const beforeSave = await runRequiredHook({ name: 'beforeSave', formId: record.formId, form, data: (input.values === undefined ? record.values : input.values) as Record<string, unknown>, patientId: record.patientId, sessionId, actor, metadata: { status: input.status || record.status } });
  const values = beforeSave.data;
  const status = (input.status || (input.values ? 'in_progress' : record.status)) as FormSessionStatus;
  const updated = await prisma.formSession.update({ where: { id: sessionId }, data: { values: values as any, status, revision: { increment: 1 } } });
  const afterSave = await runBestEffortHook({ name: 'afterSave', formId: record.formId, form, data: (updated.values || {}) as Record<string, unknown>, patientId: record.patientId, sessionId, actor, metadata: { status: updated.status } });
  return publicSession(updated, [...beforeSave.messages, ...afterSave.messages]);
}

export async function validateFormSession(id: string, actor: SessionActor): Promise<{ session: FormSession; valid: boolean; issues: SessionValidationIssue[] }> {
  const sessionId = requiredText(id, 'id');
  const record = await prisma.formSession.findUnique({ where: { id: sessionId } });
  if (!record) throw new HttpError(404, 'Form session not found');
  assertOwner(record, actor);
  const form = await formForSession(record);
  const beforeValidate = await runRequiredHook({ name: 'beforeValidate', formId: record.formId, form, data: (record.values || {}) as Record<string, unknown>, patientId: record.patientId, sessionId, actor });
  const result = validateRuntimeValues(form as any, beforeValidate.data as any);
  const after = await runSessionHook({ name: 'afterValidate', formId: record.formId, form, data: beforeValidate.data, patientId: record.patientId, sessionId, actor, metadata: { valid: result.valid, issues: result.issues } });
  const afterMessages = messagesFromHook(after);
  const pluginIssues = afterMessages.filter((message) => message.severity === 'error').map((message) => ({ path: message.path || `plugin:${record.formId}`, code: message.code || 'plugin', message: message.message, severity: 'error' as const }));
  const issues = [...(result.issues as SessionValidationIssue[]), ...pluginIssues];
  const finalValues = isObject(after.data) ? after.data : beforeValidate.data;
  const valid = result.valid && pluginIssues.length === 0;
  const status = valid ? (record.status === 'draft' ? 'ready' : record.status) : 'in_progress';
  const updated = await prisma.formSession.update({ where: { id: sessionId }, data: { values: finalValues as any, validation: issues as any, status, revision: { increment: 1 } } });
  return { session: publicSession(updated, [...beforeValidate.messages, ...afterMessages]), valid, issues };
}

export async function submitFormSession(id: string, actor: SessionActor): Promise<FormSession> {
  const validation = await validateFormSession(id, actor);
  if (!validation.valid) throw new HttpError(422, 'Form session is not valid');
  const updated = await prisma.formSession.update({ where: { id: validation.session.id }, data: { status: 'submitted', revision: { increment: 1 } } });
  return publicSession(updated);
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
  if (session.status === 'submitted' || session.status === 'cancelled') throw new HttpError(409, 'Form session is no longer editable');
  const form = await prisma.form.findUnique({ where: { id: session.formId } });
  if (!form) throw new HttpError(404, 'Form definition not found');
  return {
    session,
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
    result = await input.provider.load({ context: { patientId: input.session.patientId, patientNamespace: input.session.patientNamespace || undefined, sessionId: input.session.id, userId: actor.userId, authMode: actor.authMode }, form: input.form });
  } catch (error) {
    return mapProviderError(error);
  }
  const afterLoad = await runRequiredHook({ name: 'afterLoad', formId: input.form.id, form, data: (result.values || {}) as Record<string, unknown>, patientId: input.session.patientId, sessionId: input.session.id, actor, metadata: { providerId } });
  const updated = await prisma.formSession.update({ where: { id: input.session.id }, data: {
    values: afterLoad.data as any,
    validation: [] as any,
    status: input.session.status === 'draft' ? 'in_progress' : input.session.status,
    providerId: result.providerId,
    providerReference: result.reference || input.session.providerReference || null,
    revision: { increment: 1 },
  } });
  return { session: publicSession(updated, [...beforeLoad.messages, ...afterLoad.messages]), provider: result };
}

export async function submitFormSessionToProvider(id: string, providerId: string, actor: SessionActor, options: { validatedRevision?: number } = {}): Promise<{ session: FormSession; provider: unknown }> {
  const input = await providerInput(id, providerId, actor);
  const validation = options.validatedRevision !== undefined && options.validatedRevision === input.session.revision
    ? { session: publicSession(input.session), valid: !Array.isArray(input.session.validation) || input.session.validation.length === 0, issues: (Array.isArray(input.session.validation) ? input.session.validation : []) as unknown as SessionValidationIssue[] }
    : await validateFormSession(id, actor);
  if (!validation.valid) {
    const messages = (validation.issues || []).map((item) => ({ severity: 'error' as const, code: item.code, path: item.path, message: item.message }));
    throw new HttpError(422, `${validation.issues.length} Formular-Validierungsfehler verhindern das Absenden`, { messages });
  }
  const form = input.form.definition as unknown as Record<string, unknown>;
  const beforeSubmit = await runRequiredHook({ name: 'beforeSubmit', formId: input.form.id, form, data: validation.session.values as Record<string, unknown>, patientId: input.session.patientId, sessionId: input.session.id, actor, metadata: { providerId } });
  const submitValues = beforeSubmit.data;
  let result;
  try {
    result = await input.provider.submit({ context: { patientId: input.session.patientId, patientNamespace: input.session.patientNamespace || undefined, sessionId: input.session.id, userId: actor.userId, authMode: actor.authMode }, form: input.form, values: submitValues });
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
  return { session: publicSession(updated, [...(validation.session.messages || []), ...beforeSubmit.messages, ...afterSubmit.messages, ...messagesFromProvider(result)]), provider: result };
}
