export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

export interface FormError {
  code: string;
  message: string;
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
    ehrbase?: {
      storageStrategy?: 'always_new' | 'update_latest';
      defaultMode?: 'create' | 'edit' | 'view' | 'prefill';
    };
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
