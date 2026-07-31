export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** Shared machine-readable validation contract used by runtime, sessions and plugins. */
export type ValidationSeverity = 'info' | 'warning' | 'error';

export interface FormIssue {
  message: string;
  path?: string;
  severity?: ValidationSeverity;
}

export interface ValidationIssue extends FormIssue {
  code: string;
}

export interface FormElementLayout {
  type: 'form' | 'container' | 'row' | 'column' | 'input-text' | 'input-select' | 'input-quantity' | 'input-proportion' | string;
  name?: string;
  children?: FormElementLayout[];
  spanLarge?: number;
  spanMedium?: number;
  spanSmall?: number;
  clearable?: boolean;
  display?: string;
  unitOptions?: Array<{
    unit: string;
    min?: number;
    max?: number;
    precision?: number;
  }>;
  options?: Array<{
    value: string;
    text: string;
  }>;
  content?: string;
  required?: boolean;
  readOnly?: boolean;
  uiElement?: string;
  step?: number;
  min_value?: number;
  max_value?: number;
  default_value?: number;
  id?: string;
  label?: string;
  description?: string;
  helpText?: string;
  placeholder?: string;
  defaultValue?: JsonValue;
  validation?: {
    min?: number;
    max?: number;
    regex?: string;
  };
  semanticType?: string;
  unit?: string;
  archetypeNodeId?: string;
  binding?: OpenEhrBinding;
  visibility?: JsonValue;
  enableWhen?: JsonValue;
  showTimeSelect?: boolean;
  showTimeSelectOnly?: boolean;
  dateFormat?: string;
  timeFormat?: string;
  repeatMin?: number;
  repeatMax?: number;
  repeatable?: boolean;
  props?: Record<string, unknown>;
}

export interface OpenEhrBinding {
  templateAlias: string;
  path: string;
  rmType: string;
  flatPath?: string;
}

export interface FormError extends ValidationIssue {
  fieldId?: string;
  openEhrPath?: string;
  source: 'runtime' | 'validation' | 'script' | 'plugin' | 'openehr' | 'provider' | 'host';
  cause?: unknown;
}
/**
 * Standard form submission routing. The core only defines the neutral
 * contract; an extension owns the workflow engine represented by `workflow`.
 */
export type FormSubmissionMode = 'direct' | 'workflow';

export interface FormWorkflowReference {
  engine: string;
  workflowId?: string;
  webhookUrl?: string;
  publicWebhookUrl?: string;
  hooks?: Record<string, string>;
  enabledHooks?: Record<string, boolean>;
  version?: string;
}

export interface FormSubmissionSettings {
  mode: FormSubmissionMode;
  providerId?: string;
  workflow?: FormWorkflowReference;
}

/** Runtime behaviour independent of a concrete server or submission provider. */
export interface FormRuntimeSettings {
  defaultMode?: 'create' | 'edit' | 'view' | 'prefill';
}

export interface CanonicalForm {
  id: string;
  name: string;
  version: string;
  status?: string;
  settings?: {
    showTechnicalPaths?: boolean;
    showStructuralNodes?: boolean;
    description?: string;
    defaultLocale?: string;
    authors?: string;
    tags?: string[];
    submission?: FormSubmissionSettings;
    runtime?: FormRuntimeSettings;
  };
  sourceTemplates: Array<{
    alias: string;
    id: string;
    version: string;
    type: string;
  }>;
  layout: FormElementLayout;
  bindings: Record<string, { openehr: OpenEhrBinding }>;
  locales: Record<string, Record<string, { label: string }>>;
}
