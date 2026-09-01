/**
 * The neutral openEHR constraint model - the layer between "OPT" and "Form
 * Designer/Renderer" described in the OPT constraint engine architecture.
 * Nothing in this file knows about WebTemplate JSON, raw OPT XML, or any UI
 * widget - it is pure openEHR RM/AOM vocabulary (ELEMENT, occurrences,
 * DV_CODED_TEXT, CODE_PHRASE, term bindings) so both the OPT-ingestion side
 * (packages/openehr-engine/src/opt) and the rendering side (apps/web) can
 * depend on the same types without either one leaking its own concerns into
 * the other.
 *
 * Central rule this file exists to enforce: local at-codes are NOT globally
 * unique (e.g. `at0076` means "Confirmed" in
 * `openEHR-EHR-EVALUATION.problem_diagnosis.v1` but "Complication" in
 * `openEHR-EHR-CLUSTER.problem_qualifier.v2`, both real nodes of
 * vg_Diagnosis.v1.1.1) - so there must never be a single
 * `Map<atCode, Term>` anywhere. Every terminology lookup is scoped to one
 * archetype id, via `resolveTerm()`.
 */

// ---------------------------------------------------------------------------
// Terminology - archetype-scoped, multi-language
// ---------------------------------------------------------------------------

export interface ArchetypeTermDefinition {
  text: string;
  description?: string;
  comment?: string;
}

/** One archetype's own term definitions, keyed by language then by code -
 * never a single cross-archetype map. Corresponds to an OPT's
 * `component_ontologies`/`term_definitions` for one archetype id (when
 * sourced from raw OPT XML), but is equally well populated from a
 * WebTemplate's own `localizedNames`/`localizedLabels` (which, confirmed
 * against a real EHRbase export, already carries every configured language
 * in one response - no raw OPT parse is required for this part). */
export interface ArchetypeTerminology {
  archetypeId: string;
  languages: {
    [language: string]: {
      [code: string]: ArchetypeTermDefinition;
    };
  };
}

/** A archetype at-code's cross-reference to an external terminology (e.g.
 * `local::at0064` -> `SNOMED-CT::8319008`), as declared in an OPT's own
 * `term_bindings`. This is model metadata about the archetype, never a
 * clinical value - a user's actual selection of "at0064" must still be
 * stored as `local::at0064` in `defining_code`, not silently swapped for the
 * bound external code. Kept as a fully separate concept from
 * `CodedTextOption`/`defining_code` for exactly this reason - see the OPT
 * constraint engine architecture note "term_bindings separat behandeln". */
export interface SemanticBinding {
  sourceCode: string;
  targetTerminologyId: string;
  targetCode: string;
}

/** Looks up one archetype's own term text for one code in one language,
 * with a fallback chain: preferredLanguage -> fallbackLanguage -> the
 * terminology's own defaultLanguage entry (if given) -> the bare code
 * string. Never throws - a missing translation degrades to something still
 * displayable rather than crashing the UI. */
export function resolveTerm(
  terminology: ArchetypeTerminology | undefined,
  code: string,
  preferredLanguage: string,
  fallbackLanguage?: string,
): string {
  if (!terminology) return code;
  const preferred = terminology.languages[preferredLanguage]?.[code];
  if (preferred) return preferred.text;
  if (fallbackLanguage) {
    const fallback = terminology.languages[fallbackLanguage]?.[code];
    if (fallback) return fallback.text;
  }
  for (const lang of Object.keys(terminology.languages)) {
    const entry = terminology.languages[lang]?.[code];
    if (entry) return entry.text;
  }
  return code;
}

/** Same as resolveTerm, but scoped to one archetype within a whole
 * `OpenEhrTerminologyIndex` - the shape most callers actually have to hand
 * (a template's full index, not one already-picked-out ArchetypeTerminology).
 * This is the function signature the architecture doc calls out explicitly:
 * `resolveTerm(archetypeId, code, language)`. */
export function resolveTermIn(
  index: OpenEhrTerminologyIndex,
  archetypeId: string,
  code: string,
  preferredLanguage: string,
  fallbackLanguage?: string,
): string {
  return resolveTerm(index[archetypeId], code, preferredLanguage, fallbackLanguage);
}

/** Every archetype's terminology in one template, keyed by archetype id -
 * the container `resolveTermIn` looks into. Deliberately NOT
 * `Map<atCode, Term>` at any level; the outer key is always an archetype id,
 * the inner lookup always additionally takes that same archetype id's own
 * `ArchetypeTerminology` scope. */
export type OpenEhrTerminologyIndex = Record<string, ArchetypeTerminology>;

// ---------------------------------------------------------------------------
// Value constraints - a union per ELEMENT, not one rmType string
// ---------------------------------------------------------------------------

export interface CodedTextOption {
  terminologyId: string;
  codeString: string;
  /** Resolved display text for the language the model was built/requested
   * for - callers that need every language should use `resolveTerm` against
   * the owning ArchetypeTerminology instead of this single resolved copy. */
  text: string;
  description?: string;
  semanticBindings?: SemanticBinding[];
}

export interface DvTextConstraint { rmType: 'DV_TEXT'; }
export interface DvCodedTextConstraint {
  rmType: 'DV_CODED_TEXT';
  terminologyId?: string;
  valueSetId?: string;
  allowedCodes?: string[];
  options?: CodedTextOption[];
  /** Whether this DV_CODED_TEXT slot's own list is open-ended per the OPT's
   * `list_open`/`assumed_value` semantics - independent of, and not to be
   * confused with, a sibling DV_TEXT alternative on the same ELEMENT (that
   * is `valueConstraints` having a second, distinct DV_TEXT entry). */
  openEnded?: boolean;
}
export interface DvBooleanConstraint { rmType: 'DV_BOOLEAN'; }
export interface DvDateConstraint { rmType: 'DV_DATE'; }
export interface DvTimeConstraint { rmType: 'DV_TIME'; }
export interface DvDateTimeConstraint { rmType: 'DV_DATE_TIME'; }
export interface DvDurationConstraint { rmType: 'DV_DURATION'; }
export interface DvCountConstraint { rmType: 'DV_COUNT'; }
export interface DvQuantityConstraint { rmType: 'DV_QUANTITY'; units?: string[]; }
export interface DvProportionConstraint { rmType: 'DV_PROPORTION'; }
export interface DvOrdinalConstraint { rmType: 'DV_ORDINAL'; options?: CodedTextOption[]; }
export interface DvIdentifierConstraint { rmType: 'DV_IDENTIFIER'; }
export interface DvUriConstraint { rmType: 'DV_URI'; }
/** An RM type the parser saw but does not (yet) have a dedicated constraint
 * shape for - see "Warnings statt stiller Datenverluste" in the
 * architecture doc. Carries the raw rmType through unmodified rather than
 * ever falling back to treating the field as free text. */
export interface UnknownConstraint { rmType: string; unsupported: true; }

export type ValueConstraint =
  | DvTextConstraint
  | DvCodedTextConstraint
  | DvBooleanConstraint
  | DvDateConstraint
  | DvTimeConstraint
  | DvDateTimeConstraint
  | DvDurationConstraint
  | DvCountConstraint
  | DvQuantityConstraint
  | DvProportionConstraint
  | DvOrdinalConstraint
  | DvIdentifierConstraint
  | DvUriConstraint
  | UnknownConstraint;

// ---------------------------------------------------------------------------
// Field / archetype-instance model
// ---------------------------------------------------------------------------

export interface Occurrences {
  min: number;
  /** `null` for unbounded (OPT `*`). */
  max: number | null;
}

export interface OpenEhrFieldDefinition {
  /** Stable composite identity - see canonicalFieldId(). Never just the bare
   * nodeId: two fields can share a nodeId while belonging to different
   * archetype instances (e.g. `at0005` under "primary diagnosis" vs under
   * "secondary diagnosis"). */
  id: string;
  archetypeId: string;
  archetypeInstanceKey: string;
  nodeId: string;
  rmType: 'ELEMENT';
  /** Full, template-rooted openEHR path (AQL path), including any
   * disambiguating `name/value='...'` predicates on ancestor archetype
   * roots - this is what actually distinguishes the "primary diagnosis"
   * `at0005` from the "secondary diagnosis" `at0005` on the wire. */
  path: string;
  label: Record<string, string>;
  description?: Record<string, string>;
  comment?: string;
  occurrences: Occurrences;
  valueConstraints: ValueConstraint[];
  parsingStatus: 'complete' | 'partial';
  warnings?: string[];
}

export interface ArchetypeInstanceDefinition {
  archetypeId: string;
  /** `archetypeId` alone when this archetype is used only once in the
   * template; `archetypeId + '|' + nameConstraint` (or `archetypeId + '#' +
   * index` when repeated without a disambiguating name) when it is used
   * more than once - see canonicalInstanceKey(). Two instances of the same
   * archetype with different instanceKeys are never merged. */
  instanceKey: string;
  nodeId?: string;
  rmType: string;
  /** The OPT's fixed `name/value` constraint for this C_ARCHETYPE_ROOT, if
   * any (e.g. "primary diagnosis") - the actual disambiguator, not a label. */
  nameConstraint?: string;
  path: string;
  occurrences: Occurrences;
  terminology: ArchetypeTerminology;
  fields: OpenEhrFieldDefinition[];
  /** Nested archetype instances (e.g. a CLUSTER embedded inside an
   * EVALUATION), each with their own independent instanceKey/terminology
   * scope. */
  children: ArchetypeInstanceDefinition[];
}

export interface TemplateConstraintModel {
  templateId: string;
  version?: string;
  defaultLanguage: string;
  languages: string[];
  archetypeInstances: ArchetypeInstanceDefinition[];
  terminologyIndex: OpenEhrTerminologyIndex;
  warnings: string[];
}

/** The stable composite field identity described in the architecture doc:
 * "field.id darf niemals nur nodeId sein" - always
 * `archetypeInstanceKey + '|' + relativePath`. */
export function canonicalFieldId(archetypeInstanceKey: string, relativePath: string): string {
  return `${archetypeInstanceKey}|${relativePath}`;
}

/** The stable composite archetype-instance identity: `archetypeId` alone
 * when unambiguous, `archetypeId|nameConstraint` when a fixed name/value
 * constraint disambiguates repeated same-archetype roots, or
 * `archetypeId#index` as a last-resort positional fallback when an
 * archetype repeats with no name constraint to key on at all (still
 * distinct instances, just not semantically named ones). */
export function canonicalInstanceKey(archetypeId: string, nameConstraint: string | undefined, index: number): string {
  if (nameConstraint) return `${archetypeId}|${nameConstraint}`;
  return index === 0 ? archetypeId : `${archetypeId}#${index}`;
}

// ---------------------------------------------------------------------------
// Typed runtime values - what a FormSession's `values` should hold per field,
// instead of untyped strings/booleans (see "Runtime-State typisieren").
// ---------------------------------------------------------------------------

export interface DvTextValue { _type: 'DV_TEXT'; value: string; }
export interface DvCodedTextValue {
  _type: 'DV_CODED_TEXT';
  value: string;
  defining_code: { terminology_id: { value: string }; code_string: string };
}
export interface DvBooleanValue { _type: 'DV_BOOLEAN'; value: boolean; }
export interface DvDateTimeValue { _type: 'DV_DATE_TIME'; value: string; }
export interface DvDateValue { _type: 'DV_DATE'; value: string; }
export interface DvTimeValue { _type: 'DV_TIME'; value: string; }
export interface DvCountValue { _type: 'DV_COUNT'; value: number; }
export interface DvQuantityValue { _type: 'DV_QUANTITY'; magnitude: number; units: string; }

export type RuntimeOpenEhrValue =
  | DvTextValue
  | DvCodedTextValue
  | DvBooleanValue
  | DvDateTimeValue
  | DvDateValue
  | DvTimeValue
  | DvCountValue
  | DvQuantityValue;
