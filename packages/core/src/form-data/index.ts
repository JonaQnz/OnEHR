import type { CanonicalForm, JsonValue } from '../canonical';
import type { FormSessionValues, FormRuntimeMode, UserAuthMode } from '../form-session';

export const FORM_DATA_PROVIDER_API_VERSION = '1.0' as const;

export interface FormDataProviderContext {
  mode: FormRuntimeMode;
  patientId: string;
  patientNamespace?: string;
  /** Explicit EHR target resolved by the trusted backend patient registry. */
  ehrId?: string;
  userId?: string;
  authMode?: UserAuthMode;
  sessionId?: string;
}

export interface FormDataProviderForm {
  id: string;
  version: string;
  definition: CanonicalForm;
}

/** A provider-neutral openEHR composition payload. */
export interface OpenEhrCompositionPayload {
  format: 'flat';
  templateId?: string;
  values: Record<string, unknown>;
}
export const FORM_SUBMISSION_PROTOCOL = 'formbuilder.form-submission.v1' as const;

/**
 * Neutral JSON envelope used when a submission is handed to a workflow
 * provider. It contains no engine-specific code and can be consumed by n8n,
 * scripts, or another workflow engine.
 */
export interface FormSubmissionEnvelope {
  protocol: typeof FORM_SUBMISSION_PROTOCOL;
  source: 'formbuilder';
  form: FormDataProviderForm;
  patient: {
    id: string;
    namespace?: string;
  };
  session: {
    id?: string;
    userId?: string;
    authMode?: UserAuthMode;
  };
  values: FormSessionValues;
  composition?: OpenEhrCompositionPayload;
}

export interface FormDataProviderLoadInput {
  context: FormDataProviderContext;
  form: FormDataProviderForm;
  /** Existing provider-specific resource version to load, when one is known. */
  reference?: string;
}

export interface FormDataProviderLoadResult {
  providerId: string;
  values: FormSessionValues;
  reference?: string;
  metadata?: Record<string, JsonValue>;
}

export interface FormDataProviderSubmitInput {
  context: FormDataProviderContext;
  form: FormDataProviderForm;
  values: FormSessionValues;
  reference?: string;
  /**
   * True when `reference` is this exact session's own previously-drafted
   * composition, not an externally-sourced reference (e.g. a prefill's
   * source composition). Only meaningful for submit(): it tells the
   * provider to update `reference` even outside edit mode, because doing
   * so continues this session's own draft rather than risking silently
   * overwriting someone else's composition. draft() always treats its own
   * `reference` as an update target regardless of this flag - it's only
   * ever handed a reference the caller already knows is safe to continue.
   */
  continuesDraft?: boolean;
}

export interface FormDataProviderSubmitResult {
  providerId: string;
  reference?: string;
  metadata?: Record<string, JsonValue>;
}

export interface FormDataProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly ('load' | 'submit' | 'draft')[];
  load(input: FormDataProviderLoadInput): Promise<FormDataProviderLoadResult>;
  submit(input: FormDataProviderSubmitInput): Promise<FormDataProviderSubmitResult>;
  /**
   * Persists an in-progress (possibly incomplete) set of values as the
   * session's running draft - same input/output shape as submit(), but
   * without submit's validation gate. Optional: a provider that can't or
   * shouldn't hold drafts (e.g. a workflow-trigger provider like n8n) just
   * omits 'draft' from capabilities and this method; callers must check
   * capabilities before calling it.
   */
  draft?(input: FormDataProviderSubmitInput): Promise<FormDataProviderSubmitResult>;
}

export interface FormDataProviderMessage {
  severity: 'info' | 'warning' | 'error';
  code?: string;
  path?: string;
  message: string;
}

/**
 * The shape a `FormDataProvider`'s own thrown errors are expected to carry -
 * an HTTP-ish `status`/`code` plus optional structured `messages`, on top of
 * a normal `Error`. Any provider (built into this app, like EHRbase's, or
 * supplied by a plugin, like n8n's) can throw one of these and have the
 * caller translate it consistently; callers detect it via
 * `isFormDataProviderError()` (structural, not `instanceof` a specific
 * provider's error class) so a provider living in a separate plugin package
 * never has to be imported by the code that just wants to relay its error -
 * see the `[[n8n-provider-moved-into-plugin]]` memory for the coupling this
 * replaced (a host-side `instanceof N8nProviderError` check that forced
 * `apps/api` to import a class from a plugin package it otherwise no longer
 * depends on at all).
 */
export interface FormDataProviderError extends Error {
  status?: number;
  code: string;
  messages?: readonly FormDataProviderMessage[];
}

export function isFormDataProviderError(error: unknown): error is FormDataProviderError {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'string';
}
