/**
 * Canonical (nested RM JSON) Composition builder - Epic 4.
 *
 * `toOpenEhrFlatComposition` (index.ts) has always been enough for EHRbase's
 * plain `POST /composition?format=FLAT` endpoint, which this app has used
 * exclusively so far. The Contribution endpoint
 * (`POST /ehr/{ehr_id}/contribution`) does NOT accept FLAT/STRUCTURED on
 * this deployment - confirmed live against its OpenAPI schema, which only
 * declares `application/json`/`application/xml` (canonical) request bodies
 * for that endpoint. Building a real openEHR CONTRIBUTION therefore
 * genuinely needs nested RM JSON, which nothing in this codebase produced
 * before this file.
 *
 * Reuse, not a parallel implementation: this walks the exact same WebTemplate
 * tree `buildOpenEhrPathMap`/`toOpenEhrFlatComposition` already consume, and
 * matches its nodes against fields via the same Path Engine identity
 * (`RuntimeFieldDescriptor.aqlPath`, i.e. `node.binding.path` - see
 * `collectRuntimeFields` in core/form-runtime and `getAqlPath` in
 * metadata.ts) rather than a second path-parsing scheme. Per-type DV_*
 * serialization intentionally matches `setFlatValue`'s own scope exactly:
 * real handling for DV_QUANTITY and DV_CODED_TEXT/CODE_PHRASE (the only
 * types EHRbase actually validates strictly), best-effort passthrough for
 * everything else - not an attempt at full RM conformance for types this
 * app doesn't otherwise support as editable fields.
 */
import type { CanonicalForm, RuntimeFieldDescriptor, RuntimeValue, RuntimeValues } from 'core';
import { collectRuntimeFields } from 'core';
import { parseOpenEhrAqlPath } from './metadata';

export interface CanonicalCompositionContext {
  language?: string;
  territory?: string;
  time?: string;
  composerName?: string;
  composerId?: string;
}

type Canonical = Record<string, unknown>;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === '';

/** Shape of one WebTemplate tree node, as returned by
 * `getRemoteWebTemplate`/EHRbase's own `/definition/template/adl1.4/{id}` -
 * confirmed live (root has no aqlPath; every other node does). */
export interface WebTemplateTreeNode {
  id: string;
  name?: string;
  localizedName?: string;
  rmType: string;
  nodeId?: string;
  min?: number;
  max?: number;
  aqlPath?: string;
  children?: WebTemplateTreeNode[];
  inputs?: Array<{ suffix?: string; type?: string; list?: Array<{ value: string; label?: string }> }>;
}

const STRUCTURAL_RM_TYPES = new Set([
  'COMPOSITION', 'SECTION', 'ADMIN_ENTRY', 'EVALUATION', 'OBSERVATION',
  'ACTION', 'INSTRUCTION', 'ACTIVITY', 'CLUSTER', 'ITEM_TREE', 'ITEM_LIST',
  'ITEM_TABLE', 'ITEM_SINGLE', 'EVENT_CONTEXT', 'HISTORY', 'EVENT',
  'POINT_EVENT', 'INTERVAL_EVENT',
]);

function isRepeating(node: WebTemplateTreeNode): boolean {
  return node.max !== undefined && node.max !== 1;
}

function codePhrase(terminologyId: string, code: string): Canonical {
  return { _type: 'CODE_PHRASE', terminology_id: { _type: 'TERMINOLOGY_ID', value: terminologyId }, code_string: code };
}

function dvText(value: string): Canonical {
  return { _type: 'DV_TEXT', value };
}

function dvDateTime(value: string): Canonical {
  return { _type: 'DV_DATE_TIME', value };
}

function nodeLabel(node: WebTemplateTreeNode): string {
  return node.localizedName || node.name || node.id;
}

// A LOCATABLE whose own archetype_node_id IS an archetype id (not merely a
// local at-code) is the root of that archetype, and openEHR requires it to
// carry `archetype_details` - confirmed live (EHRbase rejects a Composition,
// and any archetype-rooted EVALUATION/CLUSTER/etc. within it, with "missing
// mandatory attribute: archetype details" otherwise). A plain at-code alone
// never gets this (it isn't its own archetype root).
const ARCHETYPE_ID_RE = /^openEHR-[A-Z_]+-[A-Z_]+\.[a-zA-Z0-9_-]+\.v\d+(?:\.\d+){0,2}$/;

function archetypeDetails(archetypeNodeId: string, opts?: { templateId?: string; rmVersion?: string }): Canonical | undefined {
  if (!ARCHETYPE_ID_RE.test(archetypeNodeId)) return undefined;
  return {
    _type: 'ARCHETYPED',
    archetype_id: { _type: 'ARCHETYPE_ID', value: archetypeNodeId },
    ...(opts?.templateId ? { template_id: { _type: 'TEMPLATE_ID', value: opts.templateId } } : {}),
    rm_version: opts?.rmVersion || '1.0.4',
  };
}

/** `{archetype_node_id, archetype_details?}` for one structural WebTemplate
 * node - the one place every structural builder derives its identity from,
 * so archetype_details is never forgotten at a new call site. */
function nodeIdentity(node: WebTemplateTreeNode, opts?: { templateId?: string }): Canonical {
  const archetypeNodeId = node.nodeId || node.id;
  const details = archetypeDetails(archetypeNodeId, opts);
  return { archetype_node_id: archetypeNodeId, ...(details ? { archetype_details: details } : {}) };
}

/** Same per-type leaf serialization `setFlatValue` (index.ts) uses, targeting
 * a canonical DV_* object instead of a `key|suffix` flat-map entry. Kept
 * side-by-side deliberately rather than factored into one shared function -
 * the flat and canonical shapes diverge enough (indexed keys vs. nested
 * objects) that a shared helper would need as much branching as either
 * implementation alone; what IS shared is which types get real handling. */
/** RM data_types.text 5.2.2: TERM_MAPPING.match is a `char`, constrained to
 * exactly these four values ('>' broader, '=' equivalent, '<' narrower, '?'
 * unknown) - confirmed against the current openEHR RM Data Types spec while
 * validating this file against it (2026-09-02). Nothing in this app
 * currently sets a custom match value (every caller either omits it or
 * relies on the '=' default), so this has never fired live, but without it
 * a future caller passing any other string - a form script, a future UI
 * that lets a clinician pick a mapping's match type - would silently
 * produce an RM-invalid TERM_MAPPING. */
const VALID_TERM_MAPPING_MATCH = new Set(['>', '=', '<', '?']);

function normalizedTermMappingMatch(value: unknown): string {
  return typeof value === 'string' && VALID_TERM_MAPPING_MATCH.has(value) ? value : '=';
}

/** Shared by both the DV_TEXT and DV_CODED_TEXT codeMappings branches below -
 * builds the TERM_MAPPING list from a codeMappings.enabled field's runtime
 * `{value, mappings?}` shape. Deliberately no `purpose`/`preferred_term` -
 * real-world example compositions for this exact use (a free-text diagnosis
 * tagged with an ICD-10-GM code) only ever carry {match, target:
 * {terminology_id, code_string}}. */
function buildTermMappings(source: Record<string, unknown>): Canonical[] {
  const mappings = Array.isArray(source.mappings) ? source.mappings : [];
  return mappings.flatMap((entry): Canonical[] => {
    if (!isRecord(entry) || isEmpty(entry.terminologyId) || isEmpty(entry.code)) return [];
    return [{
      _type: 'TERM_MAPPING',
      match: normalizedTermMappingMatch(entry.match),
      target: codePhrase(String(entry.terminologyId), String(entry.code)),
    }];
  });
}

function buildLeafDvValue(rmType: string | undefined, field: RuntimeFieldDescriptor | undefined, value: unknown): unknown {
  if (isEmpty(value)) return undefined;
  const source = isRecord(value) ? value : undefined;
  if (rmType === 'DV_QUANTITY') {
    // RM data_types.quantity 6.2.8: the mandatory (1..1) unit attribute on
    // DV_QUANTITY is named `units` (plural) - `unit` is not a real RM
    // attribute. Confirmed live-path-relevant: this canonical (nested RM
    // JSON) branch is the one actually used for real submissions (see the
    // codeMappings override comment on buildNode above); every DV_QUANTITY
    // field in the app (vitals, lab magnitudes, anything numeric with a
    // unit) was serializing an EHRbase-unrecognized `unit` key instead of
    // the required `units`, which DV_QUANTITY's own invariant makes
    // mandatory. The FLAT-format path (index.ts's setFlatValue) is
    // unaffected - EHRbase's FLAT suffix convention for this is genuinely
    // `|unit` (singular), a different, correct convention from the
    // structured JSON attribute name used here.
    const magnitude = source?.magnitude ?? value;
    if (isEmpty(magnitude)) return undefined;
    return { _type: 'DV_QUANTITY', magnitude: typeof magnitude === 'string' ? Number(magnitude) : magnitude, units: source?.unit ?? '1' };
  }
  if (rmType === 'DV_CODED_TEXT' || rmType === 'CODE_PHRASE') {
    // codeMappings.enabled on a DV_CODED_TEXT-bound field is a deliberate
    // dual-encoding some HIP FHIR mapping documents require (e.g.
    // "Problem/Diagnosis name"/at0002 in the real Condition<->vg_Diagnosis
    // mapping: storageClass "DvCodedText" with BOTH `mappings` and
    // `definingCode` populated from the same code, unlike "Diagnostic
    // category"/at0063's storageClass "DvText" which only needed
    // `mappings`). This bends openEHR RM data_types.text 5.2.4's own
    // "Misuse" guidance (free text tagged with a code should be DV_TEXT +
    // TERM_MAPPING, not DV_CODED_TEXT, since DV_CODED_TEXT.value is
    // supposed to be the terminology's own exact rubric) - a deliberate,
    // explicit product decision ("HIP converter is king") for this one
    // field, not a general pattern. Using an external terminology_id here
    // (never "local") means EHRbase has no registered rubric to validate
    // `value` against, so the free-typed text is accepted regardless.
    if (field?.codeMappings?.enabled && source) {
      const text = source.value;
      if (isEmpty(text)) return undefined;
      const termMappings = buildTermMappings(source);
      const [primary] = termMappings;
      // No code entered yet: DV_CODED_TEXT.defining_code is RM-mandatory
      // (1..1), so there is nothing valid to build - fall back to the
      // plain DV_TEXT the WebTemplate itself would otherwise have used,
      // rather than fabricate a code or drop the diagnosis text entirely.
      if (!primary) return { _type: 'DV_TEXT', value: String(text) };
      return { _type: 'DV_CODED_TEXT', value: String(text), defining_code: primary.target, mappings: termMappings };
    }
    const code = source?.code ?? source?.value ?? value;
    if (isEmpty(code)) return undefined;
    const option = field?.options.find((candidate) => candidate.value === String(code));
    // Same free-text fallback as openehr-engine/src/index.ts's setFlatValue
    // (the FLAT-format live path) - a DV_CODED_TEXT|DV_TEXT union field
    // (field.allowFreeText, from the OPT constraint model) whose value
    // matches no known option is free text being used, not a coded
    // selection missing metadata; writing it into defining_code.code_string
    // would be RM-invalid. CODE_PHRASE has no DV_TEXT equivalent to fall
    // back to, so this only applies to DV_CODED_TEXT itself.
    if (!option && field?.allowFreeText && rmType === 'DV_CODED_TEXT') return { _type: 'DV_TEXT', value: String(code) };
    // option?.rmValue (the archetype's original/default-language term text)
    // must win over option?.text (the UI's preferred-language display text,
    // German-first) - EHRbase's FLAT-composition validator checks
    // DV_CODED_TEXT.value against the former regardless of UI language, and
    // rejects e.g. "Vermutet"/"Aktiv" expecting "Suspected"/"Active". See
    // FormElementLayout.options[].rmValue's doc comment (packages/core).
    const displayValue = source?.value ?? source?.text ?? source?.label ?? option?.rmValue ?? option?.text ?? code;
    // option?.terminology - the field's static, per-option external
    // terminology_id (see FormElementLayout.options[].terminology, packages/core)
    // - must win over the 'local' default for the uncommon fields whose
    // archetype binding requires a hosted terminology (e.g. vg_Person's
    // Vitalstatus, bound to a FHIR-published ValueSet). This mirrors
    // setFlatValue's already-correct fallback chain in this package's
    // index.ts (the FLAT-format path) - this canonical/structured-RM path
    // was missing the same option-level fallback, defaulting straight to
    // 'local' and getting rejected by EHRbase with "terminology_id does not
    // match" on every submission of such a field. Confirmed live (2026-09-02).
    const terminology = source?.terminology ?? source?.terminologyId ?? option?.terminology ?? 'local';
    const definingCode = codePhrase(String(terminology), String(code));
    if (rmType === 'CODE_PHRASE') return definingCode;
    return { _type: 'DV_CODED_TEXT', value: String(displayValue), defining_code: definingCode };
  }
  if (rmType === 'DV_BOOLEAN') return { _type: 'DV_BOOLEAN', value: Boolean(value) };
  if (rmType === 'DV_COUNT') {
    // RM data_types.quantity: DV_COUNT.magnitude is Integer, not Real -
    // unlike DV_QUANTITY, which genuinely allows fractional magnitudes.
    // getInputType() maps DV_COUNT to the same generic 'input-number'
    // widget as DV_DECIMAL, with no integer-only constraint enforced
    // anywhere upstream, so a user can freely type "3.7" into a
    // DV_COUNT-bound field - confirmed while validating this file against
    // the RM spec (2026-09-02). Round here, at the RM-strict serialization
    // boundary, rather than trust every upstream input path to have
    // already enforced it (the same defensive posture buildLeafDvValue
    // already takes for `units` vs `unit` above).
    const raw = typeof value === 'string' ? Number(value) : value;
    return { _type: 'DV_COUNT', magnitude: typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : raw };
  }
  if (rmType === 'DV_DATE') return { _type: 'DV_DATE', value: String(value) };
  if (rmType === 'DV_DATE_TIME') return { _type: 'DV_DATE_TIME', value: String(value) };
  if (rmType === 'DV_DURATION') return { _type: 'DV_DURATION', value: String(value) };
  if (rmType === 'DV_TEXT') {
    // codeMappings.enabled fields carry {value, mappings?} instead of a
    // plain string (see core's CodeMappedTextValue) - the text itself is
    // unaffected, mappings ride alongside as DV_TEXT.mappings (RM:
    // List<TERM_MAPPING>).
    if (field?.codeMappings?.enabled && source) {
      const text = source.value;
      if (isEmpty(text)) return undefined;
      const termMappings = buildTermMappings(source);
      return { _type: 'DV_TEXT', value: String(text), ...(termMappings.length > 0 ? { mappings: termMappings } : {}) };
    }
    return { _type: 'DV_TEXT', value: String(value) };
  }
  if (rmType === 'DV_IDENTIFIER') {
    if (source) return { _type: 'DV_IDENTIFIER', ...source };
    // A field bound straight to a DV_IDENTIFIER slot with no dedicated
    // compound-value widget (this app has none) still submits a plain
    // string - confirmed live (vg_MedicationAdministration's
    // "ID der Verordnung"/at0103 protocol slot: DV_IDENTIFIER is the ONLY
    // declared alternative, no DV_TEXT to fall back to the way Lab's
    // requester_order_identifier could). `id` is DV_IDENTIFIER's one
    // RM-mandatory (1..1) attribute; `issuer`/`assigner`/`type` are all
    // 0..1 and safely omitted rather than filled with fabricated values.
    return { _type: 'DV_IDENTIFIER', id: String(value) };
  }
  // Best-effort generic passthrough for any other DV_* leaf this app lets a
  // field bind to without dedicated handling - same scope boundary as
  // setFlatValue's `output[key] = value` fallback.
  return { _type: rmType, value };
}

function buildElement(node: WebTemplateTreeNode, field: RuntimeFieldDescriptor | undefined, dvValue: unknown): Canonical | undefined {
  if (dvValue === undefined) return undefined;
  // Some WebTemplate leaves omit their own `nodeId` (confirmed live - a
  // coded-text field can have `nodeId: undefined` even though its aqlPath
  // plainly ends in an at-code) - fall back to the same at-code extraction
  // parseOpenEhrAqlPath already uses everywhere else, rather than ever
  // shipping the WebTemplate's own field id as a fake archetype_node_id.
  const archetypeNodeId = node.nodeId || field?.archetypeNodeId || parseOpenEhrAqlPath(field?.aqlPath).archetypeNodeId || node.id;
  return { _type: 'ELEMENT', name: dvText(nodeLabel(node)), archetype_node_id: archetypeNodeId, value: dvValue };
}

/** One field's raw value, read from whichever scope currently applies -
 * either the session's top-level RuntimeValues, or one row object of a
 * repeatable group (`values[groupId][rowIndex]`, keyed by field id exactly
 * like the top level - see FormRuntime.tsx's own `row[field.id]` reads). */
function fieldValue(scope: RuntimeValues, fieldId: string): RuntimeValue {
  return scope[fieldId];
}

interface FieldIndex {
  /**
   * One aqlPath can have more than one candidate field - confirmed live
   * (a polymorphic/union RM slot, e.g. an at-code typed as "DV_TEXT or
   * DV_IDENTIFIER", shows up in the WebTemplate as a single ambiguous
   * `rmType: 'ELEMENT'` node, and the Form Builder exposes it as two
   * separate fields, one per alternative, both bound to the identical
   * path). `resolveField` picks whichever candidate actually has a value in
   * the current scope, so building a leaf never silently prefers one
   * alternative over another that's actually filled in.
   */
  byAqlPath: Map<string, RuntimeFieldDescriptor[]>;
  resolveField: (aqlPath: string, scope: RuntimeValues) => RuntimeFieldDescriptor | undefined;
  descendantGroupField: (aqlPath: string) => RuntimeFieldDescriptor | undefined;
}

/** Unwraps a layout node's raw `.binding` the same way openehr-engine's own
 * `layoutFieldBinding()` (index.ts) does: some forms store the direct
 * `{path, rmType, ...}` shape inline, others wrap it as `{openehr: {...}}`
 * (confirmed live - vg_ObservationLab's fields use this wrapper on the
 * layout node itself, not just in the legacy top-level bindings map).
 * `RuntimeFieldDescriptor.aqlPath`/`.semanticType` only read the direct
 * shape (`node.binding?.path`), so this recovers the wrapped case from the
 * descriptor's own preserved raw `.binding`, rather than a second
 * independent binding parser. */
function unwrapInlineBinding(binding: unknown): { path?: string; rmType?: string } | undefined {
  if (!isRecord(binding)) return undefined;
  const candidate = isRecord(binding.openehr) ? binding.openehr : binding;
  const path = typeof candidate.path === 'string' ? candidate.path : undefined;
  const rmType = typeof candidate.rmType === 'string' ? candidate.rmType : undefined;
  return path ? { path, ...(rmType ? { rmType } : {}) } : undefined;
}

function buildFieldIndex(definition: CanonicalForm): FieldIndex {
  const fields = collectRuntimeFields(definition);
  const byAqlPath = new Map<string, RuntimeFieldDescriptor[]>();
  for (const field of fields) {
    // Three-tier resolution: a layout-level `node.binding.path` read
    // directly (RuntimeFieldDescriptor.aqlPath), the same node's `.binding`
    // unwrapped from an `{openehr: {...}}` envelope when the direct read
    // came up empty, and finally the legacy top-level
    // `definition.bindings[fieldId].openehr.path` envelope many real forms
    // use instead of any layout-level binding at all (confirmed live -
    // Diagnosis/MedicationStatement/etc. bind this way). All three are
    // real, currently-live shapes, not hypothetical.
    const inlineBinding = field.aqlPath ? undefined : unwrapInlineBinding(field.binding);
    const legacyBinding = field.aqlPath || inlineBinding ? undefined : definition.bindings[field.id]?.openehr;
    const aqlPath = field.aqlPath || inlineBinding?.path || legacyBinding?.path;
    if (!aqlPath) continue;
    const resolved = field.aqlPath ? field : { ...field, aqlPath, semanticType: field.semanticType || inlineBinding?.rmType || legacyBinding?.rmType };
    const existing = byAqlPath.get(aqlPath);
    if (existing) existing.push(resolved); else byAqlPath.set(aqlPath, [resolved]);
  }
  const resolveField = (aqlPath: string, scope: RuntimeValues): RuntimeFieldDescriptor | undefined => {
    const candidates = byAqlPath.get(aqlPath);
    if (!candidates || candidates.length === 0) return undefined;
    if (candidates.length === 1) return candidates[0];
    return candidates.find((field) => fieldValue(scope, field.id) !== undefined) || candidates[0];
  };
  // No group-container aqlPath exists in this app's layout model (repeatable
  // containers are pure UI grouping, not separately bound) - a repeating
  // WebTemplate structural node is matched to a runtime group by finding any
  // member field whose own aqlPath descends from it, same identity Epic 1's
  // Path Engine already establishes per-field.
  const groupFields = Array.from(byAqlPath.values()).flat().filter((field) => field.repeatableGroupId && field.aqlPath);
  const descendantGroupField = (aqlPath: string): RuntimeFieldDescriptor | undefined =>
    groupFields.find((field) => field.aqlPath === aqlPath || field.aqlPath!.startsWith(`${aqlPath}/`) || field.aqlPath!.startsWith(`${aqlPath}[`));
  return { byAqlPath, resolveField, descendantGroupField };
}

/** Resolves the list of (scope, dvValueOverride?) instances a node should be
 * built for, given its own repetition and whichever runtime construct - a
 * repeatable field's value array, or a repeatable group's row array -
 * actually backs it. A non-repeating node (or one with no matching runtime
 * data) always resolves to exactly the current scope, once. */
function resolveScopes(node: WebTemplateTreeNode, scope: RuntimeValues, index: FieldIndex): RuntimeValues[] {
  if (!node.aqlPath) return [scope];
  const leafField = index.resolveField(node.aqlPath, scope);
  if (leafField && !STRUCTURAL_RM_TYPES.has(node.rmType)) {
    // Repeating leaf: values[fieldId] is RuntimeValue[], one entry per
    // occurrence - wrap each as its own single-field scope so the same
    // leaf-building code path below works uniformly.
    const raw = fieldValue(scope, leafField.id);
    if (!isRepeating(node)) return [scope];
    return Array.isArray(raw) ? raw.map((entry) => ({ [leafField.id]: entry })) : (raw === undefined ? [] : [scope]);
  }
  if (isRepeating(node)) {
    const groupField = index.descendantGroupField(node.aqlPath);
    if (groupField?.repeatableGroupId) {
      const rows = scope[groupField.repeatableGroupId];
      return Array.isArray(rows) ? rows.filter(isRecord) as RuntimeValues[] : [];
    }
  }
  return [scope];
}

/**
 * Builds one `_type`-tagged canonical node per entry in `children`, for
 * whichever of `node.children` or a pre-filtered subset (buildEntryData
 * passes only its own data/description children) - shared so both call
 * sites get the same polymorphic-slot dedup below rather than diverging.
 *
 * A polymorphic/union RM slot (e.g. a result value typed "DV_QUANTITY or
 * DV_TEXT or DV_CODED_TEXT") appears in the WebTemplate as multiple sibling
 * nodes that all share the same aqlPath, one per alternative type -
 * confirmed live (vg_ObservationLab's "Analyte result"/at0001 has three
 * such siblings under its CLUSTER.laboratory_test_analyte.v1). buildNode's
 * own leaf branch already resolves the aqlPath to whichever one field
 * actually has a value (index.resolveField), regardless of which sibling
 * node is asking - so without this guard every sibling still gets built,
 * each producing its own ELEMENT at the exact same archetype_node_id: one
 * genuinely valid (serialized with its own concrete rmType), the rest built
 * using a DIFFERENT alternative's rmType against the SAME resolved value
 * (e.g. a DV_QUANTITY {magnitude, unit} object serialized as if it were
 * DV_CODED_TEXT), producing DV_CODED_TEXT.value: "[object Object]" and a
 * defining_code.code_string that's an object, not a string. EHRbase rejects
 * the whole Composition over that duplicate with
 * "Invariant Inv_null_flavour_indicated failed on type ELEMENT" - it never
 * mentions the duplication itself, since a null-flavour-lacking malformed
 * ELEMENT is exactly what that invariant polices. Track which aqlPaths
 * already resolved to a real field among a node's own children and skip any
 * further sibling that maps to the identical one; a genuinely repeating
 * single leaf node is unaffected, since its repeats come from
 * resolveScopes() returning multiple scopes for that one node, never from
 * more than one node sharing its aqlPath.
 */
function buildChildren(children: WebTemplateTreeNode[], scope: RuntimeValues, index: FieldIndex, context: CanonicalCompositionContext = {}): Canonical[] {
  const results: Canonical[] = [];
  const builtLeafPaths = new Set<string>();
  for (const child of children) {
    if (child.aqlPath && !STRUCTURAL_RM_TYPES.has(child.rmType) && index.resolveField(child.aqlPath, scope)) {
      if (builtLeafPaths.has(child.aqlPath)) continue;
      builtLeafPaths.add(child.aqlPath);
    }
    for (const childScope of resolveScopes(child, scope, index)) {
      const built = buildNode(child, childScope, index, context);
      if (built !== undefined) results.push(built as Canonical);
    }
  }
  return results;
}

function buildStructuralChildren(node: WebTemplateTreeNode, scope: RuntimeValues, index: FieldIndex): Canonical[] {
  return buildChildren(node.children || [], scope, index);
}

function itemTree(node: WebTemplateTreeNode, scope: RuntimeValues, index: FieldIndex): Canonical {
  return { _type: 'ITEM_TREE', name: dvText(nodeLabel(node)), ...nodeIdentity(node), items: buildStructuralChildren(node, scope, index) };
}

/** ENTRY-level RM attributes (`subject`, `language`, `encoding`, `provider`,
 * `other_participations`, `workflow_id`, `protocol[...]`) appear as ordinary
 * children right alongside the clinical `data`/`description` branch in the
 * WebTemplate tree - confirmed live (a real EVALUATION node's children
 * included `subject`/`language`/`encoding` siblings next to its `data`
 * items). None of this app's forms exposes these as editable fields, so
 * they're excluded from the clinical-data walk and filled from context/
 * fixed defaults instead - never accidentally nested into `data.items`. */
function isEntryMetaChild(child: WebTemplateTreeNode): boolean {
  const path = child.aqlPath || '';
  return /\/(subject|language|encoding|provider|other_participations|workflow_id|composer)$/.test(path) || path.includes('/protocol[');
}

/** The one bracketed at-code identifying a data/description wrapper node
 * that the WebTemplate export flattened away (single-occurrence structural
 * nodes like ITEM_TREE are consistently omitted from the visible tree, the
 * same behaviour already confirmed for ELEMENT) - scraped from any
 * surviving child's own aqlPath rather than guessed. */
function wrapperNodeId(children: WebTemplateTreeNode[], segment: string): string | undefined {
  const re = new RegExp(`/${segment}\\[(at\\d+(?:\\.\\d+)?)\\]`, 'g');
  for (const child of children) {
    if (!child.aqlPath) continue;
    // An ancestor RM node can use the same segment keyword earlier in the
    // same path (e.g. an OBSERVATION's own top `/data[at0001]` slot, with
    // an EVENT's inner `/data[at0003]` wrapper further along the very same
    // aqlPath) - the LAST occurrence is always the nearest-enclosing one,
    // i.e. this wrapper's own id, never an outer ancestor's.
    let match: RegExpExecArray | null;
    let last: RegExpExecArray | undefined;
    while ((match = re.exec(child.aqlPath))) last = match;
    if (last) return last[1];
  }
  return undefined;
}

function buildEntryData(node: WebTemplateTreeNode, scope: RuntimeValues, index: FieldIndex, context: CanonicalCompositionContext, segment: string): Canonical {
  const dataChildren = (node.children || []).filter((child) => !isEntryMetaChild(child) && (child.aqlPath || '').includes(`/${segment}[`));
  const items = buildChildren(dataChildren, scope, index, context);
  return { _type: 'ITEM_TREE', name: dvText('Tree'), archetype_node_id: wrapperNodeId(dataChildren, segment) || 'at0001', items };
}

/** ENTRY-level attributes (language/encoding/subject) every ADMIN_ENTRY/
 * EVALUATION/OBSERVATION/ACTION/INSTRUCTION requires - not template-bound in
 * this app's forms (no form exposes "who is this entry about" as a field;
 * it's always the composition's own subject), so filled with the same
 * defaults a real composition committed against this deployment used. */
function entryAttributes(context: CanonicalCompositionContext): Canonical {
  return {
    language: codePhrase('ISO_639-1', context.language || 'de'),
    encoding: codePhrase('IANA_character-sets', 'UTF-8'),
    subject: { _type: 'PARTY_SELF' },
  };
}

/** `protocol` (0..1 on CARE_ENTRY - both OBSERVATION and ACTION) is a
 * sibling branch of `data`/`description` right alongside it in the
 * WebTemplate tree, never nested under either - confirmed live
 * (vg_ObservationLab's `requester_order_identifier` and
 * vg_MedicationAdministration's `order_identifier` both bind under
 * `/protocol[atXXXX]/...`). isEntryMetaChild already excludes these from
 * buildEntryData's data/description walk (nesting them under data.items
 * would be RM-invalid - protocol is the CARE_ENTRY's own separate
 * attribute), but nothing ever built them into an actual `protocol`
 * attribute - confirmed live twice now, once for each entry type
 * (a filled `requester_order_identifier` silently committed with no
 * `protocol` at all, `null` when read back via AQL). Shared by both the
 * OBSERVATION and ACTION cases below rather than duplicated.
 */
function buildProtocol(node: WebTemplateTreeNode, scope: RuntimeValues, index: FieldIndex, context: CanonicalCompositionContext): Canonical | undefined {
  const protocolChildren = (node.children || []).filter((child) => (child.aqlPath || '').includes('/protocol['));
  if (protocolChildren.length === 0) return undefined;
  const items = buildChildren(protocolChildren, scope, index, context);
  if (items.length === 0) return undefined;
  return { _type: 'ITEM_TREE', name: dvText('Tree'), archetype_node_id: wrapperNodeId(protocolChildren, 'protocol') || 'at0004', items };
}

/** Resolves a field bound to a fixed CARE_ENTRY-level RM attribute that the
 * WebTemplate export never exposes as a visible tree node at all - `time`
 * and `ism_transition/current_state` on ACTION, same category as
 * EVENT_CONTEXT's own `setting` (buildEventContext, above) which already
 * establishes this pattern: these are real, submittable openEHR attributes,
 * just never archetype-modeled ELEMENTs, so nothing in the WebTemplate tree
 * walk would ever visit a field bound to them - they have to be looked up
 * directly by their own conventional suffix path instead. */
function resolveFixedAttributeField(node: WebTemplateTreeNode, index: FieldIndex, scope: RuntimeValues, suffix: string): { field: RuntimeFieldDescriptor; raw: RuntimeValue } | undefined {
  if (!node.aqlPath) return undefined;
  const field = index.resolveField(`${node.aqlPath}${suffix}`, scope);
  if (!field) return undefined;
  const raw = fieldValue(scope, field.id);
  if (raw === undefined) return undefined;
  return { field, raw };
}

function findEventChild(node: WebTemplateTreeNode): WebTemplateTreeNode | undefined {
  return node.children?.find((child) => child.rmType === 'HISTORY')?.children?.find((child) => ['EVENT', 'POINT_EVENT', 'INTERVAL_EVENT'].includes(child.rmType))
    || node.children?.find((child) => ['EVENT', 'POINT_EVENT', 'INTERVAL_EVENT'].includes(child.rmType));
}

function buildObservationData(node: WebTemplateTreeNode, scope: RuntimeValues, index: FieldIndex, context: CanonicalCompositionContext): Canonical {
  const eventNode = findEventChild(node);
  const origin = dvDateTime(context.time || new Date().toISOString());
  // HISTORY is itself a LOCATABLE (openEHR requires its archetype_node_id,
  // confirmed live) - its id is the OBSERVATION's own top `data[atXXXX]`
  // slot, scraped from the event's aqlPath the same way buildEntryData
  // already recovers a flattened wrapper's id elsewhere in this file.
  const historyNodeId = (eventNode?.aqlPath || node.aqlPath || '').match(/\/data\[(at\d+(?:\.\d+)?)\]\/events?\[/)?.[1] || 'at0001';
  if (eventNode) {
    const dataNode = eventNode.children?.find((child) => child.rmType === 'ITEM_TREE');
    const eventData = dataNode
      ? itemTree(dataNode, scope, index)
      // Flattened wrapper (confirmed live, e.g. laboratory_test_result):
      // the ITEM_TREE node itself never appears - its own id has to be
      // scraped from a surviving child's aqlPath, not reused from the
      // EVENT's own id (which is a different, outer RM node).
      : buildEntryData(eventNode, scope, index, context, 'data');
    const event: Canonical = {
      _type: eventNode.rmType === 'INTERVAL_EVENT' ? 'INTERVAL_EVENT' : 'POINT_EVENT',
      name: dvText(nodeLabel(eventNode)),
      archetype_node_id: eventNode.nodeId || eventNode.id,
      time: origin,
      data: eventData,
    };
    return { _type: 'HISTORY', name: dvText(nodeLabel(node)), archetype_node_id: historyNodeId, origin, events: [event] };
  }
  // This template's WebTemplate export flattened HISTORY/EVENT away
  // entirely (single-occurrence wrapper nodes are sometimes omitted from the
  // visible tree - the same behaviour already noted for ELEMENT). Synthesize
  // the one required event directly around this OBSERVATION's own data
  // branch (excluding ENTRY-level siblings like subject/language/encoding).
  return { _type: 'HISTORY', name: dvText(nodeLabel(node)), archetype_node_id: historyNodeId, origin, events: [{ _type: 'POINT_EVENT', name: dvText('Event'), archetype_node_id: 'at0002', time: origin, data: buildEntryData(node, scope, index, context, 'data') }] };
}

function buildNode(node: WebTemplateTreeNode, scope: RuntimeValues, index: FieldIndex, context: CanonicalCompositionContext = {}): unknown {
  const leafField = node.aqlPath ? index.resolveField(node.aqlPath, scope) : undefined;
  if (leafField && !STRUCTURAL_RM_TYPES.has(node.rmType)) {
    // A polymorphic/union RM slot shows up as the ambiguous rmType
    // 'ELEMENT' at the WebTemplate wrapper level (confirmed live - an
    // at-code typed as "DV_TEXT or DV_IDENTIFIER") - the field's OWN
    // resolved binding type is the only reliable source for what to
    // actually serialize in that case.
    //
    // A second, narrower override: a field with codeMappings explicitly
    // enabled is a deliberate form-designer choice to serialize this slot
    // as either DV_TEXT.mappings or DV_CODED_TEXT (with both
    // defining_code and mappings - see buildLeafDvValue) - the specific
    // direction depends on what the target FHIR converter's own mapping
    // document requires per field, which can differ from whatever
    // concrete type the WebTemplate itself reports for the node.
    // Confirmed live both ways: "Diagnostic category" (at0063, WebTemplate
    // rmType DV_CODED_TEXT, binding declares DV_TEXT) and "Problem/
    // Diagnosis name" (at0002, WebTemplate rmType DV_TEXT, binding
    // declares DV_CODED_TEXT for the HIP Condition mapping's dual-
    // attribute requirement). Without this override, buildNode always
    // trusted node.rmType for any concrete (non-'ELEMENT') WebTemplate
    // type, so the binding's declared type was silently ignored either
    // way - once wrote an invalid DV_CODED_TEXT defining_code.code_string
    // from free text ("does not match any option"), the other would have
    // kept building a plain DV_TEXT with no defining_code/mappings at all.
    const effectiveRmType = node.rmType === 'ELEMENT' || leafField.codeMappings?.enabled
      ? (leafField.semanticType || node.rmType)
      : node.rmType;
    return buildElement(node, leafField, buildLeafDvValue(effectiveRmType, leafField, fieldValue(scope, leafField.id)));
  }
  // A polymorphic/union RM slot can also appear as a WRAPPER 'ELEMENT' node
  // whose OWN aqlPath has no matching field at all - the real bindings
  // target one of its concrete-type children's aqlPath instead, one level
  // deeper. Confirmed live: vg_ObservationLab.v1.2.0's "Analyte result"
  // (at0001) is exactly this shape - the wrapper's aqlPath ends
  // `.../items[at0001]` (no `/value`), while its DV_QUANTITY/DV_TEXT/
  // DV_CODED_TEXT alternative children each end `.../items[at0001]/value`,
  // which is what every real field binding actually uses. Without this
  // branch, `leafField` above resolves to undefined for the wrapper (its
  // own aqlPath truly has no field), so `node.rmType === 'ELEMENT'` falls
  // through to the generic `default:` structural case below, which
  // recurses into the children and wraps whichever one resolves inside a
  // SECOND, invalid "ELEMENT" that carries an `items` array instead of a
  // `value` - EHRbase rejects that outer shell with
  // Inv_null_flavour_indicated (it has no `value` attribute at all, by
  // definition, since ELEMENT never has `items`). Resolve directly against
  // whichever child alternative actually has a value, and build a single,
  // valid ELEMENT using this wrapper's own identity (archetype_node_id/
  // name) instead of ever reaching that generic path.
  if (node.rmType === 'ELEMENT' && node.children?.length) {
    for (const child of node.children) {
      if (!child.aqlPath) continue;
      const childField = index.resolveField(child.aqlPath, scope);
      if (!childField) continue;
      const raw = fieldValue(scope, childField.id);
      if (raw === undefined) continue;
      const effectiveChildRmType = childField.codeMappings?.enabled ? (childField.semanticType || child.rmType) : child.rmType;
      const built = buildElement(node, childField, buildLeafDvValue(effectiveChildRmType, childField, raw));
      if (built !== undefined) return built;
    }
    return undefined;
  }
  switch (node.rmType) {
    case 'SECTION': {
      const items = buildStructuralChildren(node, scope, index);
      if (items.length === 0 && (node.min ?? 0) === 0) return undefined;
      return { _type: 'SECTION', name: dvText(nodeLabel(node)), ...nodeIdentity(node), items };
    }
    case 'ADMIN_ENTRY':
    case 'EVALUATION': {
      const data = buildEntryData(node, scope, index, context, 'data');
      if ((data.items as unknown[]).length === 0 && (node.min ?? 0) === 0) return undefined;
      return { _type: node.rmType, name: dvText(nodeLabel(node)), ...nodeIdentity(node), ...entryAttributes(context), data };
    }
    case 'OBSERVATION': {
      const data = buildObservationData(node, scope, index, context);
      const events = data.events as Canonical[];
      const hasContent = events.some((event) => ((event.data as Canonical)?.items as unknown[])?.length > 0);
      if (!hasContent && (node.min ?? 0) === 0) return undefined;
      const protocol = buildProtocol(node, scope, index, context);
      return { _type: 'OBSERVATION', name: dvText(nodeLabel(node)), ...nodeIdentity(node), ...entryAttributes(context), data, ...(protocol ? { protocol } : {}) };
    }
    case 'ACTION': {
      const data = buildEntryData(node, scope, index, context, 'description');
      if ((data.items as unknown[]).length === 0 && (node.min ?? 0) === 0) return undefined;
      const protocol = buildProtocol(node, scope, index, context);
      // `time` and `ism_transition/current_state` are real, submittable
      // ACTION attributes that the WebTemplate export never models as a
      // visible ELEMENT (same category as EVENT_CONTEXT's own `setting` -
      // see buildEventContext) - a form CAN still bind a field to their
      // conventional path, but nothing ever looked for one; every ACTION
      // silently got today's timestamp and a hardcoded "completed" status
      // regardless of what was actually submitted. Use a bound field's real
      // value when a form provides one, falling back to the previous fixed
      // defaults exactly as before for any form that doesn't.
      const timeField = resolveFixedAttributeField(node, index, scope, '/time');
      const time = timeField
        ? buildLeafDvValue('DV_DATE_TIME', timeField.field, timeField.raw) as Canonical | undefined
        : undefined;
      // ISM_TRANSITION.current_state is always drawn from openEHR's own
      // fixed state-machine terminology ("openehr", never "local"/a HIP
      // code system) - build it directly rather than through
      // buildLeafDvValue's generic DV_CODED_TEXT path, which defaults an
      // uncoded plain-string value's terminology to "local".
      const statusField = resolveFixedAttributeField(node, index, scope, '/ism_transition/current_state');
      const currentState: Canonical | undefined = statusField ? (() => {
        const code = String(statusField.raw);
        const option = statusField.field.options.find((candidate) => candidate.value === code);
        return { _type: 'DV_CODED_TEXT', value: option?.rmValue || option?.text || code, defining_code: codePhrase('openehr', code) };
      })() : undefined;
      return {
        _type: 'ACTION', name: dvText(nodeLabel(node)), ...nodeIdentity(node), ...entryAttributes(context),
        time: time || dvDateTime(context.time || new Date().toISOString()),
        ism_transition: { _type: 'ISM_TRANSITION', current_state: currentState || { _type: 'DV_CODED_TEXT', value: 'completed', defining_code: codePhrase('openehr', '532') } },
        description: data,
        ...(protocol ? { protocol } : {}),
      };
    }
    case 'INSTRUCTION': {
      const activityNode = node.children?.find((child) => child.rmType === 'ACTIVITY');
      const description = activityNode ? buildEntryData(activityNode, scope, index, context, 'description') : buildEntryData(node, scope, index, context, 'description');
      if ((description.items as unknown[]).length === 0 && (node.min ?? 0) === 0) return undefined;
      // `protocol` (0..1 on INSTRUCTION, same RM shape as OBSERVATION/ACTION's
      // own protocol - see buildProtocol) is a sibling of `activities`, never
      // nested under the ACTIVITY - confirmed live (vg_ServiceRequest's
      // `request_status`/at0127 binds under `/protocol[at0008]/items[at0127]`
      // directly off the INSTRUCTION content node). Same gap as the
      // OBSERVATION/ACTION protocol fix: nothing ever built this attribute at
      // all, so any field bound under INSTRUCTION's own /protocol[...]
      // silently vanished regardless of form config.
      const protocol = buildProtocol(node, scope, index, context);
      return {
        _type: 'INSTRUCTION', name: dvText(nodeLabel(node)), ...nodeIdentity(node), ...entryAttributes(context),
        narrative: dvText(nodeLabel(activityNode || node)),
        // ACTIVITY.action_archetype_id is RM-mandatory (1..1, RM data_types
        // activity_type - the archetype-id pattern of the ACTION this
        // activity is meant to instantiate) but never modeled as a
        // form-editable field - confirmed live (EHRbase rejects a
        // structured-JSON ACTIVITY with no action_archetype_id at all:
        // "does not match existence 1..1", vg_ServiceRequest.v1.1.1). No
        // form in this app ties an INSTRUCTION's activity to one specific
        // ACTION archetype, so ".*" (match any ACTION archetype) is the
        // standard openEHR convention for "unconstrained" - EHRbase's own
        // FLAT-format export already defaults unset instances to this same
        // pattern (seen live as "/.*/", its regex-delimited display form).
        activities: [{ _type: 'ACTIVITY', name: dvText(nodeLabel(activityNode || node)), archetype_node_id: (activityNode?.nodeId || activityNode?.id) || `${node.nodeId || node.id}-activity`, action_archetype_id: '.*', description, timing: { _type: 'DV_PARSABLE', value: 'R1', formalism: 'timing' } }],
        ...(protocol ? { protocol } : {}),
      };
    }
    case 'CLUSTER':
    case 'ITEM_TREE':
    case 'ITEM_LIST':
    case 'ITEM_TABLE':
    case 'ITEM_SINGLE': {
      const items = buildStructuralChildren(node, scope, index);
      if (items.length === 0 && (node.min ?? 0) === 0) return undefined;
      return { _type: node.rmType === 'CLUSTER' ? 'CLUSTER' : 'ITEM_TREE', name: dvText(nodeLabel(node)), ...nodeIdentity(node), items };
    }
    default:
      // Unrecognized structural type. Recurse best-effort as an ITEM_TREE-
      // shaped container rather than silently dropping a whole subtree; a
      // required-but-truly-unsupported node still surfaces (non-empty
      // items) instead of vanishing without a trace.
      { const items = buildStructuralChildren(node, scope, index);
        if (items.length === 0) return undefined;
        return { _type: node.rmType, name: dvText(nodeLabel(node)), ...nodeIdentity(node), items }; }
  }
}

function buildEventContext(node: WebTemplateTreeNode | undefined, scope: RuntimeValues, index: FieldIndex, context: CanonicalCompositionContext): Canonical {
  // EVENT_CONTEXT is the one RM structure the WebTemplate tree exposes with
  // direct NAMED properties instead of an items/content array - confirmed
  // live. `setting` is required by openEHR but essentially never
  // form-editable in this app's templates, so it falls back to the same
  // "other care"(238) value a real, successfully committed composition on
  // this deployment used, unless the template genuinely binds a field to it.
  const settingNode = node?.children?.find((child) => child.id === 'setting');
  const settingField = settingNode?.aqlPath ? index.resolveField(settingNode.aqlPath, scope) : undefined;
  const settingValue = settingField ? fieldValue(scope, settingField.id) : undefined;
  const settingDv = settingValue !== undefined
    ? buildLeafDvValue('DV_CODED_TEXT', settingField, settingValue)
    : { _type: 'DV_CODED_TEXT', value: 'other care', defining_code: codePhrase('openehr', '238') };
  // start_time is mandatory (1..1) on EVENT_CONTEXT but, like ACTION's own
  // `time` (see resolveFixedAttributeField), the WebTemplate export never
  // models the EVENT_CONTEXT node itself with an aqlPath (only its named
  // children, e.g. `setting`, carry one - see the settingNode lookup above),
  // so resolveFixedAttributeField's node.aqlPath+suffix approach doesn't
  // apply here. `/context/start_time` is a fixed, template-independent RM
  // path (COMPOSITION-scoped, not archetype-scoped) - a form CAN still bind
  // a field to it directly (confirmed real: vg_ServiceRequest's HIP mapping
  // targets exactly this path from FHIR `authoredOn`), but nothing ever
  // looked for one; every composition silently got "now" regardless of what
  // was actually submitted. Use a bound field's real value when a form
  // provides one, falling back to "now" exactly as before for any form that
  // doesn't.
  const startTimeField = index.resolveField('/context/start_time', scope);
  const startTimeRaw = startTimeField ? fieldValue(scope, startTimeField.id) : undefined;
  const startTime = startTimeRaw !== undefined
    ? (buildLeafDvValue('DV_DATE_TIME', startTimeField, startTimeRaw) as Canonical | undefined)
    : undefined;
  const eventContext: Canonical = {
    _type: 'EVENT_CONTEXT',
    start_time: startTime || dvDateTime(context.time || new Date().toISOString()),
    setting: settingDv,
  };
  const otherContextNode = node?.children?.find((child) => child.id === 'other_context' || child.aqlPath?.endsWith('/context/other_context'));
  if (otherContextNode) {
    const otherContext = itemTree(otherContextNode, scope, index);
    if ((otherContext.items as unknown[]).length > 0) eventContext.other_context = otherContext;
  }
  return eventContext;
}

function buildCategory(node: WebTemplateTreeNode | undefined): Canonical {
  // Templates typically constrain `category` to exactly one allowed code -
  // confirmed live (vg_Person exposes `persistent`(431) as its only option).
  // Use that when present, since it's the template's own authoritative
  // default; otherwise fall back to the general openEHR default.
  const list = node?.inputs?.find((input) => input.list && input.list.length > 0)?.list;
  const only = list && list.length === 1 ? list[0] : undefined;
  if (only) return { _type: 'DV_CODED_TEXT', value: only.label || 'event', defining_code: codePhrase('openehr', only.value) };
  return { _type: 'DV_CODED_TEXT', value: 'event', defining_code: codePhrase('openehr', '433') };
}

/**
 * Builds one canonical (nested RM JSON) Composition, ready to hand to
 * `ContributionRepository.commit()` (or, unwrapped, EHRbase's plain
 * `POST /composition` in canonical mode) - the tree-shaped counterpart of
 * `toOpenEhrFlatComposition`, over the exact same inputs.
 */
export function buildCanonicalComposition(
  definition: CanonicalForm,
  values: RuntimeValues,
  webTemplateTree: unknown,
  context: CanonicalCompositionContext = {},
): Canonical {
  const root = webTemplateTree as WebTemplateTreeNode | undefined;
  if (!root || root.rmType !== 'COMPOSITION') throw new Error('buildCanonicalComposition requires a WebTemplate tree rooted at a COMPOSITION node');
  const index = buildFieldIndex(definition);
  const categoryNode = root.children?.find((child) => child.id === 'category');
  const contextNode = root.children?.find((child) => child.rmType === 'EVENT_CONTEXT' || child.id === 'context');
  // The WebTemplate tree also exposes composer/language/territory as direct
  // children right alongside category/context - confirmed live. These are
  // COMPOSITION-level RM attributes, not clinical content; filled below from
  // context (or the same fixed defaults as everywhere else), so excluded
  // here the same way category/context are, rather than falling through
  // into `content[]` as if they were an entry.
  const skipIds = new Set(['category', 'context', 'composer', 'language', 'territory']);
  const content: Canonical[] = [];
  for (const child of root.children || []) {
    if (skipIds.has(child.id) || child === contextNode) continue;
    for (const childScope of resolveScopes(child, values, index)) {
      const built = buildNode(child, childScope, index, context);
      if (built !== undefined) content.push(built as Canonical);
    }
  }
  return {
    _type: 'COMPOSITION',
    name: dvText(root.name || definition.name),
    ...nodeIdentity(root, definition.sourceTemplates[0]?.id ? { templateId: definition.sourceTemplates[0].id } : undefined),
    language: codePhrase('ISO_639-1', context.language || 'de'),
    territory: codePhrase('ISO_3166-1', context.territory || 'DE'),
    category: buildCategory(categoryNode),
    composer: context.composerId
      ? { _type: 'PARTY_IDENTIFIED', name: context.composerName || 'Form Builder', external_ref: { _type: 'PARTY_REF', namespace: 'openehr', type: 'PERSON', id: { _type: 'HIER_OBJECT_ID', value: context.composerId } } }
      : { _type: 'PARTY_IDENTIFIED', name: context.composerName || 'Form Builder' },
    context: buildEventContext(contextNode, values, index, context),
    content,
  };
}
