import type { ValidationIssue, ValidationSeverity } from '../canonical';

export const FORM_SESSION_STATUSES = ['draft', 'in_progress', 'ready', 'submitted', 'failed', 'cancelled'] as const;
export type FormSessionStatus = (typeof FORM_SESSION_STATUSES)[number];

export const FORM_RUNTIME_MODES = ['create', 'edit', 'view', 'prefill'] as const;
export type FormRuntimeMode = (typeof FORM_RUNTIME_MODES)[number];

// The real openEHR Composition lifecycle this session's editing session is
// tracking - distinct from FormSessionStatus above (this app's own UI/
// workflow status). `new` = no server version yet; `incomplete`/`complete`
// mirror ORIGINAL_VERSION.lifecycle_state; `deleted` = withdrawn (logical
// delete only). See the Clinical Editing Layer (Epic 2).
export const FORM_SESSION_LIFECYCLE_STATES = ['new', 'incomplete', 'complete', 'deleted'] as const;
export type FormSessionLifecycleState = (typeof FORM_SESSION_LIFECYCLE_STATES)[number];

export function isFormSessionLifecycleState(value: unknown): value is FormSessionLifecycleState {
  return typeof value === 'string' && (FORM_SESSION_LIFECYCLE_STATES as readonly string[]).includes(value);
}

// openEHR AUDIT_DETAILS.change_type, restricted to the two values the
// editing UI distinguishes for a save against an already-complete
// composition: a routine update vs. a correction of a documentation error.
export const FORM_SESSION_CHANGE_TYPES = ['modification', 'amendment'] as const;
export type FormSessionChangeType = (typeof FORM_SESSION_CHANGE_TYPES)[number];

export function isFormSessionChangeType(value: unknown): value is FormSessionChangeType {
  return typeof value === 'string' && (FORM_SESSION_CHANGE_TYPES as readonly string[]).includes(value);
}

/** Client-tracked save lifecycle for one editing session - not persisted server-side. */
export const SAVE_STATES = ['idle', 'dirty', 'saving', 'saved', 'error', 'conflict'] as const;
export type SaveState = (typeof SAVE_STATES)[number];

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

/**
 * Immutable data loaded when a session starts. It is intentionally separate
 * from `values`: scripts may read it, but it never fills fields by itself.
 */
export interface FormSessionRuntimeContext {
  composition?: {
    ehrId: string;
    templateId: string;
    reference?: string;
    flat: Record<string, unknown>;
    loadedAt: string;
  };
  aql: Record<string, unknown>;
  /** Enabled custom JavaScript functions, loaded only inside the form-script worker. */
  codeFunctions: Array<{ packageName: string; name: string; source: string }>;
  errors?: Array<{ source: 'composition' | 'aql'; function?: string; message: string }>;
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
  runtimeContext: FormSessionRuntimeContext;
  validation: SessionValidationIssue[];
  messages?: FormSessionMessage[];
  revision: number;
  providerId?: string;
  providerReference?: string;
  /** This session's own autosaved draft composition reference, distinct from
   * providerReference (which for a prefill/edit-mode load is the SOURCE
   * composition and must never be silently overwritten by autosave). */
  draftReference?: string;
  /** `draftReference || providerReference` - the version this editing
   * session was based on, for conflict/If-Match purposes. */
  baseVersionUid?: string;
  lifecycleState: FormSessionLifecycleState;
  /** Whether the CDR was verified (by reading the committed version back) to
   * have actually applied lifecycleState/changeType, rather than this being
   * assumed from a lack of error. `false` does not mean the save failed -
   * only that the CDR's own lifecycle metadata isn't confirmed to match. */
  lifecycleConfirmed: boolean;
  changeType?: FormSessionChangeType;
  changeDescription?: string;
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
