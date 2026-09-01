import type { CanonicalForm, CodeMappingConfig, FormSessionValues, JsonValue } from 'core';

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

export { buildConstraintModelFromWebTemplate, mergeSemanticBindings, type WebTemplateJson, type WtNode, type WtInput, type WtOption } from './opt/buildConstraintModel';

export { parseTermBindingsFromOpt, type SemanticBindingIndex } from './opt/parseOptXml';

export { buildRuntimeValue, serializeRuntimeValue, deserializeRuntimeValue, RuntimeValueError } from './opt/runtimeValue';

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
  /** The current, valid coded values at this node - only present for a
   * DV_CODED_TEXT/CODE_PHRASE node whose WebTemplate carries an
   * `inputs[].list` (the same source webTemplateParser reads for a
   * generated Form Section's own `options`). Used by auditFormBindings to
   * flag a Form Section option EHRbase would now reject - the template's
   * value set can change between imports independently of any Form Section
   * built against an earlier version of it. */
  codes?: string[];
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

/** Shared by both codeMappings.enabled branches below (a DV_TEXT-bound field,
 * and - see the DV_CODED_TEXT branch's own comment - the "HIP converter is
 * king" DV_CODED_TEXT-bound one) so the `mappings/N` FLAT convention can't
 * drift between them. Mirrors canonicalComposition.ts's buildTermMappings
 * for the same reason that file gives: real example compositions for this
 * use only ever carry {match, target: {terminology_id, code_string}}.
 *
 * No leading underscore: confirmed live against EHRbase (2026-09-01) -
 * `_mappings` was rejected wholesale ("Could not consume Parts"). The
 * underscore convention is for LOCATABLE meta-attributes (`_uid`, `_name`,
 * `_feeder_audit`); `mappings` is DV_TEXT's own genuine, value-bearing RM
 * attribute (data_types.text 5.2.4: DV_TEXT.mappings: List<TERM_MAPPING>),
 * not a meta-attribute, so it takes its plain RM name like any other. */
function writeCodeMappingsFlat(output: Record<string, unknown>, key: string, text: unknown, mappings: unknown): boolean {
  if (isEmpty(text)) return false;
  output[key] = text;
  (Array.isArray(mappings) ? mappings : []).forEach((entry, mappingIndex) => {
    if (!isRecord(entry) || isEmpty(entry.terminologyId) || isEmpty(entry.code)) return;
    const prefix = `${key}/mappings/${mappingIndex}`;
    output[`${prefix}|match`] = typeof entry.match === 'string' && entry.match ? entry.match : '=';
    output[`${prefix}/target|code`] = entry.code;
    output[`${prefix}/target|terminology`] = entry.terminologyId;
  });
  return true;
}

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
    // codeMappings.enabled on a DV_CODED_TEXT-bound field must be checked
    // BEFORE the generic CODE_PHRASE handling below, not after - this
    // branch used to live further down as a separate `if`, which a
    // DV_CODED_TEXT-typed field's `return` above always skipped entirely
    // (confirmed live: "Diagnose"/diagnose_name - DV_CODED_TEXT + codeMappings
    // - never took this path at all, so its free-text diagnosis name was
    // instead written into `|code`, an RM-invalid "local" code_string that's
    // actually a sentence, which EHRbase rejected wholesale). Matches
    // buildLeafDvValue's already-correct precedence in canonicalComposition.ts
    // (see its own comment for why this dual-encoding exists at all).
    if (binding.codeMappings?.enabled && source) {
      writeCodeMappingsFlat(output, key, source.value, source.mappings);
      return;
    }
    const code = source?.code ?? source?.value ?? value;
    const option = binding.options?.find((candidate) => candidate.value === String(code));
    // A DV_CODED_TEXT|DV_TEXT union field (binding.allowFreeText, from the
    // OPT constraint model) whose value doesn't match any known option is
    // the free-text alternative being used, not a coded selection that
    // happens to be missing metadata - writing it into `code_string` would
    // be RM-invalid (a "local" terminology code that's actually a
    // sentence). Fall through to the plain DV_TEXT convention instead.
    if (!option && binding.allowFreeText) {
      if (!isEmpty(code)) output[key] = code;
      return;
    }
    // EHRbase requires the full CODE_PHRASE for a DV_CODED_TEXT. Old form
    // sessions keep only the selected option value, so enrich it from the
    // form's option metadata and use the openEHR local terminology by default.
    // option?.rmValue (the archetype's original/default-language term text)
    // must win over option?.text (the UI's preferred-language display text,
    // German-first) - EHRbase's FLAT-composition validator checks
    // DV_CODED_TEXT.value against the former regardless of UI language. See
    // CodedTextOption's rmValue doc comment for the live bug this fixes.
    const displayValue = source?.value ?? source?.text ?? source?.label ?? option?.rmValue ?? option?.text ?? code;
    const terminology = source?.terminology ?? source?.terminologyId ?? option?.terminology ?? 'local';
    if (!isEmpty(code)) {
      output[`${key}|code`] = code;
      output[`${key}|value`] = displayValue;
      output[`${key}|terminology`] = terminology;
    }
    return;
  }
  if (binding.codeMappings?.enabled && source) {
    // EHRbase FLAT format's convention for a LOCATABLE's non-value
    // structural attributes (TERM_MAPPING among them) is an underscore-
    // prefixed segment - `_mappings` here, mirroring the same convention
    // documented for e.g. `_uid`/`_name`. Unverified against a live
    // EHRbase instance for this specific attribute (this app's own FLAT
    // submit path had no prior mappings usage to confirm against) -
    // canonicalComposition.ts's nested-RM-JSON path (used for the
    // Contribution/atomic-commit flow) is the one built directly against
    // the user's own confirmed-real example composition and is the
    // higher-confidence path of the two.
    writeCodeMappingsFlat(output, key, source.value, source.mappings);
    return;
  }
  output[key] = value;
}

/** A DV_CODED_TEXT/CODE_PHRASE WebTemplate node's own current code list,
 * from whichever `inputs[]` entry actually carries the value set - mirrors
 * webTemplateParser's own `needsOptions`/`codeInput`/`listInput` selection
 * exactly (a coded field's real options can live on a specific `suffix:
 * 'code'`/`type: 'CODED_TEXT'` input rather than the first one), so this
 * reports the same code set a fresh Form Section generated from this node
 * would get. */
function currentCodesOf(node: UnknownRecord): string[] | undefined {
  const rmType = text(node.rmType);
  if (rmType !== 'DV_CODED_TEXT' && rmType !== 'CODE_PHRASE') return undefined;
  const inputs = Array.isArray(node.inputs) ? node.inputs.filter(isRecord) : [];
  const codeInput = inputs.find((input) => text(input.suffix) === 'code' || text(input.type) === 'CODED_TEXT');
  const listInput = codeInput || inputs[0];
  const list = listInput && Array.isArray(listInput.list) ? listInput.list.filter(isRecord) : undefined;
  if (!list || list.length === 0) return undefined;
  const codes = list.map((entry) => text(entry.value)).filter((value): value is string => Boolean(value));
  return codes.length > 0 ? codes : undefined;
}

export function buildOpenEhrPathMap(tree: unknown): Map<string, OpenEhrPathMapping> {
  const map = new Map<string, OpenEhrPathMapping>();
  function walk(node: unknown, prefix: string): void {
    if (!isRecord(node)) return;
    const id = text(node.id) || text(node.name);
    const current = id ? (prefix ? `${prefix}/${id}` : id) : prefix;
    const aqlPath = text(node.aqlPath);
    const rmType = text(node.rmType);
    const codes = currentCodesOf(node);
    if (aqlPath && current) map.set(aqlPath, { flatPath: current, ...(rmType ? { rmType } : {}), ...(codes ? { codes } : {}) });
    if (Array.isArray(node.children)) node.children.forEach((child) => walk(child, current));
  }
  walk(tree, '');
  return map;
}

export type BindingAuditIssue = 'unresolved-path' | 'rmtype-mismatch' | 'stale-option';

export interface BindingAuditFinding {
  /** The Form Section field/container's own id (from its layout node). */
  fieldId: string;
  /** The stored binding's archetype path, exactly as saved on the form -
   * what actually got checked against the current template. */
  path: string;
  issue: BindingAuditIssue;
  detail: string;
}

/** Checks a Form Section's own stored bindings against the CURRENT state of
 * its source template (a freshly re-imported WebTemplate tree, e.g. via
 * import_remote_template) rather than whatever the template looked like
 * when the Form Section was originally built or last regenerated.
 *
 * A binding is a snapshot, not a live reference - a template can change
 * (an archetype gets re-versioned, a value set gains/loses codes, a node's
 * RM type changes) with nothing to tell an existing Form Section it's now
 * stale, until a doctor's submission fails at EHRbase with a 4xx or -
 * worse, per the FLAT-composition group-binding bug fixed alongside this -
 * silently drops data instead of failing loudly at all. This surfaces that
 * drift proactively, at design/publish time, from the same information a
 * regeneration would use.
 *
 * Deliberately narrow in scope for what it flags: whether each binding's
 * path still resolves, whether its rmType still matches, and whether a
 * coded field's stored options are still valid codes. It does NOT attempt
 * to detect "this field should now be part of a repeatable group" -
 * webTemplateParser's own generator (generate_form_from_template/
 * apply_template_to_form) is the authoritative source for repeat structure
 * and already reflects a re-imported template correctly; re-deriving that
 * judgement independently here risked false positives the generator itself
 * doesn't have. */
export function auditFormBindings(definition: Pick<CanonicalForm, 'layout'>, webTemplateTree: unknown): BindingAuditFinding[] {
  const pathMap = buildOpenEhrPathMap(webTemplateTree);
  const findings: BindingAuditFinding[] = [];
  function walk(node: CanonicalForm['layout']): void {
    const binding = layoutFieldBinding(node.binding);
    const fieldId = node.id || '(unnamed)';
    if (binding?.path) {
      const mapping = pathMap.get(binding.path);
      if (!mapping) {
        findings.push({ fieldId, path: binding.path, issue: 'unresolved-path', detail: `No node in the current template resolves this path anymore - the archetype was likely re-versioned or restructured since this binding was set.` });
      } else {
        if (binding.rmType && mapping.rmType && binding.rmType !== mapping.rmType) {
          findings.push({ fieldId, path: binding.path, issue: 'rmtype-mismatch', detail: `Form Section expects ${binding.rmType}, current template has ${mapping.rmType} at this path.` });
        }
        const rawOptions = (node as unknown as UnknownRecord).options;
        if (mapping.codes && Array.isArray(rawOptions)) {
          const staleValues = rawOptions
            .filter(isRecord)
            .map((option) => text(option.value))
            .filter((value): value is string => Boolean(value) && !mapping.codes!.includes(value!));
          if (staleValues.length > 0) {
            findings.push({ fieldId, path: binding.path, issue: 'stale-option', detail: `Option(s) ${staleValues.join(', ')} are no longer valid codes in the current template - EHRbase would reject a submission that picks one of them.` });
          }
        }
      }
    }
    node.children?.forEach(walk);
  }
  walk(definition.layout);
  return findings;
}

interface CodedTextOption {
  value: string;
  /** Display text (UI's preferred language) - never write this into
   * DV_CODED_TEXT.value, see rmValue. */
  text?: string;
  /** The archetype's original/default-language term text - what EHRbase's
   * FLAT-composition validator checks DV_CODED_TEXT.value against. Falls
   * back to `text` when absent (an English-default template with no
   * separate translation, or an older Form Section saved before this field
   * existed - see setFlatValue's DV_CODED_TEXT branch). */
  rmValue?: string;
  terminology?: string;
}

interface FieldBinding {
  path?: string;
  rmType?: string;
  flatPath?: string;
  options?: CodedTextOption[];
  codeMappings?: CodeMappingConfig;
  /** See FormElementLayout.allowFreeText (core/canonical) - must be read
   * together with `options` wherever a DV_CODED_TEXT value is written, or a
   * free-text value would silently get forced into a bogus `code_string`
   * instead of falling back to DV_TEXT (see setFlatValue's DV_CODED_TEXT
   * branch). */
  allowFreeText?: boolean;
  /** The id of the nearest enclosing `repeatable: true` container, if any -
   * mirrors core/form-runtime's own `repeatableGroupId` derivation exactly
   * (a repeatable container's own id, inherited by every descendant until
   * another repeatable container is entered). A repeatable *group* container
   * itself has no `.binding` (confirmed live: a Laborpanel's
   * `laboratory_analyte_result` container carries `repeatMin`/`repeatMax`/
   * `repeatable` but no binding at all) - only this per-member marker lets
   * toOpenEhrFlatComposition recognise `values[groupId]` as a group's row
   * array instead of silently dropping it as an unbound field (see the
   * comment above the group-handling loop there for what that dropping
   * looked like in practice). */
  repeatableGroupId?: string;
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
  // repeatableGroupId threading mirrors core/form-runtime/index.ts's own
  // `walk()` exactly: a `container` node with `repeatable: true` and an id
  // becomes the group id for itself and every descendant, until another
  // repeatable container is entered - not just direct children, since a
  // group's members here sit two levels deeper (container > row > column >
  // field), matching every real repeatable-group form in this app.
  function walk(node: CanonicalForm['layout'], repeatableGroupId?: string): void {
    const nodeType = (node as unknown as Record<string, unknown>).type;
    const isRepeatableContainer = nodeType === 'container' && (node as unknown as Record<string, unknown>).repeatable === true && Boolean(node.id);
    const childGroupId = isRepeatableContainer ? node.id : repeatableGroupId;
    const binding = layoutFieldBinding(node.binding);
    const rawOptions = (node as unknown as Record<string, unknown>).options;
    const options = Array.isArray(rawOptions)
      ? rawOptions.flatMap((option): CodedTextOption[] => {
        if (!isRecord(option) || !text(option.value)) return [];
        const value = text(option.value)!;
        const optionText = text(option.text) || text(option.label);
        const rmValue = text(option.rmValue);
        const terminology = text(option.terminology) || text(option.terminologyId);
        return [{
          value,
          ...(optionText ? { text: optionText } : {}),
          ...(rmValue ? { rmValue } : {}),
          ...(terminology ? { terminology } : {}),
        }];
      })
      : undefined;
    const codeMappings = node.codeMappings?.enabled ? node.codeMappings : undefined;
    const allowFreeText = (node as unknown as Record<string, unknown>).allowFreeText === true;
    if (node.id && binding) {
      map.set(node.id, {
        ...binding,
        ...(options?.length ? { options } : {}),
        ...(codeMappings ? { codeMappings } : {}),
        ...(allowFreeText ? { allowFreeText } : {}),
        // The group container's own id never applies to itself as a member -
        // only to its descendants (repeatableGroupId, not childGroupId).
        ...(repeatableGroupId ? { repeatableGroupId } : {}),
      });
    }
    node.children?.forEach((child) => walk(child, childGroupId));
  }
  walk(layout);
  return map;
}

function resolveFlatPath(binding: FieldBinding, pathMap?: Map<string, OpenEhrPathMapping>): string | undefined {
  return text(binding.flatPath) || (binding.path ? pathMap?.get(binding.path)?.flatPath : undefined) || text(binding.path);
}

/** Inserts `:index` right after a repeating group's own path segment (its
 * literal id, e.g. "laboratory_analyte_result") - the openEHR FLAT
 * convention for a repeating structural node's occurrence index, confirmed
 * against readFlatValue's own reader (its regex already accepts `:\d+`
 * after ANY segment, generically, to support exactly this). Writing the
 * index at the END of the path instead (indexedPath's plain convention,
 * correct for a simple repeating LEAF field) would misplace it past the
 * leaf - `.../laboratory_analyte_result/analyte_name:0` isn't a group
 * repetition EHRbase's FLAT parser recognises, it's nonsense.
 *
 * The group's own structural path segment is NOT derivable from the
 * groupId string itself - groupId is the form's UI-level field id (e.g.
 * "laboratory_analyte_result"), while flatPath is built from the openEHR
 * archetype's own node ids (e.g. ".../items[CLUSTER.laboratory_test_analyte]
 * /items[at0024]") and has no reason to contain the UI id as a literal
 * substring (an earlier version of this function assumed it did, via
 * `flatPath.indexOf('/${groupId}/')`, and silently never matched on any
 * real form - confirmed live, this is why the first fix attempt still
 * produced `undefined` for every indexed lookup). Instead the insertion
 * point is derived structurally: the longest common path prefix shared by
 * every member field's flatPath is exactly the group's own repeating
 * segment, since sibling members diverge only in their leaf-level archetype
 * code (`items[at0024]` vs `items[at0001]` etc.) after that point. */
function commonPathPrefix(paths: string[]): string {
  const segmentsList = paths.filter((path) => path.length > 0).map((path) => path.split('/'));
  const first = segmentsList[0];
  if (!first) return '';
  let end = first.length;
  for (let i = 1; i < segmentsList.length; i++) {
    const segs = segmentsList[i] ?? [];
    let j = 0;
    while (j < end && j < segs.length && segs[j] === first[j]) j++;
    end = j;
  }
  // A single-member group (or, degenerately, members that share an
  // identical path) makes the "common prefix" the whole path, which would
  // place the index inside the leaf's own segment rather than the group's.
  // Back off one segment so it lands on the group's structural node instead.
  if (end === first.length && segmentsList.every((segs) => segs.length === first.length && segs.every((seg, i) => seg === first[i]))) {
    end = Math.max(0, end - 1);
  }
  return first.slice(0, end).join('/');
}

function insertIndexAtPrefix(flatPath: string, groupPrefix: string, index: number): string {
  if (!groupPrefix || !flatPath.startsWith(`${groupPrefix}/`)) return flatPath;
  return `${groupPrefix}:${index}${flatPath.slice(groupPrefix.length)}`;
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
  // Repeatable *groups* first (values[groupId] = one row object per
  // occurrence, keyed by field id exactly like FormRuntime's own
  // `row[field.id]` reads - see core/form-runtime's repeatableGroupId doc).
  // Must run before the plain per-field loop below: a group id is never
  // itself a bound leaf field (its container has no `.binding` at all - see
  // FieldBinding.repeatableGroupId's own comment), so without this pass
  // `values[groupId]` would just silently fail the `!binding` check in that
  // loop and the entire group would be dropped - confirmed live, this is
  // exactly how a Laborpanel's 9 analyte rows never reached EHRbase at all
  // (only the panel's own top-level "Test name" field, a real leaf, made it
  // through). Every other CanonicalForm-consuming form (no repeatable
  // groups) sees zero behavioural change from this loop, since the `some(...)`
  // guard only fires for a key that's genuinely a group id.
  for (const [groupId, rows] of Object.entries(values)) {
    if (!Array.isArray(rows) || layoutBindings.has(groupId)) continue;
    const memberEntries = Array.from(layoutBindings.entries()).filter(([, binding]) => binding.repeatableGroupId === groupId);
    if (memberEntries.length === 0) continue;
    const memberPaths = memberEntries
      .map(([, binding]) => resolveFlatPath(binding, pathMap))
      .filter((path): path is string => Boolean(path));
    const groupPrefix = commonPathPrefix(memberPaths);
    rows.forEach((row, index) => {
      if (!isRecord(row)) return;
      for (const [subFieldId, subBinding] of memberEntries) {
        const subValue = row[subFieldId];
        if (isEmpty(subValue)) continue;
        const flatPath = resolveFlatPath(subBinding, pathMap);
        if (!flatPath) continue;
        setFlatValue(flat, insertIndexAtPrefix(flatPath, groupPrefix, index), subBinding, subValue);
      }
    });
  }
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

/** Reconstructs a codeMappings.enabled field's `mappings/N` group of flat
 * keys (see writeCodeMappingsFlat) back into CodeMappingValue[] - the
 * counterpart read half of that write convention. Silently returns []
 * rather than throwing on a malformed/partial group (a `target|code` with
 * no matching `target|terminology`, say) - this is enrichment on top of
 * the field's own already-valid text value, never something that should
 * fail the whole read. */
function readCodeMappings(flat: Record<string, unknown>, path: string): Array<{ terminologyId: string; code: string; match?: string }> {
  const prefix = `${path}/mappings/`;
  const indices = new Set<number>();
  for (const key of Object.keys(flat)) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const index = Number(rest.split(/[/|]/)[0]);
    if (Number.isInteger(index) && index >= 0) indices.add(index);
  }
  return Array.from(indices).sort((a, b) => a - b).flatMap((index) => {
    const entryPrefix = `${prefix}${index}`;
    const code = flat[`${entryPrefix}/target|code`];
    const terminologyId = flat[`${entryPrefix}/target|terminology`];
    if (isEmpty(code) || isEmpty(terminologyId)) return [];
    const match = flat[`${entryPrefix}|match`];
    return [{ terminologyId: String(terminologyId), code: String(code), ...(typeof match === 'string' && match ? { match } : {}) }];
  });
}

export function fromOpenEhrFlatComposition(definition: CanonicalForm, composition: Record<string, unknown>, webTemplateTree?: unknown): FormSessionValues {
  const values: FormSessionValues = {};
  const pathMap = webTemplateTree === undefined ? undefined : buildOpenEhrPathMap(webTemplateTree);
  const layoutBindings = collectFieldBindings(definition.layout);
  const processedPaths = new Set<string>();
  const readOne = (binding: FieldBinding, flatPath: string): unknown => {
    const value = readFlatValue(composition, flatPath, binding.rmType);
    if (isEmpty(value) || !binding.codeMappings?.enabled) return value;
    const mappings = readCodeMappings(composition, flatPath);
    return { value, ...(mappings.length > 0 ? { mappings } : {}) };
  };
  for (const [fieldId, binding] of layoutBindings) {
    const flatPath = resolveFlatPath(binding, pathMap);
    if (flatPath) processedPaths.add(flatPath);
    const value = flatPath ? readOne(binding, flatPath) : undefined;
    if (!isEmpty(value)) values[fieldId] = value;
  }
  for (const [fieldId, wrapped] of Object.entries(definition.bindings)) {
    const binding = wrapped.openehr;
    const flatPath = resolveFlatPath(binding, pathMap);
    if (flatPath && processedPaths.has(flatPath)) continue;
    const value = flatPath ? readOne(binding, flatPath) : undefined;
    if (!isEmpty(value)) values[fieldId] = value;
  }
  return values;
}
