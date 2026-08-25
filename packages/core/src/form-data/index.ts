import type { CanonicalForm, JsonPrimitive, JsonValue } from '../canonical';
import type { FormSessionValues, FormRuntimeMode, UserAuthMode } from '../form-session';

export const FORM_DATA_PROVIDER_API_VERSION = '1.0' as const;

/** @deprecated Use JsonPrimitive from the core contract. */
export type ProviderJsonPrimitive = JsonPrimitive;
/** @deprecated Use JsonValue from the core contract. */
export type ProviderJsonValue = JsonValue;

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
  metadata?: Record<string, ProviderJsonValue>;
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
  metadata?: Record<string, ProviderJsonValue>;
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
