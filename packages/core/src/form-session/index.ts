export type FormSessionStatus = 'draft' | 'in_progress' | 'ready' | 'submitted' | 'failed' | 'cancelled';

export type UserAuthMode = 'local' | 'hip';

export interface SessionValidationIssue {
  path?: string;
  code: string;
  message: string;
  severity?: 'info' | 'warning' | 'error';
}

export interface FormSessionMessage {
  severity: 'info' | 'warning' | 'error';
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
