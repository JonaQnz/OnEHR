export interface QuantityUnitOption {
  unit: string;
  min?: number;
  max?: number;
  minexclusive?: boolean;
  maxexclusive?: boolean;
  precision?: number;
}

export interface FieldConstraint {
  min?: number;
  max?: number;
  precision?: number;
  units?: string[];
  unitOptions?: QuantityUnitOption[];
}

export interface FieldRegistryItem {
  fieldName: string;
  label: string;
  templateAlias: string;
  templateId: string;
  rmType: string;
  dataType: string;
  openehrPath: string;
  required: boolean;
  maxOccurrences?: number;
  technicalName?: string;
  parentName?: string;
  parentTechnicalName?: string;
  constraints?: FieldConstraint;
  options?: Array<{
    value: string;
    text: string;
  }>;
  flatPath?: string;
}

export interface TemplateImportResult {
  templateId: string;
  alias: string;
  fields: FieldRegistryItem[];
}
