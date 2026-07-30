import type { CanonicalForm } from '../canonical';
import type { FormSessionValues, UserAuthMode } from '../form-session';

export const FORM_DATA_PROVIDER_API_VERSION = '1.0' as const;

export type ProviderJsonPrimitive = string | number | boolean | null;
export type ProviderJsonValue = ProviderJsonPrimitive | ProviderJsonValue[] | { [key: string]: ProviderJsonValue };

export interface FormDataProviderContext {
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
  ehrbase?: {
    templateId?: string;
    flatComposition: Record<string, unknown>;
  };
}

export interface FormDataProviderLoadInput {
  context: FormDataProviderContext;
  form: FormDataProviderForm;
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
}

export interface FormDataProviderSubmitResult {
  providerId: string;
  reference?: string;
  metadata?: Record<string, ProviderJsonValue>;
}

export interface FormDataProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly ('load' | 'submit')[];
  load(input: FormDataProviderLoadInput): Promise<FormDataProviderLoadResult>;
  submit(input: FormDataProviderSubmitInput): Promise<FormDataProviderSubmitResult>;
}
