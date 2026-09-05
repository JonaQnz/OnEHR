export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/** Shared machine-readable validation contract used by runtime, sessions and plugins. */
export type ValidationSeverity = 'info' | 'warning' | 'error';

export interface FormIssue {
  message: string;
  path?: string;
  severity?: ValidationSeverity;
  /** Where this issue's constraint comes from - determines whether it's
   * allowed to be non-blocking. 'template' issues are derived from the
   * openEHR archetype/template itself (e.g. DV_QUANTITY range/precision)
   * and describe genuinely valid data, so they're always error-severity in
   * practice; 'regex' and 'script' issues come from designer- or
   * script-authored rules and may freely be error/warning/info; 'server'
   * is reserved for terminology-server validation results (see
   * isBlockingIssue, packages/core/form-runtime). Absent for older/unknown
   * issue producers - treated the same as before this field existed. */
  source?: 'template' | 'regex' | 'script' | 'server';
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
    /** True when `min` is an exclusive lower bound (archetype range operator
     * '>' rather than '>='). Absent/false means inclusive, openEHR's own
     * default when a range has no explicit operator. */
    minexclusive?: boolean;
    /** Same as `minexclusive`, for `max` (archetype operator '<' vs '<='). */
    maxexclusive?: boolean;
    precision?: number;
  }>;
  /** An 'input-proportion' field's archetype-constrained PROPORTION_KIND
   * (openEHR RM data_types.html) - see ProportionKind's doc comment in
   * packages/core/openehr for what each value implies about the
   * denominator and numerator/denominator integer-ness. Absent means
   * unconstrained ('ratio' behavior: any numerator/denominator, still
   * subject to the universal "denominator ≠ 0" invariant). */
  proportionType?: 'ratio' | 'unitary' | 'percent' | 'fraction' | 'integer_fraction';
  options?: Array<{
    value: string;
    /** Display text, in the UI's preferred language (German-first - see
     * webTemplateParser's preferredOptionText). Never sent to openEHR as a
     * DV_CODED_TEXT's `value` - use `rmValue` for that. */
    text: string;
    /** The archetype's original/default-language term text for this code -
     * what EHRbase's FLAT-composition validator actually checks a submitted
     * DV_CODED_TEXT.value against, regardless of UI display language.
     * Absent when it's identical to `text` (e.g. an English-default
     * template with no separate translation). Read by openehr-engine's
     * setFlatValue/buildLeafDvValue in preference to `text` - see the
     * comment there for the live bug this fixes (a German `text` like
     * "Vermutet"/"Aktiv" being rejected by EHRbase, which expects
     * "Suspected"/"Active"). */
    rmValue?: string;
    /** This option's external terminology_id, for the (uncommon) case where
     * the archetype's own binding requires an external/hosted terminology
     * (e.g. a FHIR-published ValueSet) rather than openEHR's default local
     * archetype terminology. Absent for the vast majority of coded fields,
     * which correctly submit terminology_id "local" - only set this when
     * EHRbase's own validator rejects "local" for the field (see
     * openehr-engine's buildLeafDvValue/setFlatValue, which read this in
     * preference to defaulting to "local"). Live bug this fixes: vg_Person's
     * Vitalstatus field's archetype binding requires
     * terminology://fhir.hl7.org//ValueSet/$expand?url=.../ValueSet/Vitalstatus,
     * not "local" - EHRbase rejected every submission with "terminology_id
     * does not match" until each option carried this. */
    terminology?: string;
    /** DV_ORDINAL only (openEHR RM data_types.quantity 6.2.4): the
     * archetype-fixed integer this option's `value`/`text`/`rmValue`
     * (the ordinal's `symbol`, a full DV_CODED_TEXT) pairs with -
     * DV_ORDINAL.value is RM-mandatory (1..1), so a DV_ORDINAL option
     * with no `ordinal` here can never be submitted (see
     * buildLeafDvValue's DV_ORDINAL branch, openehr-engine). Absent for
     * every other option kind. */
    ordinal?: number;
  }>;
  /** True when this field's underlying openEHR constraint is a
   * DV_CODED_TEXT|DV_TEXT union (a coded value set with a genuine free-text
   * alternative, per the OPT constraint engine's ValueConstraint union -
   * see docs/features/opt-constraint-engine-analysis.md) - set at import
   * time from the constraint model. Absent/false preserves every existing
   * form's current behavior exactly (a value must match one of `options`).
   * When true, a value that doesn't match any option is accepted as free
   * text rather than rejected, AND (openehr-engine's setFlatValue) written
   * to EHRbase as a plain DV_TEXT rather than a bogus DV_CODED_TEXT whose
   * code_string would be that free text - the two must always change
   * together, never just the validation side alone. */
  allowFreeText?: boolean;
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
    /** How a `regex` mismatch is reported - defaults to 'error' (blocking,
     * unchanged behavior) when unset, so every regex already set before
     * this field existed keeps working exactly as before. 'warning'/'info'
     * make it non-blocking - shown at the field but doesn't prevent submit.
     * Named `regex*` (not the more generic `severity`/`message`) because
     * `validation` may later carry other kinds of constraints (required,
     * range, ...) whose severity this must not be confused with. */
    regexSeverity?: ValidationSeverity;
    /** Shown instead of the generic pattern-mismatch message when set. */
    regexMessage?: string;
  };
  unit?: string;
  /** The single per-node source of truth for this element's openEHR
   * identity - RM type, archetype node id, archetype id, paths, template
   * origin. Set on leaf DV_* field nodes AND on structural container nodes
   * (OBSERVATION/CLUSTER/SECTION/etc) alike, so the full tree carries real
   * openEHR identity, not just its leaves. See getElementMetadata() in
   * openehr-engine for the API that reads this - don't read/write this
   * field directly outside the parser/adapter that own it. */
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
  /** Never rendered to the user, in any mode - the field only carries a
   * fixed/derived value (defaultValue) straight through to submission.
   * For administrative/structural fields a clinician should never need to
   * see or edit (e.g. a name-use code the template requires but that
   * always has the same value). Distinct from `visibility` (a conditional
   * expression evaluated against other field values) and from a
   * composition's `hiddenFieldIds` (which deliberately never hides a
   * required field, because the user still has to fill it in themselves)
   * - this field's value is already decided at design time, so hiding it
   * is safe even when required. */
  alwaysHidden?: boolean;
  props?: Record<string, unknown>;
  /** Opt-in DV_TEXT.mappings support (openEHR RM: TERM_MAPPING, a list of
   * `{match, target: CODE_PHRASE}` entries attached to a text value without
   * changing the text itself - e.g. a free-text diagnosis description
   * additionally tagged with an ICD-10-GM code). Off by default, same
   * pattern as manualAdd on CompositionFormBlock - a designer opts a
   * specific DV_TEXT-bound field into this deliberately; every existing
   * field keeps behaving exactly as before. Distinct from DV_CODED_TEXT's
   * own `defining_code` (the value itself IS a coded term) - this is a
   * free-text value with independent, optional code attachment(s). */
  codeMappings?: CodeMappingConfig;
}

export interface CodeMappingTerminologyOption {
  /** Written verbatim as CODE_PHRASE.terminology_id - not a closed enum.
   * Real examples: "http://fhir.de/CodeSystem/dimdi/icd-10-gm", a local
   * catalog name like "0052 Diagnosetyp", or an application-specific id
   * like "condition.id". */
  id: string;
  /** Designer-facing label shown at runtime instead of the raw id - this
   * is the "hidden catalog": the clinician picks/sees only this short,
   * curated list, never types a raw terminology_id. */
  label: string;
  /** TERM_MAPPING.match - '>' broader, '=' equivalent, '<' narrower, '?'
   * unknown (ISO 2788/5964). Defaults to '=' when unset. */
  match?: '>' | '=' | '<' | '?';
  /** Which registered TerminologyProvider (packages/core/terminology) backs
   * this option, e.g. "hapi-terminology". Absent (the default for every
   * option that already existed before this field was added) means this
   * option keeps today's behavior exactly: a plain, unvalidated free-text
   * code entry against `id`/`label` alone - no search, no server-side
   * validation, no dependency on any terminology plugin being installed. */
  providerId?: string;
  /** The provider-neutral binding (e.g. a ValueSet, in a FHIR-backed
   * provider's own translation) this option searches/validates against -
   * see TerminologySearchInput/TerminologyValidateInput. Only meaningful
   * alongside `providerId`. */
  bindingId?: string;
  bindingVersion?: string;
  /** Set instead of/alongside `bindingId` when only a bare namespace (a
   * CodeSystem, in FHIR terms) is known, with no specific curated binding -
   * see TerminologySearchInput. */
  namespace?: string;
  namespaceVersion?: string;
  /** How a provider-backed code is enforced at submission - see
   * TerminologyValidationPolicy's own doc comment for the three levels.
   * Only meaningful alongside `providerId`; defaults to 'required' for a
   * newly configured binding. */
  validationPolicy?: 'required' | 'best-effort' | 'none';
}

export interface CodeMappingConfig {
  enabled: boolean;
  /** Which terminologies a clinician can attach a code from - always at
   * least one once enabled. */
  terminologies: CodeMappingTerminologyOption[];
  /** Whether more than one mapping entry can be added at runtime (the "+"
   * control). Defaults to true when unset - matches "code im form builder
   * erweiterbar... sodass wir mehr eingeben können". Set false to cap a
   * field at exactly one mapping. */
  allowMultiple?: boolean;
  /** Forces at least one real code mapping whenever the field itself has a
   * non-empty text value - free text alone no longer satisfies validation.
   * Off by default (every existing codeMappings field keeps its current,
   * text-is-enough behavior). Use this on a field where the attached code
   * is the whole point of collecting it (e.g. a diagnosis name that must
   * carry a real ICD-10-GM code for FHIR export to be meaningful), not
   * merely a nice-to-have annotation. Never applies before the field has a
   * value at all - an empty optional field is still governed by `required`
   * alone. */
  requireMapping?: boolean;
}

/** One DV_TEXT.mappings entry as the runtime actually stores/submits it -
 * deliberately no `text`/`preferred_term`: the parent field's own text
 * value already carries the human-readable rendition (see real-world
 * example compositions), a mapping only ever adds `{match, target}`. */
export interface CodeMappingValue {
  terminologyId: string;
  code: string;
  match?: '>' | '=' | '<' | '?';
  /** Set when this code came from a versioned terminology binding (an
   * ICD-10-GM/OPS year version, a published custom-terminology version) -
   * see packages/core/terminology's TerminologyProvider doc comment for why
   * this must be threaded through consistently: a later change to the
   * terminology server must never silently change the meaning of an
   * already-stored coding. Absent for the pre-existing, unversioned
   * free-text case. */
  version?: string;
  /** A snapshot of the display text shown at selection time - kept even if
   * the terminology server later becomes unreachable or the concept's
   * display text changes upstream. Absent for the pre-existing, plain
   * free-text case (where the parent field's own text already carries the
   * human-readable rendition, per this type's own top-level doc comment). */
  display?: string;
}

/** A DV_TEXT field's runtime value once codeMappings.enabled - the plain
 * text stays in `value`, mappings ride alongside without disturbing it. A
 * field with codeMappings.enabled but no mappings entered yet still stores
 * a plain string (mappings omitted, not an empty array) - see
 * form-runtime's toDescriptor/collectRuntimeFields. */
export interface CodeMappedTextValue {
  value: string;
  mappings?: CodeMappingValue[];
}

/**
 * Layout node `type`s that are structural/decorative, never a real data
 * field - excluded from both `form-runtime`'s `collectRuntimeFields` (what
 * the runtime validates/initializes) and `form-scripting`'s `isDataField`
 * (what a generated Form Script's FieldId type includes).
 *
 * QA review finding: these two consumers used to each hand-maintain their
 * own copy of this list, and had already drifted apart (form-scripting's
 * copy was missing 'button', only incidentally still correct because it
 * separately excludes buttons via its own isButton() check). If a layout
 * type is ever added to one list and not the other, generated Form Script
 * FieldId types and runtime validation silently disagree about what
 * counts as a field - the same class of gap that caused the Matrix-widget
 * display-type bug (a display value existing in one enum copy but not
 * its duplicate elsewhere). One shared list instead.
 */
export const NON_FIELD_LAYOUT_TYPES = new Set([
  'form',
  'container',
  'row',
  'column',
  'header',
  'paragraph',
  'line-break',
  'button',
  'section',
  'tab',
  'alert',
  'text',
]);

/**
 * The single consolidated openEHR identity record for one form element -
 * leaf field or structural container alike. `path` is EHRbase's own
 * WebTemplate aqlPath, verbatim (it already *is* the AQL path in openEHR's
 * own terminology, despite the historical field name); `flatPath` is the
 * WebTemplate's id-based technical/flat submission path. The archetype
 * path is not a separately stored field - openehr-engine's
 * getArchetypePath() derives it from `path` on demand, since it never
 * disagrees with `path`, only strips its template/composition-level
 * prefix.
 */
export interface OpenEhrBinding {
  templateAlias: string;
  path: string;
  rmType: string;
  flatPath?: string;
  /** This node's own archetype node id, e.g. "at0004". Extracted once at
   * WebTemplate parse time (see openehr-engine's parseOpenEhrAqlPath) -
   * never derive this ad hoc elsewhere. */
  archetypeNodeId?: string;
  /** The archetype id nearest-enclosing this node, e.g.
   * "openEHR-EHR-OBSERVATION.blood_pressure.v2". */
  archetypeId?: string;
  /** archetypeId's trailing ".vN", extracted once alongside it. */
  rmVersion?: string;
  /** Which template this specific binding was resolved against - relevant
   * once a form can bind fields from more than one sourceTemplates entry. */
  templateId?: string;
  templateVersion?: string;
}

export interface FormError extends Omit<ValidationIssue, 'source'> {
  fieldId?: string;
  openEhrPath?: string;
  /** Which subsystem raised this error - a different, unrelated concept
   * from ValidationIssue.source (which distinguishes template/regex/
   * script/server-derived *validation* issues); named `errorSource` here
   * to avoid colliding with that field now that both live under
   * ValidationIssue. */
  errorSource: 'runtime' | 'validation' | 'script' | 'plugin' | 'openehr' | 'provider' | 'host';
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
  /** Whether LiveForm.tsx's debounced draft autosave runs at all for this
   * form. Unset defers to the connection-wide `autosaveEnabledByDefault`
   * (itself defaulting to `true` - unchanged behavior). The manual "Entwurf
   * speichern" action is unaffected either way. */
  autosaveEnabled?: boolean;
  /** Milliseconds of editing pause before the debounced draft autosave
   * fires. Unset defers to the connection-wide `autosaveDebounceMsDefault`
   * (itself defaulting to `2500` - unchanged behavior). */
  autosaveDebounceMs?: number;
  /** Whether saving a draft (autosaveFormSessionDraft - both the debounced
   * autosave and the manual "Entwurf speichern" button call the same
   * backend action) also pushes to the session's data provider (e.g. a real
   * EHRbase composition version with lifecycle_state=incomplete), or stays
   * purely local (Forms' own DB only) until the user finally submits. Unset
   * defers to the connection-wide `pushDraftsToProviderByDefault` (itself
   * defaulting to `true` - unchanged behavior). Never affects the final
   * submit, which always pushes regardless of this setting. */
  pushDraftsToProvider?: boolean;
  /** Whether creating a session for this Form Section fetches its patient's
   * latest submitted Composition from the provider (EHRbase) to populate a
   * form script's read-only `context.composition` - independent of, and
   * unconditional on, the launch's own `load` policy ('never' included).
   * Unset (the default, `true`) is unchanged behavior. A Form Section whose
   * scripts never read `context.composition` can set this to `false` to
   * skip that provider round-trip entirely - on a Composition with several
   * blocks per page, each one otherwise pays this cost on every launch
   * regardless of whether it's ever used. */
  loadLatestCompositionContext?: boolean;
}

/** "Aus vorheriger Dokumentation übernehmen" - lets the runtime offer a
 * dropdown of this patient's own previously submitted entries of this same
 * Form Section, so a clinician can 1:1 copy an earlier entry's values into a
 * new one instead of retyping (e.g. picking up a previously documented
 * diagnosis when starting a new discharge letter). `summaryFieldIds` is the
 * curated subset of field ids whose values become that dropdown's label -
 * order preserved, values only (never labels) per entry, joined with " · ".
 * Empty/unset falls back to an auto-derived "Label: value" summary instead. */
export interface FormReuseSettings {
  enabled?: boolean;
  summaryFieldIds?: string[];
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
    reuse?: FormReuseSettings;
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
