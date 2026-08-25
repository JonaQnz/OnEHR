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
  /** This node's own archetype node id, e.g. "at0004" - extracted from
   * openehrPath by openehr-engine's parseOpenEhrAqlPath at parse time, not
   * left for a downstream consumer to regex out later. */
  archetypeNodeId?: string;
  /** The archetype id nearest-enclosing this node, e.g.
   * "openEHR-EHR-OBSERVATION.blood_pressure.v2". */
  archetypeId?: string;
  /** archetypeId's trailing ".vN". */
  rmVersion?: string;
}

export interface TemplateImportResult {
  templateId: string;
  alias: string;
  fields: FieldRegistryItem[];
}
