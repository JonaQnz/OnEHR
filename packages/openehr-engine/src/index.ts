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
  /** The current, valid per-unit magnitude range/precision at this node -
   * only present for a DV_QUANTITY node whose WebTemplate carries range/
   * precision validation on at least one unit. Used by auditFormBindings to
   * flag a Form Section field whose stored unitOptions don't reflect these
   * limits. */
  unitOptions?: Array<{ unit: string; min?: number; max?: number; minexclusive?: boolean; maxexclusive?: boolean; precision?: number }>;
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

/** DV_PROPORTION.type's wire encoding - a PROPORTION_KIND ordinal
 * (java.lang.Long in EHRbase's own Archie RM model), not the kind's
 * string name. Confirmed live 2026-09-02 against a real EHRbase instance:
 * writing the string ("percent") failed with "Cannot deserialize value of
 * type `java.lang.Long` from String \"percent\"". Ordinals per
 * BaseTypes.xsd's PROPORTION_KIND enumeration (0=ratio, 1=unitary,
 * 2=percent, 3=fraction, 4=integer_fraction) - see ProportionKind's own
 * doc comment (packages/core/openehr) for what each kind means. */
const PROPORTION_KIND_CODE: Record<'ratio' | 'unitary' | 'percent' | 'fraction' | 'integer_fraction', number> = {
  ratio: 0, unitary: 1, percent: 2, fraction: 3, integer_fraction: 4,
};

/** RM data_types.text 5.2.2 (TERM_MAPPING): `match` is a `char` constrained
 * to exactly these four values ('>' broader, '=' equivalent, '<' narrower,
 * '?' unknown) - confirmed against the current openEHR RM Data Types spec
 * while validating this file against it (2026-09-02). Mirrored in
 * canonicalComposition.ts's own normalizedTermMappingMatch, kept in sync by
 * inspection since the two files deliberately don't share code (see
 * setFlatValue's own top comment for why). */
const VALID_TERM_MAPPING_MATCH = new Set(['>', '=', '<', '?']);

/** Shared by both codeMappings.enabled branches below (a DV_TEXT-bound field,
 * and - see the DV_CODED_TEXT branch's own comment - the "HIP converter is
 * king" DV_CODED_TEXT-bound one) so the `_mapping:N` FLAT convention can't
 * drift between them. Mirrors canonicalComposition.ts's buildTermMappings
 * for the same reason that file gives: real example compositions for this
 * use only ever carry {match, target: {terminology_id, code_string}}.
 *
 * Corrected 2026-09-05 (live read-path bug investigation, medication_item_name
 * on vg_medicationstatement.v1.1.0): the previous guess here - `mappings/N`,
 * no leading underscore, slash before the index - was itself never verified
 * against a real EHRbase GET, only checked not to be REJECTED on write
 * (distinguishing it from the `_mappings/N` guess before it, which was
 * rejected wholesale with "Could not consume Parts" - see git history). A
 * live AQL readback of a composition actually committed with a populated
 * `mappings` list (via canonicalComposition.ts's buildLeafDvValue, the path
 * every real submission of a codeMappings.enabled field takes - see
 * ehrbaseDataProvider.ts's `needsCanonicalComposition`) shows EHRbase's own
 * FLAT rendering is `<path>/_mapping:N/...` - singular, underscore-prefixed,
 * colon-indexed, the same `name:index` shape every other repeating FLAT
 * attribute uses (e.g. `any_event:0`), not `mappings/N`. The underscore
 * being present despite `mappings` being a genuine value-bearing RM
 * attribute (data_types.text 5.2.1: DV_TEXT.mappings: List<TERM_MAPPING>,
 * inherited by DV_CODED_TEXT) rather than a LOCATABLE meta-attribute is an
 * EHRbase FLAT-projection implementation detail, not something derivable
 * from the RM spec - only confirmed by this live example. readCodeMappings
 * below is the counterpart read, kept in sync with this on purpose. */
function writeCodeMappingsFlat(output: Record<string, unknown>, key: string, text: unknown, mappings: unknown): boolean {
  if (isEmpty(text)) return false;
  output[key] = text;
  (Array.isArray(mappings) ? mappings : []).forEach((entry, mappingIndex) => {
    if (!isRecord(entry) || isEmpty(entry.terminologyId) || isEmpty(entry.code)) return;
    const prefix = `${key}/_mapping:${mappingIndex}`;
    output[`${prefix}|match`] = typeof entry.match === 'string' && VALID_TERM_MAPPING_MATCH.has(entry.match) ? entry.match : '=';
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
  if (rmType === 'DV_PROPORTION') {
    // DV_PROPORTION had no branch here at all before 2026-09-02 - fell
    // through to the generic `output[key] = value` write, a bare
    // number/object with no suffix. numerator/denominator/type are always
    // suffixed sibling keys, same convention as DV_QUANTITY's magnitude/
    // unit above. `|precision` is deliberately not attempted - out of
    // scope for this pass.
    const numerator = source?.numerator ?? value;
    if (isEmpty(numerator)) return;
    output[`${key}|numerator`] = typeof numerator === 'string' && numerator.trim() ? Number(numerator) : numerator;
    // PROPORTION_KIND_DENOMINATOR (form-runtime/index.ts) is the single
    // source of truth for which kinds imply a fixed denominator - mirrored
    // here rather than imported (openehr-engine has no dependency on core's
    // form-runtime module) so a 'percent'/'unitary' field whose runtime
    // value only carries `numerator` (the single-field widget - see the
    // widget UX decision this session) still writes a complete, valid
    // DV_PROPORTION rather than one missing `denominator` entirely.
    const impliedDenominator = binding.proportionType === 'unitary' ? 1 : binding.proportionType === 'percent' ? 100 : undefined;
    const denominator = source?.denominator ?? impliedDenominator;
    if (!isEmpty(denominator)) output[`${key}|denominator`] = typeof denominator === 'string' && denominator.trim() ? Number(denominator) : denominator;
    // `type` is `DvProportion.type` in EHRbase's own RM model (Java's
    // Archie), a PROPORTION_KIND ordinal (java.lang.Long), NOT the kind's
    // string name. Confirmed live 2026-09-02: writing the string
    // ("percent") got a 400 straight from EHRbase - "Cannot deserialize
    // value of type `java.lang.Long` from String \"percent\"" - the
    // original best-effort guess here was wrong. PROPORTION_KIND_CODE
    // (below) is the corrected mapping, per BaseTypes.xsd's enumeration.
    if (binding.proportionType) output[`${key}|type`] = PROPORTION_KIND_CODE[binding.proportionType];
    return;
  }
  if (rmType === 'DV_INTERVAL<DV_QUANTITY>') {
    // Had no branch at all before this - see canonicalComposition.ts's
    // buildLeafDvValue DV_INTERVAL<DV_QUANTITY> branch for the full
    // "this was a total gap" writeup (P0.1 audit, 2026-09-05, confirmed
    // live on "Medikationsabgleich"'s dose-range fields). Unlike
    // DV_QUANTITY's `|magnitude`/`|unit` (bare suffixes on the same key),
    // `lower`/`upper` are real nested paths in the archetype's own aqlPath
    // (confirmed against the real WebTemplate: ".../value/lower",
    // ".../value/upper") - each itself a full DV_QUANTITY, so this writes
    // TWO path segments deep: `key/lower|magnitude`, not `key|lower_magnitude`.
    // An open-ended interval (only one bound given) simply omits that
    // bound's two keys entirely - EHRbase's FLAT format has no explicit
    // way to state lower_unbounded/upper_unbounded (unlike the canonical/
    // structured path, which does), so this can't be round-tripped through
    // FLAT with full fidelity; only the structured Contribution path
    // (canonicalComposition.ts) can. Real submissions in this app go
    // through THAT path for compound types already (see this file's own
    // module comment on codeMappings/FLAT), so this branch mainly matters
    // for the draft-autosave FLAT path, same caveat already documented for
    // codeMappings' own writeCodeMappingsFlat.
    if (!isEmpty(source?.lower)) {
      const lower = isRecord(source?.lower) ? source.lower : undefined;
      const magnitude = lower?.magnitude ?? source?.lower;
      if (!isEmpty(magnitude)) output[`${key}/lower|magnitude`] = typeof magnitude === 'string' && magnitude.trim() ? Number(magnitude) : magnitude;
      if (!isEmpty(lower?.unit)) output[`${key}/lower|unit`] = lower?.unit;
    }
    if (!isEmpty(source?.upper)) {
      const upper = isRecord(source?.upper) ? source.upper : undefined;
      const magnitude = upper?.magnitude ?? source?.upper;
      if (!isEmpty(magnitude)) output[`${key}/upper|magnitude`] = typeof magnitude === 'string' && magnitude.trim() ? Number(magnitude) : magnitude;
      if (!isEmpty(upper?.unit)) output[`${key}/upper|unit`] = upper?.unit;
    }
    return;
  }
  if (rmType === 'DV_IDENTIFIER') {
    // DV_IDENTIFIER (RM: id 1..1, issuer/assigner/type each 0..1, invariant
    // "not id.is_empty") was falling through to the generic `output[key] =
    // value` branch at the bottom of this function, writing a bare string
    // to the plain path with no `|id` suffix at all - not a valid FLAT
    // representation of any DV_IDENTIFIER attribute, since `id` (like
    // DV_QUANTITY's `magnitude`/`unit` above) is always a suffixed sibling
    // key, never the bare path itself. No form binds this rmType to
    // anything richer than a single free-text "id" field today (see
    // "Verordnungs-ID" on "Medikamentengabe (eMAR-Eintrag)"), so `value` is
    // normally just that string - but source?.issuer/assigner/type are
    // still honored if a future field ever supplies them, rather than
    // silently dropping them like the old fallback did for everything.
    const id = source?.id ?? value;
    if (!isEmpty(id)) output[`${key}|id`] = id;
    if (!isEmpty(source?.issuer)) output[`${key}|issuer`] = source?.issuer;
    if (!isEmpty(source?.assigner)) output[`${key}|assigner`] = source?.assigner;
    if (!isEmpty(source?.type)) output[`${key}|type`] = source?.type;
    return;
  }
  if (rmType === 'DV_CODED_TEXT' || rmType === 'CODE_PHRASE' || rmType === 'DV_ORDINAL') {
    // DV_ORDINAL best-effort note: RM-wise this is {value: Integer, symbol:
    // DV_CODED_TEXT} - a strictly richer structure than a plain
    // DV_CODED_TEXT. Reusing this branch's |code/|value/|terminology write
    // for it is a hypothesis, not a confirmed convention: no real
    // WebTemplate example in this system has a populated DV_ORDINAL option
    // list to test the FLAT wire format against (see
    // docs/features/rm-type-spec-conformance.md). The reasoning: the
    // value<->symbol pairing is entirely archetype-fixed per option (same
    // as a DV_CODED_TEXT dropdown, where only the chosen code is ever
    // submitted, never the full option metadata) - so EHRbase plausibly
    // resolves the ordinal integer server-side from the code alone, the
    // same way it already resolves everything else about a DV_CODED_TEXT
    // option from its own WebTemplate value set. buildLeafDvValue's
    // DV_ORDINAL branch (canonicalComposition.ts) is the one actually
    // exercised on a real browser submission - correct there with higher
    // confidence, matching the RM spec's unambiguous {value, symbol} shape
    // directly rather than reusing this FLAT hypothesis.
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

/** A DV_QUANTITY WebTemplate node's own current per-unit magnitude range/
 * precision, from the same `unit`/`units` `inputs[]` entry webTemplateParser
 * reads when generating a fresh Form Section field. Mirrors that logic
 * exactly (see webTemplateParser.ts's DV_QUANTITY branch) so this reports
 * the same constraints a re-generated field would get - used by
 * auditFormBindings to flag a Form Section whose stored unitOptions
 * predate this extraction (or predate the template gaining a range/
 * precision constraint it didn't have before) and so are missing limits
 * the archetype now specifies. */
function currentUnitOptionsOf(node: UnknownRecord): Array<{ unit: string; min?: number; max?: number; minexclusive?: boolean; maxexclusive?: boolean; precision?: number }> | undefined {
  if (text(node.rmType) !== 'DV_QUANTITY') return undefined;
  const inputs = Array.isArray(node.inputs) ? node.inputs.filter(isRecord) : [];
  const unitInput = inputs.find((input) => { const suffix = text(input.suffix); return suffix === 'units' || suffix === 'unit' || suffix === 'unit_code'; });
  const list = unitInput && Array.isArray(unitInput.list) ? unitInput.list.filter(isRecord) : undefined;
  if (!list || list.length === 0) return undefined;
  const options = list.map((entry) => {
    const unit = text(entry.value);
    if (!unit) return undefined;
    const opt: { unit: string; min?: number; max?: number; minexclusive?: boolean; maxexclusive?: boolean; precision?: number } = { unit };
    const validation = isRecord(entry.validation) ? entry.validation : undefined;
    const range = validation && isRecord(validation.range) ? validation.range : undefined;
    if (range) {
      if (typeof range.min === 'number') opt.min = range.min;
      if (typeof range.max === 'number') opt.max = range.max;
      if (range.minOp === '>') opt.minexclusive = true;
      if (range.maxOp === '<') opt.maxexclusive = true;
    }
    const precision = validation && isRecord(validation.precision) ? validation.precision : undefined;
    if (precision) {
      if (typeof precision.max === 'number') opt.precision = precision.max;
      else if (typeof precision.min === 'number') opt.precision = precision.min;
    }
    return opt;
  }).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
  return options.length > 0 ? options : undefined;
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
    const unitOptions = currentUnitOptionsOf(node);
    if (aqlPath && current) map.set(aqlPath, { flatPath: current, ...(rmType ? { rmType } : {}), ...(codes ? { codes } : {}), ...(unitOptions ? { unitOptions } : {}) });
    if (Array.isArray(node.children)) node.children.forEach((child) => walk(child, current));
  }
  walk(tree, '');
  return map;
}

export type BindingAuditIssue = 'unresolved-path' | 'rmtype-mismatch' | 'stale-option' | 'stale-unit' | 'missing-quantity-constraint';

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
 * path still resolves, whether its rmType still matches, whether a coded
 * field's stored options are still valid codes, and - added 2026-09-02,
 * see quantity-range-precision.test.js's sibling fix to validateOne, which
 * this complements - whether a DV_QUANTITY field's stored unit is still
 * offered at all (stale-unit) and whether it's missing a magnitude range/
 * precision limit the current template specifies for that unit
 * (missing-quantity-constraint). It does NOT attempt to detect "this field
 * should now be part of a repeatable group" -
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
    // Same id/name gap as collectFieldBindings above - a name-only field
    // (i.e. most real fields, see that comment) reported every finding
    // under the useless label "(unnamed)" instead of its real field name.
    const fieldId = node.id || node.name || '(unnamed)';
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
        const rawUnitOptions = (node as unknown as UnknownRecord).unitOptions;
        if (mapping.unitOptions && Array.isArray(rawUnitOptions)) {
          const currentByUnit = new Map(mapping.unitOptions.map((option) => [option.unit, option]));
          for (const stored of rawUnitOptions.filter(isRecord)) {
            const unit = text(stored.unit);
            if (!unit) continue;
            const current = currentByUnit.get(unit);
            if (!current) {
              findings.push({ fieldId, path: binding.path, issue: 'stale-unit', detail: `Unit '${unit}' is no longer offered for this quantity in the current template.` });
              continue;
            }
            // Only flags the archetype specifying a limit this field's
            // stored option doesn't have at all - never a numeric
            // mismatch between two present values, which could just as
            // easily be an intentional narrower limit the form designer
            // chose on purpose. This deliberately stays a soft nudge
            // ("re-apply the template to pick this up"), matching
            // validateOne's own range/precision checks being warnings,
            // not hard failures, for the exact same reason: a lot of
            // already-built fields predate this extraction existing at
            // all (see formGenerator.ts/webTemplateParser.ts's sibling
            // fix) and were never wrong, just incomplete.
            const missing: string[] = [];
            if (current.min !== undefined && stored.min === undefined) missing.push(`min ${current.min}`);
            if (current.max !== undefined && stored.max === undefined) missing.push(`max ${current.max}`);
            if (current.precision !== undefined && stored.precision === undefined) missing.push(`precision ${current.precision}`);
            if (missing.length > 0) {
              findings.push({ fieldId, path: binding.path, issue: 'missing-quantity-constraint', detail: `Unit '${unit}' has ${missing.join(', ')} in the current template that this field's stored unitOptions doesn't carry yet - re-apply the template (apply_template_to_form) to pick it up.` });
            }
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
   * another repeatable container is entered). A hand-authored repeatable
   * *group* container typically has no `.binding` of its own (e.g. a
   * Laborpanel's `laboratory_analyte_result` container carries
   * `repeatMin`/`repeatMax`/`repeatable` but no binding at all) - this
   * per-member marker is what lets toOpenEhrFlatComposition recognise
   * `values[groupId]` as a group's row array instead of silently dropping it
   * as an unbound field.
   *
   * A *generated* repeatable container (webTemplateParser's
   * containerBinding()) DOES carry its own binding, pointing at the
   * repeating archetype node itself - collectFieldBindings keeps that in a
   * separate `groupBindings` map (see below), not here, precisely so this
   * per-member detection keeps working unchanged for either shape. */
  repeatableGroupId?: string;
  /** See FormElementLayout.proportionType (core/canonical) - only ever set
   * for a DV_PROPORTION-bound field. */
  proportionType?: 'ratio' | 'unitary' | 'percent' | 'fraction' | 'integer_fraction';
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

interface CollectedBindings {
  /** Per-member/leaf-field bindings, keyed by field id - never contains a
   * repeatable group's own container id (see `groupBindings` for that). */
  layoutBindings: Map<string, FieldBinding>;
  /** Every repeatable container's own id, whether or not it carries a
   * binding - the authoritative "is this key in `values` a group?" check.
   * Determining this from `layoutBindings`' absence (the previous approach)
   * broke the moment a container DID have a binding, which is exactly what
   * webTemplateParser's generator always emits (containerBinding()) - a
   * generated Form Section's repeatable groups were silently dropped the
   * same way hand-authored ones used to be, just via the opposite root
   * cause (binding present, not absent). */
  repeatableGroupIds: Set<string>;
  /** A repeatable container's OWN binding, when it has one (generated forms
   * only - hand-authored ones typically omit it). Kept separate from
   * `layoutBindings` so the plain per-field loop never mistakes a group's
   * row array for one leaf field's value, and used to anchor the FLAT `:N`
   * index precisely at the archetype's own repeating node instead of
   * reverse-engineering it from members' common path prefix. */
  groupBindings: Map<string, FieldBinding>;
}

function collectFieldBindings(layout: CanonicalForm['layout']): CollectedBindings {
  const layoutBindings = new Map<string, FieldBinding>();
  const repeatableGroupIds = new Set<string>();
  const groupBindings = new Map<string, FieldBinding>();
  // repeatableGroupId threading mirrors core/form-runtime/index.ts's own
  // `walk()` exactly: a `container` node with `repeatable: true` and an id
  // becomes the group id for itself and every descendant, until another
  // repeatable container is entered - not just direct children, since a
  // group's members here sit two levels deeper (container > row > column >
  // field), matching every real repeatable-group form in this app.
  function walk(node: CanonicalForm['layout'], repeatableGroupId?: string): void {
    const nodeType = (node as unknown as Record<string, unknown>).type;
    // A webTemplateParser-generated field (i.e. most real fields in this
    // app - confirmed live across every field on "Medikationsabgleich")
    // only ever carries `.name`, never a separate `.id` - the same id/name
    // ambiguity already fixed elsewhere for form-scripting/form-runtime
    // (see core/form-runtime's and form-scripting's own `node.id ||
    // node.name` helpers, and openehr-engine/metadata.ts's identical one).
    // This function used bare `node.id` only, so it silently registered
    // ZERO layoutBindings for such a field - every one of them was actually
    // reaching EHRbase only via the separate top-level `definition.bindings`
    // fallback loop further down, which happens to carry a matching entry
    // for auto-generated fields. A newly hand-inserted field (added to the
    // layout only, the more natural place to add one) had no such legacy
    // entry and its value silently vanished at submission with no error -
    // found live 2026-09-05 testing the new DV_INTERVAL<DV_QUANTITY>
    // "Dosisbereich" field, which validated and "submitted" successfully
    // while the archetype's whole CLUSTER.dosage.v2 was silently dropped
    // from the actual composition. Fixed at the root instead of only
    // working around it by also adding a bindings-map entry, since the
    // underlying gap affects every field on every form the same way.
    const fieldId = node.id || node.name;
    const isRepeatableContainer = nodeType === 'container' && (node as unknown as Record<string, unknown>).repeatable === true && Boolean(fieldId);
    const childGroupId = isRepeatableContainer ? fieldId : repeatableGroupId;
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
    // Unlike input-quantity's unit (a runtime/user choice, never needed at
    // write time - see setFlatValue's DV_QUANTITY branch, which only ever
    // reads the value's own `unit`), a DV_PROPORTION's type is archetype-
    // fixed and must be known at write time even when the runtime value
    // only supplies `numerator` (a 'percent'/'unitary' field's implied
    // denominator - see setFlatValue's DV_PROPORTION branch).
    const proportionType = text((node as unknown as Record<string, unknown>).proportionType);
    if (isRepeatableContainer && fieldId) {
      repeatableGroupIds.add(fieldId);
      if (binding) groupBindings.set(fieldId, binding);
    } else if (fieldId && binding) {
      layoutBindings.set(fieldId, {
        ...binding,
        ...(options?.length ? { options } : {}),
        ...(codeMappings ? { codeMappings } : {}),
        ...(allowFreeText ? { allowFreeText } : {}),
        ...(proportionType ? { proportionType: proportionType as 'ratio' | 'unitary' | 'percent' | 'fraction' | 'integer_fraction' } : {}),
        // The group container's own id never applies to itself as a member -
        // only to its descendants (repeatableGroupId, not childGroupId).
        ...(repeatableGroupId ? { repeatableGroupId } : {}),
      });
    }
    node.children?.forEach((child) => walk(child, childGroupId));
  }
  walk(layout);
  return { layoutBindings, repeatableGroupIds, groupBindings };
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
  const { layoutBindings, repeatableGroupIds, groupBindings } = collectFieldBindings(definition.layout);
  const processed = new Set<string>();
  // Repeatable *groups* first (values[groupId] = one row object per
  // occurrence, keyed by field id exactly like FormRuntime's own
  // `row[field.id]` reads - see core/form-runtime's repeatableGroupId doc).
  // Must run before the plain per-field loop below: a group id is never
  // itself a bound leaf field, so without this pass `values[groupId]` would
  // just silently fail the `!binding` check in that loop and the entire
  // group would be dropped - confirmed live, this is exactly how a
  // Laborpanel's 9 analyte rows never reached EHRbase at all (only the
  // panel's own top-level "Test name" field, a real leaf, made it through).
  // `repeatableGroupIds` (not "absent from layoutBindings") is the
  // authoritative "is this a group?" check - a generated Form Section's
  // repeatable container DOES carry its own binding (webTemplateParser's
  // containerBinding()), so inferring group-ness from the binding's absence
  // silently reintroduced this exact bug for every generated form the
  // moment it had a real repeatable group, just via the opposite mechanism
  // (binding present, not missing). Every other CanonicalForm-consuming
  // form (no repeatable groups) sees zero behavioural change from this
  // loop, since `repeatableGroupIds` only ever contains genuine group ids.
  for (const [groupId, rows] of Object.entries(values)) {
    if (!Array.isArray(rows) || !repeatableGroupIds.has(groupId)) continue;
    const memberEntries = Array.from(layoutBindings.entries()).filter(([, binding]) => binding.repeatableGroupId === groupId);
    if (memberEntries.length === 0) continue;
    // A generated container's own binding names the repeating archetype
    // node directly and is the authoritative index-anchor point. Only
    // hand-authored groups (no container binding) fall back to inferring it
    // from the members' longest common path prefix.
    const groupOwnBinding = groupBindings.get(groupId);
    const groupOwnPath = groupOwnBinding ? resolveFlatPath(groupOwnBinding, pathMap) : undefined;
    const memberPaths = memberEntries
      .map(([, binding]) => resolveFlatPath(binding, pathMap))
      .filter((path): path is string => Boolean(path));
    const groupPrefix = groupOwnPath || commonPathPrefix(memberPaths);
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
    if (repeatableGroupIds.has(fieldId)) continue;
    const binding = layoutBindings.get(fieldId);
    const flatPath = binding && resolveFlatPath(binding, pathMap);
    if (!binding || !flatPath) continue;
    if (Array.isArray(value)) value.forEach((entry, index) => setFlatValue(flat, flatPath, binding, entry, index));
    else setFlatValue(flat, flatPath, binding, value);
    processed.add(flatPath);
  }
  for (const [fieldId, value] of Object.entries(values)) {
    if (layoutBindings.has(fieldId) || repeatableGroupIds.has(fieldId)) continue;
    const binding = definition.bindings[fieldId]?.openehr;
    const flatPath = binding && resolveFlatPath(binding, pathMap);
    if (!binding || !flatPath || processed.has(flatPath)) continue;
    if (Array.isArray(value)) value.forEach((entry, index) => setFlatValue(flat, flatPath, binding, entry, index));
    else setFlatValue(flat, flatPath, binding, value);
    processed.add(flatPath);
  }
  return flat;
}

/** Escapes `path` for embedding in a RegExp, AND makes every internal `/`
 * tolerant of an optional `:N` occurrence-index immediately before it (e.g.
 * `any_event/foo` also matches `any_event:0/foo`) - shared by readFlatValue
 * and readCodeMappings so an ancestor's own repeat index (any_event, a
 * repeatable group's own structural node, ...) never has to be known ahead
 * of time to find a field nested underneath it. */
function escapeFlatPathForMatching(path: string): string {
  return path.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&').replace(/\\\//g, '(?::\\d+)?/');
}

/** DV_INTERVAL<DV_QUANTITY>'s own read - split out from the main
 * readFlatValue body below because its FLAT keys have an extra `/lower` or
 * `/upper` path SEGMENT after the field's own base path (confirmed against
 * the real WebTemplate's own aqlPath convention: ".../value/lower",
 * ".../value/upper" - see setFlatValue's sibling comment), which the
 * generic matcher there (only tolerant of a trailing `:N` then `|suffix`,
 * never an extra `/segment`) can't express without risking a regression to
 * every other rmType's already-hardened matching. An open-ended interval
 * (only one bound ever written - see setFlatValue) correctly reconstructs
 * with only that one key present; returns undefined only when NEITHER
 * bound is present at all, matching setFlatValue's own "write nothing for
 * an entirely empty interval" behavior. Not repeat-aware (always returns a
 * single object, never an array of them) - fine for every real interval
 * field in this system today (all three on "Medikationsabgleich" are
 * min:1/max:1, non-repeating), but a genuinely repeatable
 * DV_INTERVAL<DV_QUANTITY> field would need this extended, same as the
 * generic path below already is for isGroupMember. */
function readIntervalQuantityFlatValue(flat: Record<string, unknown>, path: string): { lower?: { magnitude: unknown; unit?: unknown }; upper?: { magnitude: unknown; unit?: unknown } } | undefined {
  const escaped = escapeFlatPathForMatching(path);
  const result: { lower?: { magnitude: unknown; unit?: unknown }; upper?: { magnitude: unknown; unit?: unknown } } = {};
  for (const bound of ['lower', 'upper'] as const) {
    const matcher = new RegExp(`^${escaped}(?::\\d+)?/${bound}\\|magnitude$`);
    const magnitudeKey = Object.keys(flat).find((key) => matcher.test(key));
    if (!magnitudeKey) continue;
    result[bound] = { magnitude: flat[magnitudeKey], unit: flat[magnitudeKey.replace('|magnitude', '|unit')] };
  }
  return result.lower || result.upper ? result : undefined;
}

function readFlatValue(flat: Record<string, unknown>, path: string, rmType?: string, codeMappingsEnabled?: boolean, isGroupMember?: boolean): unknown {
  if (rmType === 'DV_INTERVAL<DV_QUANTITY>') return readIntervalQuantityFlatValue(flat, path);
  const escaped = escapeFlatPathForMatching(path);
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
    //
    // `isGroupMember` (added 2026-09-05, live bug: medication_item_name on
    // vg_medicationstatement.v1.1.0 - a plain, non-group field nested under
    // an archetype-inherent `any_event` EVENT series) - a NON-group field's
    // own genuine repeat index (per setFlatValue's indexedPath convention)
    // only ever sits at the very END of its path, immediately before an
    // optional `|suffix`. Scanning the WHOLE key for every `:N` (as the
    // group-member branch below still does, unchanged) picks up an
    // ancestor's occurrence index too - e.g. `any_event:0` - and wrongly
    // treats it as this field's OWN repeat dimension, wrapping a genuinely
    // single value in a one-element array. Confirmed live (2026-09-05):
    // both `medication_item_name` (a codeMappings.enabled field) and the
    // sibling plain `status` field, neither repeatable in the Form's own
    // layout, both came back as `["..."]` instead of a bare value/code
    // purely because they live under `any_event:0`. A repeatable GROUP
    // member's own meaningful index sits mid-path instead (at the group's
    // structural prefix, via insertIndexAtPrefix on write) - group-member
    // reading isn't reconstructed into row objects here regardless (see
    // repeatable-group-flat.test.js's own round-trip test comment), but
    // still relies on capturing every `:N` to get at least a flat, ordered
    // list of values per member field id - preserved unchanged so this fix
    // doesn't regress that pre-existing (documented, imperfect) behavior.
    const indices = isGroupMember
      ? Array.from(key.matchAll(/:(\d+)(?=\/|$|\|)/g), (match) => Number(match[1]))
      : (() => {
        const trailing = key.match(/:(\d+)(?:\|.*)?$/);
        return trailing ? [Number(trailing[1])] : [];
      })();
    let value: unknown;
    if (rmType === 'DV_QUANTITY') {
      if (!key.endsWith('|magnitude')) continue;
      value = { magnitude: flat[key], unit: flat[key.replace('|magnitude', '|unit')] };
    } else if (rmType === 'DV_PROPORTION') {
      // Counterpart read for setFlatValue's DV_PROPORTION branch. Always
      // reconstructs both numerator and denominator when both are present
      // in the flat data (mirrors DV_QUANTITY's {magnitude, unit} above) -
      // even for a 'percent'/'unitary' field whose single-field widget
      // never asks the user for a denominator, the value it wrote still
      // has one (implied at write time), and prefilling should show the
      // real committed value, not silently drop it back to numerator-only.
      if (!key.endsWith('|numerator')) continue;
      const denominator = flat[key.replace('|numerator', '|denominator')];
      value = isEmpty(denominator) ? { numerator: flat[key] } : { numerator: flat[key], denominator };
    } else if (rmType === 'DV_IDENTIFIER') {
      // Counterpart read for setFlatValue's DV_IDENTIFIER branch. Updated
      // 2026-09-05 (P0.1 audit) alongside adding the real input-identifier
      // widget, which reads/writes the full {id, issuer?, assigner?, type?}
      // shape - but this rmType-keyed dispatch has no way to tell "a field
      // rendered as the new input-identifier widget" apart from "the
      // pre-existing 'Verordnungs-ID' field on 'Medikamentengabe
      // (eMAR-Eintrag)', which is bound to this same DV_IDENTIFIER rmType
      // but rendered as plain input-text and has always read/written a bare
      // id string" (see setFlatValue's own DV_IDENTIFIER comment - both
      // fields share this ONE read function purely by rmType). Returning an
      // object unconditionally would silently break that existing field's
      // reload (String({id:'x'}) renders "[object Object]" in a plain text
      // input). Only build the richer object when issuer/assigner/type
      // actually carry data - the id-only case (both fields' actual
      // real-world usage today) stays a bare string either way, so neither
      // field's contract changes; input-identifier's own validateOne/widget
      // code normalizes a bare string the same as `{id: string}`.
      if (!key.endsWith('|id')) continue;
      const base = key.slice(0, -'|id'.length);
      const issuer = flat[`${base}|issuer`];
      const assigner = flat[`${base}|assigner`];
      const type = flat[`${base}|type`];
      value = (isEmpty(issuer) && isEmpty(assigner) && isEmpty(type))
        ? flat[key]
        : {
          id: flat[key],
          ...(isEmpty(issuer) ? {} : { issuer }),
          ...(isEmpty(assigner) ? {} : { assigner }),
          ...(isEmpty(type) ? {} : { type }),
        };
    } else if (rmType === 'DV_CODED_TEXT' || rmType === 'CODE_PHRASE' || rmType === 'DV_ORDINAL') {
      // A fixed-options DV_CODED_TEXT select's runtime value IS the code
      // (matched against field.options[].value), so |code correctly wins
      // there whenever both siblings exist - true for DV_ORDINAL too (its
      // codeMappingsEnabled is always undefined, so this always falls to
      // the |code branch below; see setFlatValue's DV_ORDINAL comment for
      // the FLAT-convention caveat this read side shares). A
      // codeMappings.enabled field is
      // the opposite case: rmType is still reported as DV_CODED_TEXT (it's
      // written to the RM as one, defining_code and all - see
      // buildLeafDvValue), but the field's own runtime semantic is "free
      // text with an optional code annotation" (see unwrapCodeMappedValue,
      // core/form-runtime) - readOne below wraps this into {value,
      // mappings}, and `value` must be the human-readable text, not the
      // code, or prefilling from a patient's own previously-submitted data
      // silently swaps a diagnosis name for its ICD code in the visible
      // field. Confirmed live (2026-09-02): re-prefilling "Kodierte
      // Diagnose" from a "Diagnose (Basis)" submission of "Arterielle
      // Hypertonie" (mapped to ICD I10) showed "I10" in the Diagnose text
      // field instead of the diagnosis name.
      if (codeMappingsEnabled) {
        if (key.endsWith('|value')) value = flat[key];
        else if (key.endsWith('|code') && !matches.includes(key.replace('|code', '|value'))) value = flat[key];
        else continue;
      } else if (key.endsWith('|code')) value = flat[key];
      else if (key.endsWith('|value') && !matches.includes(key.replace('|value', '|code'))) value = flat[key];
      else continue;
    } else {
      // A field bound as plain DV_TEXT (no |code/|value/|terminology
      // suffixes in our own write convention - see code-mappings-flat.
      // test.js) can still meet data on read that WAS committed as
      // DV_CODED_TEXT: this archetype's node is a genuine union type
      // (free text OR coded text - see coded-text-free-text-fallback.
      // test.js), and another form bound to the very same path chose the
      // coded alternative. EHRbase's FLAT rendering of that committed node
      // is then the ordinary DV_CODED_TEXT |value/|code/|terminology
      // triple, not a bare path. |code/|terminology never belong in a
      // plain-DV_TEXT runtime value - skip them and take |value (or the
      // bare, unsuffixed key for a genuinely plain DV_TEXT node) so the
      // human-readable text prefills either way. Confirmed live
      // (2026-09-02): "Kodierte Diagnose" (bound DV_TEXT, no codeMappings)
      // prefilling from "Diagnose (Basis)"'s DV_CODED_TEXT-bound
      // submission of "Arterielle Hypertonie" (ICD I10) showed "I10"
      // instead, because Object.keys() order put `|code` before `|value`
      // and this branch took whichever matched first.
      if (key.endsWith('|code') || key.endsWith('|terminology')) continue;
      value = flat[key];
    }
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

/** Reconstructs a codeMappings.enabled field's `_mapping:N` group of flat
 * keys (see writeCodeMappingsFlat) back into CodeMappingValue[] - the
 * counterpart read half of that write convention. Silently returns []
 * rather than throwing on a malformed/partial group (a `target|code` with
 * no matching `target|terminology`, say) - this is enrichment on top of
 * the field's own already-valid text value, never something that should
 * fail the whole read.
 *
 * Unlike the old `${path}/mappings/` plain-string-prefix check this
 * replaced, matching goes through the same ancestor-index-tolerant regex
 * readFlatValue uses (escapeFlatPathForMatching) - `path` itself never
 * contains a literal ancestor occurrence index (e.g. `any_event:0`), only
 * the real flat keys do, so a plain `startsWith` never matched a
 * codeMappings.enabled field nested under any repeating structural node.
 * Confirmed live (2026-09-05): medication_item_name sits under
 * `any_event:0`, so `_mapping:0`'s own key was
 * `.../any_event:0/medication_item_name/_mapping:0/target|code` - no
 * substring of that starts with the un-indexed `path` alone. Each match's
 * own literal prefix (ancestor index and all) is read directly off the
 * matched key, not reconstructed from `path` + index, so the follow-up
 * `|match`/`/target|...` lookups stay exact. */
function readCodeMappings(flat: Record<string, unknown>, path: string): Array<{ terminologyId: string; code: string; match?: string }> {
  const escaped = escapeFlatPathForMatching(path);
  const matcher = new RegExp(`^${escaped}(?::\\d+)?/_mapping:(\\d+)(?=[/|])`);
  const entryPrefixes = new Map<number, string>();
  for (const key of Object.keys(flat)) {
    const found = key.match(matcher);
    if (!found) continue;
    const index = Number(found[1]);
    if (!entryPrefixes.has(index)) entryPrefixes.set(index, key.slice(0, found[0].length));
  }
  return Array.from(entryPrefixes.entries()).sort(([a], [b]) => a - b).flatMap(([, entryPrefix]) => {
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
  const { layoutBindings } = collectFieldBindings(definition.layout);
  const processedPaths = new Set<string>();
  const readOne = (binding: FieldBinding, flatPath: string): unknown => {
    const value = readFlatValue(composition, flatPath, binding.rmType, binding.codeMappings?.enabled, Boolean(binding.repeatableGroupId));
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
