import type {
  FormScriptChangeSource,
  FormScriptEventName,
  FormScriptLogEntry,
  FormScriptSchemaIds,
  RuntimeValues,
} from 'core';

export interface FormScriptUiState {
  visible?: boolean;
  enabled?: boolean;
  readonly?: boolean;
  required?: boolean;
  loading?: boolean;
  label?: string;
  placeholder?: string;
  helpText?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface FormScriptLifecycleResult {
  cancelled: boolean;
  message?: string;
}

/** A field('id').validate() result, normalized in the worker - a bare
 * string return is always `severity: 'error'`, unchanged from before this
 * became an object; only the object form can be a non-blocking 'warning'. */
export interface FormScriptFieldMessage {
  message: string;
  severity: 'error' | 'warning';
  /** Always 'script' - see RuntimeValidationIssue.source (packages/core/form-runtime). */
  source: 'script';
}

/** A field's current value came from an AQL prefill run, not a clinician's
 * own entry - see formScript.worker.ts's `provenance` map. Carried
 * alongside `form:set-value` so the host can render a small "aus AQL ·
 * HH:MM"-style badge without a separate lookup. */
export interface FormScriptFieldProvenance {
  kind: 'prefill';
  source: string;
  timestamp?: string;
}

/** Raised when a script's `field(id).prefill(...)` call would overwrite a
 * value that didn't itself come from a prior prefill (i.e. a real
 * clinician entry) - the host decides, the worker waits. See
 * `FormScriptClient.resolvePrefillConflict()`. */
export interface FormScriptPrefillConflict {
  requestId: string;
  fieldId: string;
  currentValue: unknown;
  prefillValue: unknown;
  source: string;
  timestamp?: string;
}

interface ChangePayload {
  id: string;
  value: unknown;
  previousValue: unknown;
  source: FormScriptChangeSource;
  initialLoad: boolean;
}

interface GroupChangePayload {
  groupId: string;
  index: number;
  fieldId: string;
  value: unknown;
  previousValue: unknown;
  source: FormScriptChangeSource;
}

/** Messages the worker sends to the host. Grouped below by concern. */
export type FormWorkerToHostMessage =
  // lifecycle
  | { type: 'ready' }
  | { type: 'init-error'; message?: string }
  | { type: 'response'; requestId: string; result?: unknown }
  // validators
  | { type: 'validation:errors'; errors: Record<string, FormScriptFieldMessage> }
  // computed values
  | { type: 'form:set-value'; id: string; value: unknown; persist?: boolean; provenance?: FormScriptFieldProvenance | null }
  | { type: 'form:update-values'; values: RuntimeValues; persist?: boolean }
  // host operations
  | { type: 'api:call'; requestId: string; operation?: string; input?: unknown; timeoutMs?: number }
  | { type: 'api:cancel'; requestId: string }
  | { type: 'ui:set-state'; kind: string; id: string; state: FormScriptUiState }
  | { type: 'ui:toast'; level: string; message: string }
  | { type: 'prefill:conflict'; requestId: string; fieldId: string; currentValue: unknown; prefillValue: unknown; source: string; timestamp?: string }
  | { type: 'log'; entry: FormScriptLogEntry };

/** Messages the host sends to the worker. */
export type FormHostToWorkerMessage =
  // lifecycle
  | {
    type: 'init';
    compiled: string;
    values: RuntimeValues;
    ids: FormScriptSchemaIds & { groupFields: Record<string, string[]> };
    requiredFields: string[];
    context: Record<string, unknown>;
    runtimeFunctions: Array<{ packageName: string; name: string; source: string }>;
  }
  | { type: 'lifecycle'; name: FormScriptEventName; requestId: string; values: RuntimeValues }
  // validators
  | { type: 'validate'; requestId: string; values: RuntimeValues }
  // computed values
  | { type: 'change'; change: ChangePayload }
  | { type: 'group-change'; change: GroupChangePayload }
  | { type: 'group-add'; groupId: string; index: number; item: Record<string, unknown> }
  | { type: 'group-remove'; groupId: string; index: number; item: Record<string, unknown> }
  | { type: 'values'; values: RuntimeValues; source: FormScriptChangeSource; emitChanges: boolean }
  // host operations
  | { type: 'ui-event'; id: string; event: 'focus' | 'blur' }
  | { type: 'button'; id: string }
  | { type: 'prefill:resolve'; requestId: string; apply: boolean }
  | { type: 'api:response'; requestId: string; result?: unknown; error?: string; code?: string; durationMs?: number };

const WORKER_MESSAGE_TYPES = new Set<FormWorkerToHostMessage['type']>([
  'ready',
  'init-error',
  'response',
  'validation:errors',
  'form:set-value',
  'form:update-values',
  'api:call',
  'api:cancel',
  'ui:set-state',
  'ui:toast',
  'prefill:conflict',
  'log',
]);

/** Type guard for messages received from the form script worker. Ignore
 * anything that is not a plain object with a known worker message `type`. */
export function isFormWorkerMessage(value: unknown): value is FormWorkerToHostMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && WORKER_MESSAGE_TYPES.has(type as FormWorkerToHostMessage['type']);
}
