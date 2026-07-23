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
  defaultValue?: any;
  validation?: {
    min?: number;
    max?: number;
    regex?: string;
  };
  semanticType?: string;
  unit?: string;
  archetypeNodeId?: string;
  binding?: any;
  visibility?: any;
  enableWhen?: any;
  showTimeSelect?: boolean;
  showTimeSelectOnly?: boolean;
  dateFormat?: string;
  timeFormat?: string;
  repeatMin?: number;
  repeatMax?: number;
  repeatable?: boolean;
}

export interface OpenEhrBinding {
  templateAlias: string;
  path: string;
  rmType: string;
  flatPath?: string;
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
