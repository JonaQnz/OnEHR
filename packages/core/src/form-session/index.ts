import type { ValidationIssue, ValidationSeverity } from '../canonical';

export const FORM_SESSION_STATUSES = ['draft', 'in_progress', 'ready', 'submitted', 'failed', 'cancelled'] as const;
export type FormSessionStatus = (typeof FORM_SESSION_STATUSES)[number];

export const FORM_RUNTIME_MODES = ['create', 'edit', 'view', 'prefill'] as const;
export type FormRuntimeMode = (typeof FORM_RUNTIME_MODES)[number];

const formSessionTransitions: Readonly<Record<FormSessionStatus, readonly FormSessionStatus[]>> = {
  draft: ['in_progress', 'ready', 'cancelled'],
  in_progress: ['ready', 'cancelled'],
  ready: ['in_progress', 'submitted', 'cancelled'],
  submitted: [],
  failed: ['in_progress', 'cancelled'],
  cancelled: [],
};

export function isFormSessionStatus(value: unknown): value is FormSessionStatus {
  return typeof value === 'string' && (FORM_SESSION_STATUSES as readonly string[]).includes(value);
}

export function isFormRuntimeMode(value: unknown): value is FormRuntimeMode {
  return typeof value === 'string' && (FORM_RUNTIME_MODES as readonly string[]).includes(value);
}

export function canTransitionFormSession(current: FormSessionStatus, next: FormSessionStatus): boolean {
  return current === next || formSessionTransitions[current].includes(next);
}

export function assertFormSessionTransition(current: FormSessionStatus, next: FormSessionStatus): void {
  if (!canTransitionFormSession(current, next)) {
    throw new Error(`Invalid form-session transition: ${current} -> ${next}`);
  }
}

export type UserAuthMode = 'local' | 'hip';

export interface SessionValidationIssue extends ValidationIssue {}

export interface FormSessionMessage {
  severity: ValidationSeverity;
  message: string;
  code?: string;
  path?: string;
}

export interface FormSessionValues {
  [fieldId: string]: unknown;
}

export interface FormSession {
  id: string;
  formId: string;
  formVersion: string;
  mode: FormRuntimeMode;
  patientId: string;
  patientNamespace?: string;
  ehrId?: string;
  userId: string;
  authMode: UserAuthMode;
  status: FormSessionStatus;
  values: FormSessionValues;
  validation: SessionValidationIssue[];
  messages?: FormSessionMessage[];
  revision: number;
  providerId?: string;
  providerReference?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FormSessionCreateInput {
  formId: string;
  mode?: FormRuntimeMode;
  patientId: string;
  patientNamespace?: string;
  values?: FormSessionValues;
  providerId?: string;
}

export interface FormSessionPatchInput {
  values?: FormSessionValues;
  status?: FormSessionStatus;
  expectedRevision?: number;
}
