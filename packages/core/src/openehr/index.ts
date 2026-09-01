import type { Occurrences, ValueConstraint } from '../openehr-constraint';

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
  /** True when this field's nearest enclosing CLUSTER/EVENT/ACTIVITY (or a
   * repeatable technical wrapper like `any_event`) can itself occur more
   * than once in the template - i.e. this field is one column of a
   * repeatable group (e.g. one analyte row of a lab panel, one ICD entry of
   * a multiple-coding cluster), not a standalone value. Distinct from this
   * field's own `maxOccurrences`, which is the leaf's own cardinality
   * (almost always 1) and says nothing about its parent. Absent/false for
   * fields with no repeatable ancestor. */
  parentRepeatable?: boolean;
  parentRepeatMin?: number;
  parentRepeatMax?: number;
  /** The neutral OPT constraint engine's own view of this same field -
   * additive and optional (absent on templates parsed before this existed).
   * Attached at parse time by webTemplateParser.ts, from openehr-engine's
   * buildConstraintModelFromWebTemplate. Powers the Developer Inspector's
   * occurrences/value-constraint-union/semantic-binding display - never
   * used to decide runtime rendering/serialization on its own (see
   * docs/features/opt-constraint-engine-analysis.md for why that wiring is
   * a separate, not-yet-taken step). */
  constraintModel?: {
    archetypeInstanceKey: string;
    occurrences: Occurrences;
    valueConstraints: ValueConstraint[];
    parsingStatus: 'complete' | 'partial';
    warnings?: string[];
  };
}

export interface TemplateImportResult {
  templateId: string;
  alias: string;
  fields: FieldRegistryItem[];
}
