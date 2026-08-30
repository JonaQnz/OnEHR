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
}

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
