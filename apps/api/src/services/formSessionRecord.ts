import {
  isFormSessionChangeType,
  type FormSession,
  type FormSessionChangeType,
  type FormSessionMessage,
  type FormSessionRuntimeContext,
  type FormSessionValues,
  type SessionValidationIssue,
} from 'core';
import { persistedAuthMode, persistedLifecycleState, persistedMode, persistedStatus } from './formSessionLifecycle';

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function sessionValues(value: unknown): FormSessionValues {
  return isObject(value) ? value : {};
}

export function sessionValidation(value: unknown): SessionValidationIssue[] {
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

export function runtimeContext(value: unknown): FormSessionRuntimeContext {
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

export function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
  } catch {
    return false;
  }
}

/** The subset of a `prisma.formSession` row this file actually reads,
 * kept deliberately separate from `@prisma/client`'s own generated
 * `FormSession`/`FormSessionStatus`/`FormSessionLifecycleState`/
 * `FormSessionChangeType` types - those would collide by name with this
 * file's own `core`-imported types of the same name, and importing them
 * would wrongly imply a raw DB enum/Json column value can be trusted
 * without going through persistedStatus()/persistedMode()/
 * persistedLifecycleState()/sessionValues() below. That defensive
 * validation is the whole point; this interface only names the columns,
 * it doesn't vouch for their contents - a genuine Prisma FormSession row
 * satisfies it structurally with zero cast needed at any call site.
 */
export interface FormSessionRow {
  id: string;
  formId: string;
  formVersion: string;
  mode: unknown;
  patientId: string;
  patientNamespace: string | null;
  userId: string;
  authMode: string;
  status: unknown;
  values: unknown;
  validation: unknown;
  runtimeContext: unknown;
  revision: number;
  providerId: string | null;
  providerReference: string | null;
  draftReference: string | null;
  lifecycleState: unknown;
  lifecycleConfirmed: boolean;
  changeType: unknown;
  changeDescription: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResolvedSessionPatient {
  patientId: string;
  patientNamespace?: string;
  ehrId?: string;
  id?: string;
  origin?: string;
}

export function publicSession(
  record: FormSessionRow,
  messages?: FormSessionMessage[],
  patient?: ResolvedSessionPatient,
): FormSession {
  const mode = persistedMode(record.mode || 'create');
  const status = persistedStatus(record.status);
  // Computed once rather than repeating the `||` chain in both the ternary
  // condition and its value (the previous shape re-evaluated the same
  // expression twice, and only worked at all because `record` being `any`
  // silently absorbed `record.patientNamespace`'s real `string | null` -
  // the `|| undefined` here does the same null-to-undefined narrowing
  // explicitly, now that the type checker actually sees it).
  const patientNamespace = patient?.patientNamespace || record.patientNamespace || undefined;
  return {
    id: record.id,
    formId: record.formId,
    formVersion: record.formVersion,
    mode,
    patientId: patient?.patientId || record.patientId,
    ...(patientNamespace ? { patientNamespace } : {}),
    ...(patient?.ehrId ? { ehrId: patient.ehrId } : {}),
    userId: record.userId,
    authMode: persistedAuthMode(record.authMode),
    status,
    values: sessionValues(record.values),
    runtimeContext: runtimeContext(record.runtimeContext),
    validation: sessionValidation(record.validation),
    ...(messages && messages.length > 0 ? { messages } : {}),
    revision: record.revision,
    ...(record.providerId ? { providerId: record.providerId } : {}),
    ...(record.providerReference ? { providerReference: record.providerReference } : {}),
    ...(record.draftReference ? { draftReference: record.draftReference } : {}),
    ...((record.draftReference || record.providerReference || undefined) ? { baseVersionUid: record.draftReference || record.providerReference || undefined } : {}),
    lifecycleState: persistedLifecycleState(record.lifecycleState),
    lifecycleConfirmed: Boolean(record.lifecycleConfirmed),
    ...(isFormSessionChangeType(record.changeType) ? { changeType: record.changeType as FormSessionChangeType } : {}),
    ...(record.changeDescription ? { changeDescription: record.changeDescription } : {}),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
