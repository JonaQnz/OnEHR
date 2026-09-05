import { NON_FIELD_LAYOUT_TYPES, type CanonicalForm, type CodeMappingConfig, type FormElementLayout, type JsonPrimitive, type JsonValue, type ValidationIssue } from '../canonical';
import type { ProportionKind } from '../openehr';

export type RuntimePrimitive = JsonPrimitive;
export type RuntimeJsonValue = JsonValue;
export type RuntimeValue = JsonValue | undefined;
export type RuntimeValues = Record<string, RuntimeValue>;

/** rmValue: the archetype's original/default-language term text for this
 * code - what openehr-engine's serializers must write into a submitted
 * DV_CODED_TEXT.value (EHRbase validates against it regardless of `text`'s
 * display language). Absent when identical to `text`. See
 * FormElementLayout.options[].rmValue (packages/core/canonical) for the
 * live bug this exists to fix.
 *
 * terminology: see FormElementLayout.options[].terminology (packages/core/canonical) -
 * this option's external terminology_id, for the uncommon case where the
 * archetype requires a hosted terminology rather than openEHR's default
 * "local". */
export interface RuntimeOption {
  value: string; text: string; rmValue?: string; terminology?: string;
  /** DV_ORDINAL only: the archetype-fixed integer this option's `symbol`
   * pairs with (RM: DV_ORDINAL.value, 1..1 - see
   * FormElementLayout.options[].ordinal, packages/core/canonical). Absent
   * for every other option kind (DV_CODED_TEXT/CODE_PHRASE selects never
   * have one). */
  ordinal?: number;
}
export interface RuntimeUnitOption { unit: string; min?: number; max?: number; minexclusive?: boolean; maxexclusive?: boolean; precision?: number; }
// See ProportionKind's doc comment (packages/core/openehr) for what each
// kind means - this is where that meaning is actually enforced, in
// validateOne's 'input-proportion' branch below.
const PROPORTION_KIND_DENOMINATOR: Partial<Record<ProportionKind, number>> = { unitary: 1, percent: 100 };
export interface RuntimeFieldDescriptor {
  id: string; name: string; type: string; label: string; description?: string | undefined;
  required: boolean; readOnly: boolean; options: RuntimeOption[]; unitOptions: RuntimeUnitOption[];
  validation?: { min?: number; max?: number; regex?: string; regexSeverity?: 'error' | 'warning' | 'info'; regexMessage?: string } | undefined; visibility?: unknown;
  repeatable: boolean; repeatMin: number; repeatMax: number; defaultValue?: RuntimeJsonValue | undefined;
  repeatableGroupId?: string | undefined;
  aqlPath?: string | undefined; binding?: unknown; semanticType?: string | undefined; archetypeNodeId?: string | undefined;
  /** Never rendered, in any mode - see FormElementLayout.alwaysHidden. */
  alwaysHidden: boolean;
  /** See FormElementLayout.codeMappings - opt-in DV_TEXT.mappings support. */
  codeMappings?: CodeMappingConfig | undefined;
  /** See FormElementLayout.allowFreeText - a DV_CODED_TEXT|DV_TEXT union;
   * a value not matching any `options` entry is free text, not an error. */
  allowFreeText: boolean;
  /** See ProportionKind - only meaningful for field.type === 'input-proportion'. */
  proportionType?: ProportionKind | undefined;
  /** See FormElementLayout.numberRange - a DV_COUNT/DV_INTEGER/DV_DECIMAL
   * field's own archetype-derived magnitude range/precision (P0.1 audit,
   * 2026-09-05). Deliberately separate from `validation.min/max` above:
   * that pair is a designer-configured Block-1 rule (regex-editor family),
   * while this is read-only, straight from the WebTemplate's own
   * constraint - conflating the two would make a hand-set designer rule
   * indistinguishable from (and silently overridable by) the archetype's
   * own limit, and `validation` has no precision/exclusive-bound concept
   * at all. Only meaningful for field.type === 'input-number'. */
  numberRange?: { min?: number; max?: number; minexclusive?: boolean; maxexclusive?: boolean; precision?: number } | undefined;
}
export interface RuntimeGroupDescriptor {
  id: string;
  label: string;
  repeatMin: number;
  repeatMax: number;
  /** The immediately-enclosing repeatable group's own id, when this group
   * is nested inside another one - undefined for a top-level group (P0.2
   * audit, 2026-09-05: nested repeats - "Repeat innerhalb Repeat" - were a
   * confirmed total gap before this; see
   * [[p02-repeatables-audit-and-first-fixes]]). A NESTED group's own rows
   * live inside each of its parent's row objects (`parentRow[group.id]`),
   * never at `values[group.id]` directly - this is what lets
   * createInitialRuntimeValues/validateRuntimeValues walk the group
   * hierarchy correctly instead of always looking at the top level, which
   * is exactly the bug this fixes. `walk()`'s own `repeatableGroupId`
   * parameter, read BEFORE it gets overwritten for this node's own
   * children, already carries exactly this value - collectRuntimeGroups
   * just needed to keep it instead of discarding it. */
  parentGroupId?: string;
}
export interface RuntimeValidationIssue extends ValidationIssue {
  path: string;
  code: 'required' | 'type' | 'min' | 'max' | 'option' | 'unit' | 'pattern' | 'repeat-min' | 'repeat-max' | 'mapping-required' | 'mapping-invalid' | 'quantity-range' | 'quantity-precision' | 'number-range' | 'number-precision' | 'proportion-denominator' | 'proportion-type' | 'duration-format' | 'interval-order' | 'interval-unit-mismatch' | 'script';
}
export interface RuntimeValidationResult { valid: boolean; issues: RuntimeValidationIssue[]; }

// Moved to canonical/index.ts as NON_FIELD_LAYOUT_TYPES (QA review
// finding: this was hand-duplicated with form-scripting's own separate
// copy, and the two had already drifted apart) - imported above.
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const nodeId = (node: FormElementLayout): string | undefined => node.id || node.name;

type RuntimeLocales = CanonicalForm['locales'] | undefined;

// A form generated without a parsed WebTemplate layout (see
// formGenerator.ts's fallback path) never writes a `label` onto its layout
// nodes at all - only `type` and `name` - because at that point all it has
// is a flat field registry, not a real tree. Its human-readable labels are
// written to `locales.en[[name='<fieldName>']].label` instead (the same
// `[name='...']` selector convention the FormBuilder designer's own canvas
// already resolves through - see formBuilderAdapter.ts's `labelSelector`).
// Without this lookup, collectRuntimeFields/collectRuntimeGroups fell back
// straight to the internal field name (or raw id) for any such form, which
// is what actually rendered in the Live Form.
//
// node.label wins when present, unlike formBuilderAdapter.ts's own
// locale-first order: locales.en is regenerated wholesale from the canvas on
// every designer save, but nothing keeps it in sync with a node.label that
// was set some other way (e.g. a direct API edit) - live data has forms
// where the two have drifted apart. Preferring node.label here can't be
// wrong when it's present; it's only ever absent in the fallback case this
// exists for, where locale is the sole source anyway.
function resolveLabel(node: FormElementLayout, id: string, locales: RuntimeLocales): string {
  const name = node.name || id;
  return node.label || locales?.en?.[`[name='${name}']`]?.label || name;
}

function walk(node: FormElementLayout, visit: (node: FormElementLayout, repeatableGroupId?: string) => void, repeatableGroupId?: string): void {
  visit(node, repeatableGroupId);
  const childGroupId = node.type === 'container' && node.repeatable === true && nodeId(node)
    ? nodeId(node)
    : repeatableGroupId;
  node.children?.forEach((child) => walk(child, visit, childGroupId));
}

function toDescriptor(node: FormElementLayout, locales: RuntimeLocales, repeatableGroupId?: string): RuntimeFieldDescriptor {
  const id = nodeId(node) as string;
  const defaultValue = node.defaultValue !== undefined ? node.defaultValue : node.default_value;
  return {
    id, name: node.name || id, type: node.type, label: resolveLabel(node, id, locales),
    description: node.description || node.helpText, required: node.required === true, readOnly: node.readOnly === true,
    options: (node.options || []).map((option) => ({
      value: String(option.value),
      text: String(option.text),
      ...(option.rmValue ? { rmValue: String(option.rmValue) } : {}),
      ...(option.terminology ? { terminology: String(option.terminology) } : {}),
      ...(typeof option.ordinal === 'number' ? { ordinal: option.ordinal } : {}),
    })),
    allowFreeText: node.allowFreeText === true,
    unitOptions: (node.unitOptions || []).map((option) => typeof option === 'string' ? { unit: option } : { ...option }),
    ...(node.proportionType ? { proportionType: node.proportionType } : {}),
    ...(node.numberRange ? { numberRange: node.numberRange } : {}),
    validation: node.validation, visibility: node.visibility ?? node.enableWhen,
    repeatable: node.repeatable === true, repeatMin: node.repeatMin ?? 0, repeatMax: node.repeatMax ?? -1,
    ...(repeatableGroupId ? { repeatableGroupId } : {}),
    // node.binding.path IS the AQL path (EHRbase's own WebTemplate aqlPath,
    // verbatim) - previously this read three properties that were never
    // actually set on FormElementLayout (dead code); binding is the real,
    // and now only, source.
    aqlPath: node.binding?.path,
    binding: node.binding, semanticType: node.binding?.rmType, archetypeNodeId: node.binding?.archetypeNodeId,
    alwaysHidden: node.alwaysHidden === true,
    ...(defaultValue !== undefined ? { defaultValue: defaultValue as RuntimeJsonValue } : {}),
    ...(node.codeMappings?.enabled ? { codeMappings: node.codeMappings } : {}),
  };
}

export function collectRuntimeFields(form: Pick<CanonicalForm, 'layout' | 'locales'>): RuntimeFieldDescriptor[] {
  const fields: RuntimeFieldDescriptor[] = [];
  walk(form.layout, (node, repeatableGroupId) => {
    if (nodeId(node) && !NON_FIELD_LAYOUT_TYPES.has(node.type)) fields.push(toDescriptor(node, form.locales, repeatableGroupId));
  });
  return fields;
}

/** One field's current value as short human-readable text - coded options
 * resolved to their label, DV_QUANTITY as "magnitude unit", booleans as
 * Ja/Nein, everything else via String(). Empty/undefined/empty-array values
 * always resolve to "" so callers can filter them out uniformly. */
export function formatRuntimeValue(field: Pick<RuntimeFieldDescriptor, 'type' | 'options' | 'codeMappings'>, value: RuntimeValue): string {
  if (field.codeMappings?.enabled && isRecord(value)) value = (value as Record<string, unknown>).value as RuntimeValue;
  if (value === undefined || value === null || value === '') return '';
  if (Array.isArray(value)) {
    if (value.length === 0) return '';
    return value.map((item) => (field.options.length > 0 ? field.options.find((option) => option.value === item)?.text || String(item) : String(item))).join(', ');
  }
  if (field.options.length > 0 && (typeof value === 'string' || typeof value === 'number')) {
    return field.options.find((option) => option.value === String(value))?.text || String(value);
  }
  if (field.type === 'input-quantity' && typeof value === 'object' && value !== null) {
    const quantity = value as Record<string, unknown>;
    if (quantity.magnitude === undefined || quantity.magnitude === null || quantity.magnitude === '') return '';
    return quantity.unit ? `${quantity.magnitude} ${quantity.unit}` : String(quantity.magnitude);
  }
  if (field.type === 'input-boolean') return value === true ? 'Ja' : value === false ? 'Nein' : '';
  return String(value);
}

/** A short, one-line text summary of `values` for display in a dropdown
 * option or a compact/collapsed card - e.g. "Diagnose: Invasives
 * Mammakarzinom links · Diagnosekategorie: Principal diagnosis · Schweregrad:
 * Severe". With `fieldIds` given (a form's `settings.reuse.summaryFieldIds`),
 * renders exactly those fields, in that order - the curated case the
 * clinician configured on purpose. Without it, falls back to the first few
 * non-empty fields instead, so a compact view is never fully blank just
 * because nobody configured anything yet. Every part is always "Label:
 * value" - without the label a bare "Severe" or a name on its own reads as
 * cryptic once several fields are shown together. Fields with no value (or
 * not found) are silently skipped, never rendered as an empty slot. */
export function summarizeRuntimeValues(
  form: Pick<CanonicalForm, 'layout' | 'locales'>,
  values: RuntimeValues,
  fieldIds?: string[],
  options?: { separator?: string; maxFields?: number },
): string {
  const fields = collectRuntimeFields(form);
  const byId = new Map(fields.map((field) => [field.id, field]));
  const curated = Boolean(fieldIds && fieldIds.length > 0);
  const separator = options?.separator ?? ' · ';
  const candidateIds = curated ? (fieldIds as string[]) : fields.filter((field) => !field.repeatableGroupId).map((field) => field.id);
  const maxFields = options?.maxFields ?? (curated ? candidateIds.length : 4);
  const parts: string[] = [];
  for (const id of candidateIds) {
    const field = byId.get(id);
    if (!field) continue;
    const formatted = formatRuntimeValue(field, values[id]);
    if (!formatted) continue;
    parts.push(`${field.label}: ${formatted}`);
    if (parts.length >= maxFields) break;
  }
  return parts.join(separator);
}

export function collectRuntimeGroups(form: Pick<CanonicalForm, 'layout' | 'locales'>): RuntimeGroupDescriptor[] {
  const groups: RuntimeGroupDescriptor[] = [];
  // The `parentGroupId` parameter here is `walk()`'s own repeatableGroupId
  // AS PASSED IN for this node - i.e. whichever group (if any) already
  // enclosed this node BEFORE walk() computes childGroupId for this node's
  // OWN descendants. Exactly the enclosing group's id when this node is
  // itself a nested repeatable container.
  walk(form.layout, (node, parentGroupId) => {
    const id = nodeId(node);
    if (node.type === 'container' && node.repeatable === true && id) {
      groups.push({
        id,
        label: resolveLabel(node, id, form.locales),
        repeatMin: node.repeatMin ?? 0,
        repeatMax: node.repeatMax ?? -1,
        ...(parentGroupId ? { parentGroupId } : {}),
      });
    }
  });
  return groups;
}

export function createInitialRuntimeValues(form: Pick<CanonicalForm, 'layout' | 'locales'>): RuntimeValues {
  const values: RuntimeValues = {};
  const fields = collectRuntimeFields(form);
  const groups = collectRuntimeGroups(form);
  // Keyed by parentGroupId (undefined = top-level) / repeatableGroupId
  // (undefined = not inside any group) - lets a NESTED group's own default
  // rows be generated inside each of its parent's freshly-created rows,
  // recursively, instead of always at the top level regardless of nesting
  // (P0.2 audit, 2026-09-05 - see RuntimeGroupDescriptor.parentGroupId's
  // doc comment for the full writeup of the bug this fixes).
  const groupsByParent = new Map<string | undefined, RuntimeGroupDescriptor[]>();
  groups.forEach((group) => {
    const list = groupsByParent.get(group.parentGroupId);
    if (list) list.push(group); else groupsByParent.set(group.parentGroupId, [group]);
  });
  const fieldsByGroup = new Map<string | undefined, RuntimeFieldDescriptor[]>();
  fields.forEach((field) => {
    const list = fieldsByGroup.get(field.repeatableGroupId);
    if (list) list.push(field); else fieldsByGroup.set(field.repeatableGroupId, [field]);
  });
  // Builds `group.repeatMin` fresh rows into `scope[group.id]` - each row
  // is a brand-new object literal, so an array-typed default
  // (`[field.defaultValue]` for a repeatable sub-field) is naturally a
  // fresh array per row with no further cloning needed (the previous
  // version built one shared `itemDefaults` object first and had to
  // defensively re-clone its array-valued entries per row - functionally
  // the same outcome, this just never creates the shared reference in the
  // first place). Recurses into any group nested directly inside this one.
  function populateGroup(group: RuntimeGroupDescriptor, scope: Record<string, RuntimeValue>): void {
    const directFields = fieldsByGroup.get(group.id) || [];
    const nestedGroups = groupsByParent.get(group.id) || [];
    scope[group.id] = Array.from({ length: group.repeatMin }, () => {
      const row: Record<string, RuntimeValue> = {};
      directFields.forEach((field) => {
        if (field.defaultValue === undefined) return;
        row[field.id] = field.repeatable ? [field.defaultValue] : field.defaultValue;
      });
      nestedGroups.forEach((nested) => populateGroup(nested, row));
      return row;
    }) as RuntimeValue;
  }
  (groupsByParent.get(undefined) || []).forEach((group) => populateGroup(group, values));
  fields.forEach((field) => {
    if (field.repeatableGroupId || field.defaultValue === undefined) return;
    values[field.id] = field.repeatable ? [field.defaultValue] : field.defaultValue;
  });
  return values;
}

function sameValue(actual: RuntimeValue, expected: unknown): boolean {
  return Array.isArray(actual) ? actual.some((item) => sameValue(item, expected)) : actual === expected;
}

function evaluate(condition: unknown, values: RuntimeValues): boolean {
  if (condition === undefined || condition === null || typeof condition === 'boolean') return condition !== false;
  if (!isRecord(condition)) return true;
  if (Array.isArray(condition.all)) return condition.all.every((item) => evaluate(item, values));
  if (Array.isArray(condition.any)) return condition.any.some((item) => evaluate(item, values));
  if (condition.not !== undefined) return !evaluate(condition.not, values);
  const nested = isRecord(condition.when) ? condition.when : condition;
  const source = nested.fieldId ?? nested.field ?? nested.path;
  if (typeof source !== 'string') return true;
  const actual = values[source];
  if (nested.exists === true) return actual !== undefined && actual !== null && actual !== '';
  if (nested.exists === false) return actual === undefined || actual === null || actual === '';
  if ('equals' in nested) return sameValue(actual, nested.equals);
  if ('value' in nested) return sameValue(actual, nested.value);
  return true;
}

export function isRuntimeFieldVisible(field: RuntimeFieldDescriptor, values: RuntimeValues): boolean {
  return evaluate(field.visibility, values);
}

const empty = (value: RuntimeValue): boolean => value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : undefined);
}

function numericValue(field: RuntimeFieldDescriptor, value: RuntimeValue): number | undefined {
  if (field.type === 'input-quantity') {
    if (!isRecord(value)) return undefined;
    return asNumber(value.magnitude);
  }
  // A DV_PROPORTION runtime value is {numerator, denominator?} (mirrors
  // input-quantity's {magnitude, unit} shape) - `denominator` is omitted
  // by the single-field widget for the common 'percent'/'unitary' kinds
  // (implied by field.proportionType, see PROPORTION_KIND_DENOMINATOR),
  // present for 'ratio'/'fraction'/'integer_fraction' where it genuinely
  // varies. This function only ever needs the numerator - see
  // proportionDenominator() below for the (possibly-implied) denominator.
  if (field.type === 'input-proportion') {
    if (!isRecord(value)) return undefined;
    return asNumber(value.numerator);
  }
  if (['input-number', 'input-range'].includes(field.type)) return asNumber(value);
  return undefined;
}

/** The effective denominator for a DV_PROPORTION value: whatever was
 * explicitly supplied, or the one PROPORTION_KIND_DENOMINATOR implies for
 * field.proportionType ('unitary' => 1, 'percent' => 100) when none was.
 * Returns undefined only for 'ratio'/'fraction'/'integer_fraction'/
 * unknown-type with no explicit denominator - those kinds have no implied
 * value, so a missing denominator is a real gap, not something to default. */
function proportionDenominator(field: RuntimeFieldDescriptor, value: RuntimeValue): number | undefined {
  const explicit = isRecord(value) ? asNumber(value.denominator) : undefined;
  if (explicit !== undefined) return explicit;
  return field.proportionType ? PROPORTION_KIND_DENOMINATOR[field.proportionType] : undefined;
}

/** Every issue validateOne/the repeat-group checks below produce is derived
 * from the openEHR archetype/template (RM type shape, DV_QUANTITY
 * range/precision, PROPORTION_KIND, repeat cardinality, ...) and so
 * defaults to `source: 'template'` - the one exception is the designer-
 * authored regex pattern check, which passes its own `source: 'regex'`
 * explicitly. See ValidationIssue.source's doc comment (canonical) for why
 * this distinction matters: only regex/script issues may be non-blocking. */
function issue(issues: RuntimeValidationIssue[], path: string, code: RuntimeValidationIssue['code'], message: string, opts?: { severity?: RuntimeValidationIssue['severity']; source?: RuntimeValidationIssue['source'] }): void {
  issues.push({ path, code, message, source: opts?.source ?? 'template', ...(opts?.severity ? { severity: opts.severity } : {}) });
}

/** Number of fractional digits `n` was actually written with - used to
 * check a DV_QUANTITY magnitude against its unit's `precision` (archetype
 * DV_QUANTITY.precision: max decimal places allowed for that unit, e.g.
 * "1/d" is precision 0 - a whole number of doses per day, never "2.5"). A
 * plain string-based digit count rather than epsilon/rounding math -
 * good enough for a warning-level check on a value that came from a form
 * input, not a computed float with representation noise. Scientific
 * notation (astronomically small/large magnitudes) falls back to a fixed
 * expansion so it isn't miscounted as precision 0. */
function fractionalDigits(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const text = Math.abs(n) < 1e-6 || Math.abs(n) >= 1e21 ? n.toFixed(20).replace(/0+$/, '') : n.toString();
  const fraction = text.split('.')[1];
  return fraction ? fraction.length : 0;
}

/** A codeMappings.enabled field's runtime value is `{value, mappings?}`
 * (CodeMappedTextValue) instead of a plain string - the mappings are
 * optional annotation (openEHR RM: DV_TEXT.mappings is 0..*), so
 * required/type/pattern checks below apply to the text itself, exactly as
 * for any other text field. A clinician who fills in only a code and
 * leaves the text blank still trips `required` - the mapping never
 * satisfies it on the text's behalf. */
function unwrapCodeMappedValue(field: RuntimeFieldDescriptor, value: RuntimeValue): RuntimeValue {
  if (!field.codeMappings?.enabled || !isRecord(value)) return value;
  return (value as Record<string, unknown>).value as RuntimeValue;
}

/** DV_DURATION.value is "ISO8601 duration" (RM Data Types IM §6.3), but
 * with an explicit, spec-documented deviation from strict ISO 8601: *"the
 * 'W' designator [may be] mixed with other designators"* - strict ISO 8601
 * only allows `P<n>W` on its own (never `P1Y2W3D`), so a regex copied
 * verbatim from a generic ISO-8601 library would reject values this RM type
 * explicitly permits. Built from the RM's own designator set, not an
 * archetype constraint (see docs/features/rm-type-spec-conformance.md #3) -
 * unlike DV_QUANTITY's per-unit range, there is no legacy-data risk to a
 * hard block here: no valid DV_DURATION string was ever excluded by this
 * pattern, so a non-match is a genuine wire-format defect, not archetype
 * drift. `P`/`PT` alone (no designators at all) are rejected via the
 * lookaheads - ISO 8601 requires at least one component. No leading sign is
 * included - the RM Data Types IM text for DV_DURATION never mentions a
 * signed form, so that's not asserted here without a spec citation. */
const DV_DURATION_PATTERN = /^P(?!$)(\d+Y)?(\d+M)?(\d+W)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/;

/** One bound (`lower` or `upper`) of an 'input-interval' field's
 * {lower?, upper?} value - each bound is itself exactly a DV_QUANTITY's own
 * {magnitude, unit} shape, so this deliberately mirrors validateOne's
 * 'input-quantity' branch's unit/range/precision checks rather than
 * inventing a different rule set for the same underlying RM type. Returns
 * the parsed {magnitude, unit} when the bound is present and valid, or
 * undefined when the bound is simply absent (not itself an error - an
 * open-ended interval is valid RM, see the 'input-interval' branch below) -
 * callers distinguish "absent" from "present but invalid" by checking
 * whether any issues were pushed. */
function validateIntervalBound(field: RuntimeFieldDescriptor, bound: unknown, path: string, issues: RuntimeValidationIssue[], boundLabel: 'lower' | 'upper'): { magnitude: number; unit?: string } | undefined {
  if (empty(bound as RuntimeValue)) return undefined;
  // A bound that only ever picked up a unit (the shared unit selector - see
  // FormRuntime.tsx's 'input-interval' widget - writes {unit} onto both
  // bounds unconditionally, even one whose magnitude is still blank, so
  // "pick the unit first, then type the numbers" doesn't feel broken) is
  // not yet worth validating - not an error, just genuinely incomplete.
  // `required`'s own check (in the 'input-interval' branch below) already
  // catches "neither bound has a magnitude at all" for a required field;
  // a magnitude-less bound with only a unit set is treated the same as a
  // completely untouched one here.
  if (isRecord(bound) && empty(bound.magnitude as RuntimeValue)) return undefined;
  if (!isRecord(bound) || typeof asNumber(bound.magnitude) !== 'number' || !Number.isFinite(asNumber(bound.magnitude))) {
    issue(issues, path, 'type', `${field.label}: the ${boundLabel} bound requires a numeric quantity.`);
    return undefined;
  }
  const magnitude = asNumber(bound.magnitude) as number;
  const unit = bound.unit;
  if (field.unitOptions.length > 0 && (typeof unit !== 'string' || !unit)) {
    issue(issues, path, 'unit', `${field.label}: the ${boundLabel} bound requires a unit.`);
  } else if (field.unitOptions.length > 0 && typeof unit === 'string' && !field.unitOptions.some((option) => option.unit === unit)) {
    issue(issues, path, 'unit', `${field.label}: the ${boundLabel} bound has an unsupported unit.`);
  } else if (typeof unit === 'string') {
    const option = field.unitOptions.find((candidate) => candidate.unit === unit);
    if (option) {
      if (option.min !== undefined) {
        const belowMin = option.minexclusive ? magnitude <= option.min : magnitude < option.min;
        if (belowMin) issue(issues, path, 'quantity-range', `${field.label}: the ${boundLabel} bound ${magnitude} ${unit} is below the archetype's allowed minimum (${option.minexclusive ? '>' : '>='} ${option.min}).`, { severity: 'error' });
      }
      if (option.max !== undefined) {
        const aboveMax = option.maxexclusive ? magnitude >= option.max : magnitude > option.max;
        if (aboveMax) issue(issues, path, 'quantity-range', `${field.label}: the ${boundLabel} bound ${magnitude} ${unit} is above the archetype's allowed maximum (${option.maxexclusive ? '<' : '<='} ${option.max}).`, { severity: 'error' });
      }
      if (option.precision !== undefined && fractionalDigits(magnitude) > option.precision) {
        issue(issues, path, 'quantity-precision', `${field.label}: the ${boundLabel} bound's unit ${unit} allows at most ${option.precision} decimal place(s), got ${magnitude}.`, { severity: 'error' });
      }
    }
  }
  return { magnitude, ...(typeof unit === 'string' ? { unit } : {}) };
}

function validateOne(field: RuntimeFieldDescriptor, rawValue: RuntimeValue, path: string, issues: RuntimeValidationIssue[]): void {
  const value = unwrapCodeMappedValue(field, rawValue);
  if (empty(value)) { if (field.required) issue(issues, path, 'required', `${field.label} is required.`); return; }
  if (field.type === 'input-quantity') {
    const magnitude = numericValue(field, value);
    // Was `magnitude === undefined` - numericValue()/asNumber() returns
    // NaN, not undefined, for a non-numeric magnitude string (e.g.
    // {magnitude: 'abc'}), so that check silently let a genuinely invalid
    // quantity through as long as the value was an object at all. A bare
    // non-object value (magnitude missing an object wrapper entirely, e.g.
    // a plain string) was already caught by !isRecord(value) above it -
    // this only ever missed the "wrapped but garbage inside" case.
    if (!isRecord(value) || typeof magnitude !== 'number' || !Number.isFinite(magnitude)) { issue(issues, path, 'type', `${field.label} requires a numeric quantity.`); return; }
    const unit = value.unit;
    if (field.unitOptions.length > 0 && (typeof unit !== 'string' || !unit)) issue(issues, path, 'unit', `${field.label} requires a unit.`);
    else if (field.unitOptions.length > 0 && typeof unit === 'string' && !field.unitOptions.some((option) => option.unit === unit)) issue(issues, path, 'unit', `${field.label} has an unsupported unit.`);
    // Per-unit magnitude range/precision, straight from the archetype's own
    // DV_QUANTITY constraint (see webTemplateParser's unitOptions
    // extraction) - a warning, not a hard block: these limits weren't
    // enforced at all before this was wired up (see formGenerator.ts's
    // sibling fix), so a lot of already-submitted clinical data predates
    // them and must never be retroactively treated as invalid. Only
    // checked once the unit itself is a recognized option - an
    // already-flagged unrecognized unit has no matching range to check.
    else if (typeof unit === 'string') {
      const option = field.unitOptions.find((candidate) => candidate.unit === unit);
      if (option) {
        if (option.min !== undefined) {
          const belowMin = option.minexclusive ? magnitude <= option.min : magnitude < option.min;
          if (belowMin) issue(issues, path, 'quantity-range', `${field.label}: ${magnitude} ${unit} is below the archetype's allowed minimum (${option.minexclusive ? '>' : '>='} ${option.min}).`, { severity: 'error' });
        }
        if (option.max !== undefined) {
          const aboveMax = option.maxexclusive ? magnitude >= option.max : magnitude > option.max;
          if (aboveMax) issue(issues, path, 'quantity-range', `${field.label}: ${magnitude} ${unit} is above the archetype's allowed maximum (${option.maxexclusive ? '<' : '<='} ${option.max}).`, { severity: 'error' });
        }
        if (option.precision !== undefined && fractionalDigits(magnitude) > option.precision) {
          issue(issues, path, 'quantity-precision', `${field.label}: ${unit} allows at most ${option.precision} decimal place(s), got ${magnitude}.`, { severity: 'error' });
        }
      }
    }
  }
  if (field.type === 'input-proportion') {
    const numerator = numericValue(field, value);
    // See the identical fix just above for input-quantity's magnitude
    // check - same NaN-vs-undefined gap, same reason.
    if (!isRecord(value) || typeof numerator !== 'number' || !Number.isFinite(numerator)) { issue(issues, path, 'type', `${field.label} requires a numeric proportion.`); return; }
    // An explicitly-supplied but non-numeric denominator (e.g. {denominator:
    // 'xyz'}) must be caught here, not left to fall through as if it were
    // absent - proportionDenominator() only treats a denominator as
    // "genuinely absent" when the raw value is undefined; asNumber() still
    // returns NaN, not undefined, for garbage input, exactly the same
    // distinction the magnitude/numerator check above already makes.
    if (value.denominator !== undefined && !Number.isFinite(asNumber(value.denominator))) { issue(issues, path, 'type', `${field.label} requires a numeric denominator.`); return; }
    const denominator = proportionDenominator(field, value);
    // denominator === 0 is the one universal DV_PROPORTION invariant (RM
    // spec amendment SPECRM-32: "Add invariant to DV_PROPORTION preventing
    // 0 denominator") - a real, unconditional RM-validity error, not an
    // archetype-specific nudge, so this is the one 'proportion-*' issue
    // that's NOT a warning. It blocks regardless of proportionType,
    // including when proportionType is unset entirely.
    if (denominator === 0) { issue(issues, path, 'proportion-denominator', `${field.label}: the denominator must not be 0.`); return; }
    if (denominator === undefined) {
      // 'ratio'/'fraction'/'integer_fraction' (or an unrecognized/unset
      // type) never gets an implied denominator - the field genuinely
      // needs one supplied, same severity as `required` above (this is
      // "you didn't finish filling in the value", not archetype drift).
      issue(issues, path, 'type', `${field.label} requires a denominator.`);
      return;
    }
    // From here on, proportionType-implied checks - warnings, not hard
    // blocks, matching quantity-range/quantity-precision's own reasoning
    // just above: PROPORTION_KIND enforcement is new, and nothing has ever
    // submitted a DV_PROPORTION value in this system yet (confirmed live,
    // 2026-09-02) so there's no legacy-data risk either way here - kept a
    // warning anyway for consistency with the rest of this function's
    // "archetype-constraint checks are advisory" stance, and because a
    // clinician mid-entry may legitimately have an inconsistent
    // intermediate state before finishing the field.
    if (field.proportionType === 'percent' && denominator !== 100) {
      issue(issues, path, 'proportion-type', `${field.label}: type 'percent' requires a denominator of 100, got ${denominator}.`, { severity: 'error' });
    } else if (field.proportionType === 'unitary' && denominator !== 1) {
      issue(issues, path, 'proportion-type', `${field.label}: type 'unitary' requires a denominator of 1, got ${denominator}.`, { severity: 'error' });
    } else if ((field.proportionType === 'fraction' || field.proportionType === 'integer_fraction') && (!Number.isInteger(numerator) || !Number.isInteger(denominator))) {
      issue(issues, path, 'proportion-type', `${field.label}: type '${field.proportionType}' requires both numerator and denominator to be whole numbers.`, { severity: 'error' });
    }
  }
  if (field.type === 'input-identifier') {
    // DV_IDENTIFIER (P0.1 audit, 2026-09-05) - id is RM-mandatory (1..1,
    // invariant "not id.is_empty") whenever the identifier is present at
    // all, independent of the field's own `required` flag (which only
    // governs whether the WHOLE field may be left untouched - already
    // handled by the generic empty(value) early-return above). issuer/
    // assigner/type are each 0..1, always optional free text - see
    // openehr-engine's setFlatValue/buildLeafDvValue/readFlatValue, which
    // already fully supported this compound shape before any field ever
    // actually produced it. A bare string is accepted the same as
    // `{id: string}` - readFlatValue's own DV_IDENTIFIER branch returns a
    // plain string whenever issuer/assigner/type are all empty (see its
    // comment for why: this rmType is also used, unchanged, by a
    // pre-existing plain input-text field), so a reloaded id-only value
    // must validate cleanly here too, not just a freshly-typed one.
    const id = typeof value === 'string' ? value : (isRecord(value) ? value.id : undefined);
    if (typeof id !== 'string' || !id.trim()) {
      issue(issues, path, 'type', `${field.label} requires an identifier.`);
    }
    return;
  }
  if (field.type === 'input-interval') {
    // DV_INTERVAL<DV_QUANTITY> - see canonical/index.ts's intervalValueType
    // doc comment (P0.1 audit, 2026-09-05: this rmType was a total gap
    // before, confirmed on the real "Medikationsabgleich" form's dose-range
    // fields). A genuinely open-ended interval (only one bound given) is
    // valid RM - lower_unbounded/upper_unbounded, see canonicalComposition.ts's
    // buildLeafDvValue - so "only one bound present" is not itself an
    // error; only "neither bound present" trips `required` (via the
    // generic empty() check above, since {} alone isn't caught by it -
    // hence the explicit check here).
    if (!isRecord(value)) { issue(issues, path, 'type', `${field.label} requires a range.`); return; }
    const lower = validateIntervalBound(field, value.lower, `${path}/lower`, issues, 'lower');
    const upper = validateIntervalBound(field, value.upper, `${path}/upper`, issues, 'upper');
    if (field.required && lower === undefined && upper === undefined) {
      issue(issues, path, 'required', `${field.label} is required.`);
    } else if (lower && upper) {
      if (lower.unit && upper.unit && lower.unit !== upper.unit) {
        issue(issues, path, 'interval-unit-mismatch', `${field.label}: the lower and upper bound use different units (${lower.unit} vs ${upper.unit}).`, { severity: 'error' });
      } else if (lower.magnitude > upper.magnitude) {
        issue(issues, path, 'interval-order', `${field.label}: the lower bound (${lower.magnitude}) must not be greater than the upper bound (${upper.magnitude}).`);
      }
    }
    return;
  }
  // input-duration has no dedicated widget (it renders as a plain text
  // input, see FormRuntime.tsx's inputType() default case) and, until now,
  // no validation at all - a clinician typing "3 days" or "72h" reached
  // EHRbase unvalidated (docs/features/rm-type-spec-conformance.md #3). A
  // hard error, not a warning: unlike DV_QUANTITY's archetype-specific
  // range, ISO 8601 duration shape is the RM type's own universal wire
  // contract, so a non-match is never legitimate pre-existing data.
  if (field.type === 'input-duration' && typeof value === 'string' && !DV_DURATION_PATTERN.test(value)) {
    issue(issues, path, 'duration-format', `${field.label} must be a valid ISO 8601 duration (e.g. P3D, PT4H30M).`);
    return;
  }
  if (['input-number', 'input-range'].includes(field.type) && !Number.isFinite(numericValue(field, value))) { issue(issues, path, 'type', `${field.label} requires a number.`); return; }
  // DV_COUNT/DV_INTEGER/DV_DECIMAL's own archetype range/precision (P0.1
  // audit, 2026-09-05) - see FormElementLayout.numberRange's doc comment
  // for why this is kept separate from the generic field.validation.min/max
  // check further below (a designer-configured rule, not an archetype one).
  // Same blocking severity ('error') as input-quantity's own quantity-range/
  // quantity-precision checks - the archetype's own stated constraint, not
  // an optional nicety.
  if (field.type === 'input-number' && field.numberRange) {
    const number = numericValue(field, value);
    if (typeof number === 'number' && Number.isFinite(number)) {
      const { min, max, minexclusive, maxexclusive, precision } = field.numberRange;
      if (min !== undefined) {
        const belowMin = minexclusive ? number <= min : number < min;
        if (belowMin) issue(issues, path, 'number-range', `${field.label}: ${number} is below the archetype's allowed minimum (${minexclusive ? '>' : '>='} ${min}).`, { severity: 'error' });
      }
      if (max !== undefined) {
        const aboveMax = maxexclusive ? number >= max : number > max;
        if (aboveMax) issue(issues, path, 'number-range', `${field.label}: ${number} is above the archetype's allowed maximum (${maxexclusive ? '<' : '<='} ${max}).`, { severity: 'error' });
      }
      if (precision !== undefined && fractionalDigits(number) > precision) {
        issue(issues, path, 'number-precision', `${field.label} allows at most ${precision} decimal place(s), got ${number}.`, { severity: 'error' });
      }
    }
  }
  if (field.type === 'input-boolean' && typeof value !== 'boolean') issue(issues, path, 'type', `${field.label} requires a boolean.`);
  if (['input-select', 'input-ordinal'].includes(field.type) && typeof value !== 'string' && !Array.isArray(value)) issue(issues, path, 'type', `${field.label} requires a selected option.`);
  // A DV_CODED_TEXT|DV_TEXT union field (field.allowFreeText, from the OPT
  // constraint model) legitimately has values that don't match any
  // `options` entry - that's the free-text alternative, not an invalid
  // selection. Every other coded field keeps the exact strict check it
  // always had.
  if (field.options.length > 0 && !field.allowFreeText) {
    const selected = Array.isArray(value) ? value : [value];
    if (selected.some((item) => typeof item !== 'string' || !field.options.some((option) => option.value === item))) issue(issues, path, 'option', `${field.label} contains an unsupported option.`);
  }
  // codeMappings.requireMapping - only reached once the field has a
  // non-empty text value (the empty() early-return above already handles
  // required/blank), so this is purely "you typed text but attached no
  // code", never a substitute for the field's own `required`.
  if (field.codeMappings?.enabled && field.codeMappings.requireMapping) {
    const mappings = isRecord(rawValue) ? (rawValue as Record<string, unknown>).mappings : undefined;
    if (!Array.isArray(mappings) || mappings.length === 0) issue(issues, path, 'mapping-required', `${field.label} requires a code.`);
  }
  const number = numericValue(field, value);
  if (number !== undefined && field.validation?.min !== undefined && number < field.validation.min) issue(issues, path, 'min', `${field.label} must be at least ${field.validation.min}.`);
  if (number !== undefined && field.validation?.max !== undefined && number > field.validation.max) issue(issues, path, 'max', `${field.label} must be at most ${field.validation.max}.`);
  if (field.validation?.regex && typeof value === 'string') {
    const compiled = compileValidationPattern(field.validation.regex);
    // A broken pattern (designer typo) fails open - the value is simply not
    // checked against it, rather than blocking every clinician who happens
    // to fill in this field with a fake "invalid format" error. The real
    // configuration error is surfaced to the designer instead, in
    // FormBuilder's RegexRuleTester (which calls this same function).
    if ('regex' in compiled && !compiled.regex.test(value)) {
      // No severity set defaults to 'error' (blocking) - unchanged behavior
      // for every regex already configured before this field existed.
      issue(issues, path, 'pattern', field.validation.regexMessage || `${field.label} has an invalid format.`, { severity: field.validation.regexSeverity, source: 'regex' });
    }
  }
}

/** Single place `new RegExp()` is called for a `field.validation.regex`
 * pattern - shared between this module's own runtime check just above and
 * FormBuilder's RegexRuleTester (Designer live-test UI), so the two can
 * never silently diverge on what counts as a match. An invalid pattern is
 * reported as a `configError`, not thrown - the caller decides how to
 * react (runtime: skip the check; Designer: show a config-error hint). */
export function compileValidationPattern(pattern: string): { regex: RegExp } | { configError: string } {
  try {
    return { regex: new RegExp(pattern) };
  } catch (error) {
    return { configError: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether an issue actually blocks submission. Missing severity still
 * blocks (unchanged behavior for every issue producer that predates the
 * severity field). Only 'warning'/'info' are non-blocking - use this
 * everywhere instead of ad-hoc `severity !== 'warning'` comparisons, which
 * would incorrectly treat a future 'info'-severity issue as blocking. */
export function isBlockingIssue(issue: Pick<RuntimeValidationIssue, 'severity'>): boolean {
  return !issue.severity || issue.severity === 'error';
}

export interface RuntimeValidationOptions {
  /**
   * `'final'` (default) runs the full validation used before finalizing a
   * Composition. `'draft'` runs the exact same checks but drops the
   * `required`/`repeat-min` issues afterward - real openEHR drafts
   * (lifecycle_state=incomplete) are explicitly allowed to have missing
   * required fields, but never an invalid typed value (e.g. a DV_QUANTITY
   * that isn't a number). This is a post-filter, not a parallel
   * implementation: validateOne() already only runs its type/unit/option/
   * min/max/pattern checks on values that are present (it returns
   * immediately after the required check on an empty value), so every
   * non-required-related issue below is already exclusively a "value present
   * but invalid" issue.
   */
  mode?: 'draft' | 'final';
}

const DRAFT_EXEMPT_ISSUE_CODES: ReadonlySet<RuntimeValidationIssue['code']> = new Set(['required', 'repeat-min']);

export function validateRuntimeValues(form: Pick<CanonicalForm, 'layout' | 'locales'>, values: RuntimeValues, options?: RuntimeValidationOptions): RuntimeValidationResult {
  const issues: RuntimeValidationIssue[] = [];
  const allGroups = collectRuntimeGroups(form);
  const allFields = collectRuntimeFields(form);
  // Recursive group-tree validation (P0.2 audit, 2026-09-05) - replaces two
  // separate flat passes (one over every group checking `values[group.id]`,
  // one over every field checking `values[field.repeatableGroupId]`) that
  // both always looked at the TOP level regardless of nesting. A NESTED
  // group's own rows live inside each of its parent's row objects, never
  // at the top level - see RuntimeGroupDescriptor.parentGroupId's doc
  // comment for the full writeup. Grouped the same way as
  // createInitialRuntimeValues' own groupsByParent/fieldsByGroup maps, and
  // deliberately built the same way so the two never drift apart.
  const groupsByParent = new Map<string | undefined, RuntimeGroupDescriptor[]>();
  allGroups.forEach((group) => {
    const list = groupsByParent.get(group.parentGroupId);
    if (list) list.push(group); else groupsByParent.set(group.parentGroupId, [group]);
  });
  const fieldsByGroup = new Map<string | undefined, RuntimeFieldDescriptor[]>();
  allFields.forEach((field) => {
    const list = fieldsByGroup.get(field.repeatableGroupId);
    if (list) list.push(field); else fieldsByGroup.set(field.repeatableGroupId, [field]);
  });
  // `scope` is `values` for a top-level group, or one specific parent row
  // object for a nested one; `pathPrefix` is that same row's own already-
  // built path (undefined at the top level, where the group's bare id is
  // the whole path). Field-visibility (isRuntimeFieldVisible) deliberately
  // still checks the TOP-LEVEL `values` object regardless of nesting depth,
  // matching this function's own pre-existing behavior for single-level
  // groups (an enableWhen condition has never been able to reference a
  // sibling within the same repeatable row) - unchanged by this refactor,
  // not a new limitation introduced by it.
  function validateGroup(group: RuntimeGroupDescriptor, scope: Record<string, RuntimeValue>, pathPrefix: string | undefined): void {
    const groupPath = pathPrefix ? `${pathPrefix}.${group.id}` : group.id;
    const repeated = scope[group.id] === undefined ? [] : scope[group.id];
    if (!Array.isArray(repeated)) {
      issue(issues, groupPath, 'type', `${group.label} requires repeated group entries.`);
      return;
    }
    if (repeated.length < group.repeatMin) issue(issues, groupPath, 'repeat-min', `${group.label} requires at least ${group.repeatMin} entries.`);
    if (group.repeatMax !== -1 && repeated.length > group.repeatMax) issue(issues, groupPath, 'repeat-max', `${group.label} allows at most ${group.repeatMax} entries.`);
    const directFields = fieldsByGroup.get(group.id) || [];
    const nestedGroups = groupsByParent.get(group.id) || [];
    repeated.forEach((row, index) => {
      const rowPath = `${groupPath}[${index}]`;
      if (!isRecord(row)) {
        issue(issues, rowPath, 'type', `${group.label} requires object entries.`);
        return;
      }
      directFields.forEach((field) => {
        if (!isRuntimeFieldVisible(field, values)) return;
        const value = row[field.id] as RuntimeValue;
        const path = `${rowPath}.${field.id}`;
        if (!field.repeatable) {
          validateOne(field, value, path, issues);
          return;
        }
        const fieldRepeated = value === undefined ? [] : value;
        if (!Array.isArray(fieldRepeated)) {
          issue(issues, path, 'type', `${field.label} requires repeated values.`);
          return;
        }
        if (fieldRepeated.length < field.repeatMin) issue(issues, path, 'repeat-min', `${field.label} requires at least ${field.repeatMin} entries.`);
        if (field.repeatMax !== -1 && fieldRepeated.length > field.repeatMax) issue(issues, path, 'repeat-max', `${field.label} allows at most ${field.repeatMax} entries.`);
        fieldRepeated.forEach((entry, entryIndex) => validateOne(field, entry, `${path}[${entryIndex}]`, issues));
      });
      nestedGroups.forEach((nested) => validateGroup(nested, row, rowPath));
    });
  }
  (groupsByParent.get(undefined) || []).forEach((group) => validateGroup(group, values, undefined));
  allFields.forEach((field) => {
    if (field.repeatableGroupId) return;
    if (!isRuntimeFieldVisible(field, values)) return;
    const value = values[field.id];
    if (!field.repeatable) { validateOne(field, value, field.id, issues); return; }
    const repeated = value === undefined ? [] : value;
    if (!Array.isArray(repeated)) { issue(issues, field.id, 'type', `${field.label} requires repeated values.`); return; }
    if (repeated.length < field.repeatMin) issue(issues, field.id, 'repeat-min', `${field.label} requires at least ${field.repeatMin} entries.`);
    if (field.repeatMax !== -1 && repeated.length > field.repeatMax) issue(issues, field.id, 'repeat-max', `${field.label} allows at most ${field.repeatMax} entries.`);
    repeated.forEach((item, index) => validateOne(field, item, `${field.id}[${index}]`, issues));
  });
  const filtered = options?.mode === 'draft' ? issues.filter((entry) => !DRAFT_EXEMPT_ISSUE_CODES.has(entry.code)) : issues;
  // A 'warning'/'info'-severity issue (only ever regex/script-sourced now -
  // see validateOne and isBlockingIssue's own doc comment) is surfaced for
  // review but never blocks `valid`. Template-derived issues (quantity-
  // range/precision, RM-type shape, ...) have no severity set and so
  // always block, same as before severity existed at all.
  return { valid: !filtered.some(isBlockingIssue), issues: filtered };
}
