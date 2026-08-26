import type { CanonicalForm, FormElementLayout, JsonPrimitive, JsonValue, ValidationIssue } from '../canonical';

export type RuntimePrimitive = JsonPrimitive;
export type RuntimeJsonValue = JsonValue;
export type RuntimeValue = JsonValue | undefined;
export type RuntimeValues = Record<string, RuntimeValue>;

export interface RuntimeOption { value: string; text: string; }
export interface RuntimeUnitOption { unit: string; min?: number; max?: number; precision?: number; }
export interface RuntimeFieldDescriptor {
  id: string; name: string; type: string; label: string; description?: string | undefined;
  required: boolean; readOnly: boolean; options: RuntimeOption[]; unitOptions: RuntimeUnitOption[];
  validation?: { min?: number; max?: number; regex?: string } | undefined; visibility?: unknown;
  repeatable: boolean; repeatMin: number; repeatMax: number; defaultValue?: RuntimeJsonValue | undefined;
  repeatableGroupId?: string | undefined;
  aqlPath?: string | undefined; binding?: unknown; semanticType?: string | undefined; archetypeNodeId?: string | undefined;
  /** Never rendered, in any mode - see FormElementLayout.alwaysHidden. */
  alwaysHidden: boolean;
}
export interface RuntimeGroupDescriptor {
  id: string;
  label: string;
  repeatMin: number;
  repeatMax: number;
}
export interface RuntimeValidationIssue extends ValidationIssue {
  path: string;
  code: 'required' | 'type' | 'min' | 'max' | 'option' | 'unit' | 'pattern' | 'repeat-min' | 'repeat-max';
}
export interface RuntimeValidationResult { valid: boolean; issues: RuntimeValidationIssue[]; }

const NON_FIELD_TYPES = new Set([
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
    options: (node.options || []).map((option) => ({ value: String(option.value), text: String(option.text) })),
    unitOptions: (node.unitOptions || []).map((option) => typeof option === 'string' ? { unit: option } : { ...option }),
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
  };
}

export function collectRuntimeFields(form: Pick<CanonicalForm, 'layout' | 'locales'>): RuntimeFieldDescriptor[] {
  const fields: RuntimeFieldDescriptor[] = [];
  walk(form.layout, (node, repeatableGroupId) => {
    if (nodeId(node) && !NON_FIELD_TYPES.has(node.type)) fields.push(toDescriptor(node, form.locales, repeatableGroupId));
  });
  return fields;
}

export function collectRuntimeGroups(form: Pick<CanonicalForm, 'layout' | 'locales'>): RuntimeGroupDescriptor[] {
  const groups: RuntimeGroupDescriptor[] = [];
  walk(form.layout, (node) => {
    const id = nodeId(node);
    if (node.type === 'container' && node.repeatable === true && id) {
      groups.push({
        id,
        label: resolveLabel(node, id, form.locales),
        repeatMin: node.repeatMin ?? 0,
        repeatMax: node.repeatMax ?? -1,
      });
    }
  });
  return groups;
}

export function createInitialRuntimeValues(form: Pick<CanonicalForm, 'layout' | 'locales'>): RuntimeValues {
  const values: RuntimeValues = {};
  const fields = collectRuntimeFields(form);
  collectRuntimeGroups(form).forEach((group) => {
    const itemDefaults: Record<string, RuntimeJsonValue> = {};
    fields.filter((field) => field.repeatableGroupId === group.id && field.defaultValue !== undefined).forEach((field) => {
      itemDefaults[field.id] = field.repeatable ? [field.defaultValue as RuntimeJsonValue] : field.defaultValue as RuntimeJsonValue;
    });
    values[group.id] = Array.from({ length: group.repeatMin }, () => ({ ...itemDefaults }));
  });
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

function numericValue(field: RuntimeFieldDescriptor, value: RuntimeValue): number | undefined {
  if (field.type === 'input-quantity') {
    if (!isRecord(value)) return undefined;
    const magnitude = value.magnitude;
    return typeof magnitude === 'number' ? magnitude : (typeof magnitude === 'string' && magnitude.trim() ? Number(magnitude) : undefined);
  }
  if (['input-number', 'input-proportion', 'input-range'].includes(field.type)) return typeof value === 'number' ? value : (typeof value === 'string' && value.trim() ? Number(value) : undefined);
  return undefined;
}

function issue(issues: RuntimeValidationIssue[], path: string, code: RuntimeValidationIssue['code'], message: string): void { issues.push({ path, code, message }); }

function validateOne(field: RuntimeFieldDescriptor, value: RuntimeValue, path: string, issues: RuntimeValidationIssue[]): void {
  if (empty(value)) { if (field.required) issue(issues, path, 'required', `${field.label} is required.`); return; }
  if (field.type === 'input-quantity') {
    if (!isRecord(value) || numericValue(field, value) === undefined) { issue(issues, path, 'type', `${field.label} requires a numeric quantity.`); return; }
    const unit = value.unit;
    if (field.unitOptions.length > 0 && (typeof unit !== 'string' || !unit)) issue(issues, path, 'unit', `${field.label} requires a unit.`);
    else if (field.unitOptions.length > 0 && typeof unit === 'string' && !field.unitOptions.some((option) => option.unit === unit)) issue(issues, path, 'unit', `${field.label} has an unsupported unit.`);
  }
  if (['input-number', 'input-proportion', 'input-range'].includes(field.type) && !Number.isFinite(numericValue(field, value))) { issue(issues, path, 'type', `${field.label} requires a number.`); return; }
  if (field.type === 'input-boolean' && typeof value !== 'boolean') issue(issues, path, 'type', `${field.label} requires a boolean.`);
  if (['input-select', 'input-ordinal'].includes(field.type) && typeof value !== 'string' && !Array.isArray(value)) issue(issues, path, 'type', `${field.label} requires a selected option.`);
  if (field.options.length > 0) {
    const selected = Array.isArray(value) ? value : [value];
    if (selected.some((item) => typeof item !== 'string' || !field.options.some((option) => option.value === item))) issue(issues, path, 'option', `${field.label} contains an unsupported option.`);
  }
  const number = numericValue(field, value);
  if (number !== undefined && field.validation?.min !== undefined && number < field.validation.min) issue(issues, path, 'min', `${field.label} must be at least ${field.validation.min}.`);
  if (number !== undefined && field.validation?.max !== undefined && number > field.validation.max) issue(issues, path, 'max', `${field.label} must be at most ${field.validation.max}.`);
  if (field.validation?.regex && typeof value === 'string') {
    let matches = true; try { matches = new RegExp(field.validation.regex).test(value); } catch { matches = false; }
    if (!matches) issue(issues, path, 'pattern', `${field.label} has an invalid format.`);
  }
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
  const groups = new Map(collectRuntimeGroups(form).map((group) => [group.id, group]));
  groups.forEach((group) => {
    const repeated = values[group.id] === undefined ? [] : values[group.id];
    if (!Array.isArray(repeated)) {
      issue(issues, group.id, 'type', `${group.label} requires repeated group entries.`);
      return;
    }
    if (repeated.length < group.repeatMin) issue(issues, group.id, 'repeat-min', `${group.label} requires at least ${group.repeatMin} entries.`);
    if (group.repeatMax !== -1 && repeated.length > group.repeatMax) issue(issues, group.id, 'repeat-max', `${group.label} allows at most ${group.repeatMax} entries.`);
  });
  collectRuntimeFields(form).forEach((field) => {
    if (!isRuntimeFieldVisible(field, values)) return;
    if (field.repeatableGroupId) {
      const repeated = values[field.repeatableGroupId];
      if (!Array.isArray(repeated)) return;
      repeated.forEach((item, index) => {
        if (!isRecord(item)) {
          issue(issues, `${field.repeatableGroupId}[${index}]`, 'type', `${groups.get(field.repeatableGroupId as string)?.label || field.repeatableGroupId} requires object entries.`);
          return;
        }
        const value = item[field.id] as RuntimeValue;
        const path = `${field.repeatableGroupId}[${index}].${field.id}`;
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
      return;
    }
    const value = values[field.id];
    if (!field.repeatable) { validateOne(field, value, field.id, issues); return; }
    const repeated = value === undefined ? [] : value;
    if (!Array.isArray(repeated)) { issue(issues, field.id, 'type', `${field.label} requires repeated values.`); return; }
    if (repeated.length < field.repeatMin) issue(issues, field.id, 'repeat-min', `${field.label} requires at least ${field.repeatMin} entries.`);
    if (field.repeatMax !== -1 && repeated.length > field.repeatMax) issue(issues, field.id, 'repeat-max', `${field.label} allows at most ${field.repeatMax} entries.`);
    repeated.forEach((item, index) => validateOne(field, item, `${field.id}[${index}]`, issues));
  });
  const filtered = options?.mode === 'draft' ? issues.filter((entry) => !DRAFT_EXEMPT_ISSUE_CODES.has(entry.code)) : issues;
  return { valid: filtered.length === 0, issues: filtered };
}
