import type { CanonicalForm, FormSessionValues, JsonValue } from 'core';

// Named (not `export *`) so this re-export is statically analyzable by
// Rollup/cjs-module-lexer when consumed from apps/web's Vite build - a
// wildcard re-export of a locally-compiled `__exportStar` helper isn't
// reliably detected there.
export {
  parseOpenEhrAqlPath,
  toArchetypePath,
  getElementMetadata,
  getArchetypePath,
  getTemplatePath,
  getAqlPath,
  resolveElementByPath,
  resolveElementsByNodeId,
  type ParsedOpenEhrPath,
} from './metadata';

export { compareRuntimeValues } from './diff';

export { buildCanonicalComposition, type CanonicalCompositionContext, type WebTemplateTreeNode } from './canonicalComposition';

export const OPEN_EHR_FORM_EXTENSION = 'org.openehr.form' as const;

export interface OpenEhrFormOptions {
  storageStrategy?: 'always_new' | 'update_latest';
}

export interface OpenEhrCompositionContext {
  language?: string;
  territory?: string;
  time?: string;
  composerName?: string;
}

export interface OpenEhrPathMapping {
  flatPath: string;
  rmType?: string;
}

type JsonObject = Record<string, JsonValue>;
type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export function getOpenEhrFormOptions(definition: Pick<CanonicalForm, 'settings'> & { extensions?: Record<string, JsonValue> }): OpenEhrFormOptions {
  const extension = definition.extensions && isRecord(definition.extensions[OPEN_EHR_FORM_EXTENSION])
    ? definition.extensions[OPEN_EHR_FORM_EXTENSION]
    : undefined;
  return extension && (extension.storageStrategy === 'always_new' || extension.storageStrategy === 'update_latest')
    ? { storageStrategy: extension.storageStrategy }
    : {};
}

export function withOpenEhrFormOptions<T extends CanonicalForm & { extensions?: Record<string, JsonValue> }>(definition: T, options: OpenEhrFormOptions): T {
  return {
    ...definition,
    extensions: {
      ...(definition.extensions || {}),
      [OPEN_EHR_FORM_EXTENSION]: options as JsonObject,
    },
  };
}

function indexedPath(path: string, index: number | undefined): string {
  return index === undefined ? path : `${path}:${index}`;
}

const STRUCTURAL_RM_TYPES = new Set([
  'ACTIVITY', 'CLUSTER', 'SECTION', 'COMPOSITION', 'INSTRUCTION',
  'OBSERVATION', 'EVALUATION', 'ACTION', 'ADMIN_ENTRY', 'EVENT_CONTEXT',
  'HISTORY', 'EVENT', 'POINT_EVENT', 'INTERVAL_EVENT', 'ITEM_TREE',
  'ITEM_LIST', 'ITEM_TABLE', 'ITEM_SINGLE', 'ITEM_STRUCTURE', 'ELEMENT',
  'PARTY_PROXY', 'PARTY_IDENTIFIED', 'PARTY_RELATED', 'PARTY_SELF',
]);

function setFlatValue(output: Record<string, unknown>, path: string, binding: FieldBinding, value: unknown, index?: number): void {
  const { rmType } = binding;
  if (isEmpty(value) || (rmType && STRUCTURAL_RM_TYPES.has(rmType))) return;
  const key = indexedPath(path, index);
  const source = isRecord(value) ? value : undefined;
  if (rmType === 'DV_QUANTITY') {
    const magnitude = source?.magnitude ?? value;
    if (!isEmpty(magnitude)) output[`${key}|magnitude`] = typeof magnitude === 'string' && magnitude.trim() ? Number(magnitude) : magnitude;
    if (!isEmpty(source?.unit)) output[`${key}|unit`] = source?.unit;
    return;
  }
  if (rmType === 'DV_CODED_TEXT' || rmType === 'CODE_PHRASE') {
    const code = source?.code ?? source?.value ?? value;
    const option = binding.options?.find((candidate) => candidate.value === String(code));
    // EHRbase requires the full CODE_PHRASE for a DV_CODED_TEXT. Old form
    // sessions keep only the selected option value, so enrich it from the
    // form's option metadata and use the openEHR local terminology by default.
    const displayValue = source?.value ?? source?.text ?? source?.label ?? option?.text ?? code;
    const terminology = source?.terminology ?? source?.terminologyId ?? option?.terminology ?? 'local';
    if (!isEmpty(code)) {
      output[`${key}|code`] = code;
      output[`${key}|value`] = displayValue;
      output[`${key}|terminology`] = terminology;
    }
    return;
  }
  output[key] = value;
}

export function buildOpenEhrPathMap(tree: unknown): Map<string, OpenEhrPathMapping> {
  const map = new Map<string, OpenEhrPathMapping>();
  function walk(node: unknown, prefix: string): void {
    if (!isRecord(node)) return;
    const id = text(node.id) || text(node.name);
    const current = id ? (prefix ? `${prefix}/${id}` : id) : prefix;
    const aqlPath = text(node.aqlPath);
    const rmType = text(node.rmType);
    if (aqlPath && current) map.set(aqlPath, { flatPath: current, ...(rmType ? { rmType } : {}) });
    if (Array.isArray(node.children)) node.children.forEach((child) => walk(child, current));
  }
  walk(tree, '');
  return map;
}

interface CodedTextOption {
  value: string;
  text?: string;
  terminology?: string;
}

interface FieldBinding {
  path?: string;
  rmType?: string;
  flatPath?: string;
  options?: CodedTextOption[];
}

function layoutFieldBinding(binding: unknown): FieldBinding | undefined {
  if (!isRecord(binding)) return undefined;
  // Canonical v1 stores a direct mapping here. Older forms stored the same
  // mapping in the top-level binding envelope used by `form.bindings`.
  const candidate = isRecord(binding.openehr) ? binding.openehr : binding;
  const path = text(candidate.path);
  const flatPath = text(candidate.flatPath);
  const rmType = text(candidate.rmType);
  if (!path && !flatPath) return undefined;
  return {
    ...(path ? { path } : {}),
    ...(flatPath ? { flatPath } : {}),
    ...(rmType ? { rmType } : {}),
  };
}

function collectFieldBindings(layout: CanonicalForm['layout']): Map<string, FieldBinding> {
  const map = new Map<string, FieldBinding>();
  function walk(node: CanonicalForm['layout']): void {
    const binding = layoutFieldBinding(node.binding);
    const rawOptions = (node as unknown as Record<string, unknown>).options;
    const options = Array.isArray(rawOptions)
      ? rawOptions.flatMap((option): CodedTextOption[] => {
        if (!isRecord(option) || !text(option.value)) return [];
        const value = text(option.value)!;
        const optionText = text(option.text) || text(option.label);
        const terminology = text(option.terminology) || text(option.terminologyId);
        return [{
          value,
          ...(optionText ? { text: optionText } : {}),
          ...(terminology ? { terminology } : {}),
        }];
      })
      : undefined;
    if (node.id && binding) map.set(node.id, options?.length ? { ...binding, options } : binding);
    node.children?.forEach(walk);
  }
  walk(layout);
  return map;
}

function resolveFlatPath(binding: FieldBinding, pathMap?: Map<string, OpenEhrPathMapping>): string | undefined {
  return text(binding.flatPath) || (binding.path ? pathMap?.get(binding.path)?.flatPath : undefined) || text(binding.path);
}

export function toOpenEhrFlatComposition(definition: CanonicalForm, values: FormSessionValues, context: OpenEhrCompositionContext = {}, webTemplateTree?: unknown): Record<string, unknown> {
  const templateId = definition.sourceTemplates[0]?.id;
  const flat: Record<string, unknown> = {
    'ctx/language': context.language || 'en',
    'ctx/territory': context.territory || 'DE',
    'ctx/time': context.time || new Date().toISOString(),
    'ctx/composer_name': context.composerName || 'Form Builder',
    ...(templateId ? { 'ctx/template_id': templateId } : {}),
  };
  const pathMap = webTemplateTree === undefined ? undefined : buildOpenEhrPathMap(webTemplateTree);
  const layoutBindings = collectFieldBindings(definition.layout);
  const processed = new Set<string>();
  for (const [fieldId, value] of Object.entries(values)) {
    const binding = layoutBindings.get(fieldId);
    const flatPath = binding && resolveFlatPath(binding, pathMap);
    if (!binding || !flatPath) continue;
    if (Array.isArray(value)) value.forEach((entry, index) => setFlatValue(flat, flatPath, binding, entry, index));
    else setFlatValue(flat, flatPath, binding, value);
    processed.add(flatPath);
  }
  for (const [fieldId, value] of Object.entries(values)) {
    if (layoutBindings.has(fieldId)) continue;
    const binding = definition.bindings[fieldId]?.openehr;
    const flatPath = binding && resolveFlatPath(binding, pathMap);
    if (!binding || !flatPath || processed.has(flatPath)) continue;
    if (Array.isArray(value)) value.forEach((entry, index) => setFlatValue(flat, flatPath, binding, entry, index));
    else setFlatValue(flat, flatPath, binding, value);
    processed.add(flatPath);
  }
  return flat;
}

function readFlatValue(flat: Record<string, unknown>, path: string, rmType?: string): unknown {
  const escaped = path.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\\\//g, '(?::\\d+)?/');
  const matcher = new RegExp(`^${escaped}(?::\\d+)?(?:\\|.*)?$`);
  const matches = Object.keys(flat).filter((key) => matcher.test(key));
  if (matches.length === 0) return undefined;
  const values: unknown[] = [];
  for (const key of matches) {
    // Was `\\d` (a literal backslash + "d", matching nothing in a real flat
    // key) instead of `\d` (a digit) - every repeat-index extraction
    // silently failed, so `indices` was always `[]` and the loop below
    // returned only the very first matched key's value on line 238,
    // discarding every other repeat of a repeating field entirely. The
    // lookahead's trailing `\\|` also had a stray backslash making its
    // last alternative an always-true empty string (harmless on its own -
    // an OR'd empty branch never rejects a match - but not what "index
    // must be followed by /, end-of-string, or |" was supposed to mean).
    const indices = Array.from(key.matchAll(/:(\d+)(?=\/|$|\|)/g), (match) => Number(match[1]));
    let value: unknown;
    if (rmType === 'DV_QUANTITY') {
      if (!key.endsWith('|magnitude')) continue;
      value = { magnitude: flat[key], unit: flat[key.replace('|magnitude', '|unit')] };
    } else if (rmType === 'DV_CODED_TEXT' || rmType === 'CODE_PHRASE') {
      if (key.endsWith('|code')) value = flat[key];
      else if (key.endsWith('|value') && !matches.includes(key.replace('|value', '|code'))) value = flat[key];
      else continue;
    } else value = flat[key];
    if (indices.length === 0) return value;
    let current = values;
    indices.forEach((index, position) => {
      if (position === indices.length - 1) current[index] = value;
      else {
        if (!Array.isArray(current[index])) current[index] = [];
        current = current[index] as unknown[];
      }
    });
  }
  return values.length > 0 ? values : undefined;
}

export function fromOpenEhrFlatComposition(definition: CanonicalForm, composition: Record<string, unknown>, webTemplateTree?: unknown): FormSessionValues {
  const values: FormSessionValues = {};
  const pathMap = webTemplateTree === undefined ? undefined : buildOpenEhrPathMap(webTemplateTree);
  const layoutBindings = collectFieldBindings(definition.layout);
  const processedPaths = new Set<string>();
  for (const [fieldId, binding] of layoutBindings) {
    const flatPath = resolveFlatPath(binding, pathMap);
    if (flatPath) processedPaths.add(flatPath);
    const value = flatPath ? readFlatValue(composition, flatPath, binding.rmType) : undefined;
    if (!isEmpty(value)) values[fieldId] = value;
  }
  for (const [fieldId, wrapped] of Object.entries(definition.bindings)) {
    const binding = wrapped.openehr;
    const flatPath = resolveFlatPath(binding, pathMap);
    if (flatPath && processedPaths.has(flatPath)) continue;
    const value = flatPath ? readFlatValue(composition, flatPath, binding.rmType) : undefined;
    if (!isEmpty(value)) values[fieldId] = value;
  }
  return values;
}
