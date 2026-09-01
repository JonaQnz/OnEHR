/**
 * Builds a neutral `TemplateConstraintModel` (packages/core/src/openehr-constraint)
 * from an EHRbase WebTemplate JSON export - the "OPT -> OpenEHR Constraint
 * Model" step of the OPT constraint engine architecture.
 *
 * Deliberately scoped to what a WebTemplate response actually carries.
 * Confirmed against a real EHRbase export (vg_Diagnosis.v1.1.1, see
 * packages/openehr-engine/tests/fixtures/): a WebTemplate already includes
 * `localizedNames`/`localizedLabels`/`localizedDescriptions` for every
 * configured language in ONE response (no `?lang=` fetch-per-language
 * needed), and already disambiguates repeated same-archetype
 * C_ARCHETYPE_ROOTs via distinct node ids and a `name/value='...'` predicate
 * baked into each occurrence's own `aqlPath`. What it does NOT carry -
 * confirmed absent from that same real export - is OPT `term_bindings`
 * (external-terminology cross-references, e.g. a SNOMED mapping for
 * `local::at0064`); that half of the model is built separately, from raw
 * OPT XML, by opt/parseOptXml.ts + mergeSemanticBindings() (kept as an
 * independent, additive step so this function never needs raw XML to
 * produce a complete, correct constraint model on its own - see the
 * architecture note on the hybrid ingestion strategy).
 */
import {
  canonicalFieldId,
  canonicalInstanceKey,
  type ArchetypeInstanceDefinition,
  type ArchetypeTermDefinition,
  type ArchetypeTerminology,
  type CodedTextOption,
  type DvCodedTextConstraint,
  type OpenEhrFieldDefinition,
  type OpenEhrTerminologyIndex,
  type Occurrences,
  type TemplateConstraintModel,
  type ValueConstraint,
} from 'core';

function isDvCodedTextConstraint(constraint: ValueConstraint): constraint is DvCodedTextConstraint {
  return constraint.rmType === 'DV_CODED_TEXT' && !('unsupported' in constraint);
}
import { parseOpenEhrAqlPath } from '../metadata';
import type { SemanticBindingIndex } from './parseOptXml';

// A WebTemplate node's `nodeId` is the full archetype id (e.g.
// "openEHR-EHR-EVALUATION.problem_diagnosis.v1") exactly when that node is
// itself a C_ARCHETYPE_ROOT - the one generic, rmType-independent signal
// that works for EVALUATION/OBSERVATION/CLUSTER/ACTION/... roots alike.
const ARCHETYPE_ID_RE = /^openEHR-[A-Z_]+-[A-Z_]+\.[\w-]+\.v\d+(?:\.\d+){0,2}$/;

function isArchetypeRoot(node: WtNode): boolean {
  return typeof node.nodeId === 'string' && ARCHETYPE_ID_RE.test(node.nodeId);
}

// Leaf nodes carrying an actual value: either a concrete DV_* type, or a
// generic ELEMENT wrapping several typed alternatives as children (the
// polymorphic-slot case - see admission_diagnosis/at0073 in
// vg_Diagnosis.v1.1.1, DV_BOOLEAN or DV_CODED_TEXT for the identical path).
function isLeaf(node: WtNode): boolean {
  if (typeof node.rmType !== 'string') return false;
  if (node.rmType.startsWith('DV_') || node.rmType === 'CODE_PHRASE') return true;
  if (node.rmType === 'ELEMENT' && Array.isArray(node.children) && node.children.length > 0) {
    return node.children.every((child) => typeof child.rmType === 'string' && child.rmType.startsWith('DV_'));
  }
  return false;
}

export interface WtOption {
  value: string;
  label?: string;
  localizedLabels?: Record<string, string>;
  localizedDescriptions?: Record<string, string>;
}

export interface WtInput {
  suffix?: string;
  type?: string;
  terminology?: string;
  listOpen?: boolean;
  list?: WtOption[];
}

export interface WtNode {
  id?: string;
  name?: string;
  nodeId?: string;
  rmType?: string;
  aqlPath?: string;
  min?: number;
  max?: number;
  localizedNames?: Record<string, string>;
  localizedDescriptions?: Record<string, string>;
  inputs?: WtInput[];
  annotations?: { comment?: string };
  children?: WtNode[];
}

export interface WebTemplateJson {
  templateId: string;
  version?: string;
  semVer?: string;
  defaultLanguage?: string;
  languages?: string[];
  tree: WtNode;
}

function occurrencesOf(node: WtNode): Occurrences {
  const min = typeof node.min === 'number' ? node.min : 0;
  const max = typeof node.max === 'number' && node.max >= 0 ? node.max : null;
  return { min, max };
}

/** Extracts the `name/value='...'` fixed-instance constraint from the LAST
 * archetype bracket in an aqlPath - i.e. the one belonging to the node this
 * aqlPath is itself for, matching parseOpenEhrAqlPath's own "last bracket"
 * convention. */
function extractNameConstraint(aqlPath: string | undefined): string | undefined {
  if (!aqlPath) return undefined;
  const re = /\[openEHR-[A-Z_]+-[A-Z_]+\.[\w-]+\.v\d+(?:\.\d+){0,2}(?:\s+and\s+name\/value='([^']*)')?\]/g;
  let last: RegExpMatchArray | undefined;
  for (const match of aqlPath.matchAll(re)) last = match;
  return last?.[1];
}

function termDefFrom(text: string | undefined, description?: string, comment?: string): ArchetypeTermDefinition | undefined {
  if (!text) return undefined;
  return { text, ...(description ? { description } : {}), ...(comment ? { comment } : {}) };
}

/** Merges one code's per-language term text/description into an
 * archetype-scoped terminology in place. */
function recordTerm(terminology: ArchetypeTerminology, code: string, localizedNames: Record<string, string> | undefined, localizedDescriptions: Record<string, string> | undefined): void {
  if (!localizedNames) return;
  for (const [lang, text] of Object.entries(localizedNames)) {
    const def = termDefFrom(text, localizedDescriptions?.[lang]);
    if (!def) continue;
    if (!terminology.languages[lang]) terminology.languages[lang] = {};
    terminology.languages[lang][code] = def;
  }
}

/** Walks every descendant of `node` (stopping at, but not descending past,
 * a nested archetype root - that subtree gets its own independent
 * terminology when it's processed as its own ArchetypeInstanceDefinition)
 * and folds every code it finds - both the node's own nodeId (its "at-code
 * as a term") and every coded-value-set option's code - into `terminology`. */
function collectTerminology(node: WtNode, terminology: ArchetypeTerminology, isRoot: boolean): void {
  if (!isRoot && isArchetypeRoot(node)) return; // nested archetype root: own scope, handled separately
  if (node.nodeId && /^at\d+(?:\.\d+)?$/.test(node.nodeId)) {
    recordTerm(terminology, node.nodeId, node.localizedNames, node.localizedDescriptions);
  }
  for (const input of node.inputs || []) {
    for (const option of input.list || []) {
      recordTerm(terminology, option.value, option.localizedLabels || (option.label ? { [option.label]: option.label } : undefined), option.localizedDescriptions);
    }
  }
  for (const child of node.children || []) collectTerminology(child, terminology, false);
}

function buildOptions(input: WtInput, defaultLanguage: string): CodedTextOption[] {
  return (input.list || []).map((option) => ({
    terminologyId: input.terminology || 'local',
    codeString: option.value,
    text: option.localizedLabels?.[defaultLanguage] || option.label || option.value,
    ...(option.localizedDescriptions?.[defaultLanguage] ? { description: option.localizedDescriptions[defaultLanguage] } : {}),
  }));
}

/** Builds the ValueConstraint(s) for one concrete-rmType WebTemplate node
 * (i.e. NOT the polymorphic ELEMENT-with-children case, handled by the
 * caller). A node with a `code`-suffixed coded-text input AND a sibling
 * `other`-suffixed free-text input (confirmed the real, consistent shape
 * for every "coded-or-free-text" field in vg_Diagnosis.v1.1.1 - severity,
 * diagnostic_certainty, diagnostic_category, course_label,
 * multiple_coding_identifier) becomes a two-entry union:
 * [DV_CODED_TEXT, DV_TEXT] - the alternative is preserved, not discarded. */
function buildConcreteConstraints(node: WtNode, defaultLanguage: string): ValueConstraint[] {
  const rmType = node.rmType as string;
  if (rmType === 'DV_CODED_TEXT' || rmType === 'CODE_PHRASE') {
    const constraints: ValueConstraint[] = [];
    const codeInput = (node.inputs || []).find((input) => input.suffix === 'code' || input.type === 'CODED_TEXT');
    const otherInput = (node.inputs || []).find((input) => input.suffix === 'other' || input.type === 'TEXT');
    const listInput = codeInput || (node.inputs || [])[0];
    constraints.push({
      rmType: 'DV_CODED_TEXT',
      terminologyId: listInput?.terminology || 'local',
      allowedCodes: (listInput?.list || []).map((option) => option.value),
      options: listInput ? buildOptions(listInput, defaultLanguage) : [],
      openEnded: Boolean(listInput?.listOpen),
    });
    if (otherInput) constraints.push({ rmType: 'DV_TEXT' });
    return constraints;
  }
  if (rmType === 'DV_QUANTITY') {
    const unitsInput = (node.inputs || []).find((input) => input.suffix === 'unit' || input.suffix === 'units');
    return [{ rmType: 'DV_QUANTITY', units: (unitsInput?.list || []).map((option) => option.value) }];
  }
  if (rmType === 'DV_ORDINAL') {
    const listInput = (node.inputs || [])[0];
    return [{ rmType: 'DV_ORDINAL', options: listInput ? buildOptions(listInput, defaultLanguage) : [] }];
  }
  const known = ['DV_TEXT', 'DV_BOOLEAN', 'DV_DATE', 'DV_TIME', 'DV_DATE_TIME', 'DV_DURATION', 'DV_COUNT', 'DV_PROPORTION', 'DV_IDENTIFIER', 'DV_URI'];
  if (known.includes(rmType)) return [{ rmType } as ValueConstraint];
  return [{ rmType, unsupported: true }];
}

function buildField(node: WtNode, archetypeId: string, instanceKey: string, instanceRootPath: string, defaultLanguage: string, warnings: string[]): OpenEhrFieldDefinition {
  const parsed = parseOpenEhrAqlPath(node.aqlPath);
  const nodeId = parsed.archetypeNodeId || node.nodeId || node.id || 'unknown';
  const relativePath = (node.aqlPath || '').startsWith(instanceRootPath) ? (node.aqlPath as string).slice(instanceRootPath.length) : (node.aqlPath || node.id || nodeId);
  const isPolymorphic = node.rmType === 'ELEMENT' && Array.isArray(node.children) && node.children.length > 0;
  const valueConstraints: ValueConstraint[] = isPolymorphic
    ? (node.children as WtNode[]).flatMap((child) => buildConcreteConstraints(child, defaultLanguage))
    : buildConcreteConstraints(node, defaultLanguage);
  const parsingStatus: 'complete' | 'partial' = valueConstraints.some((c) => 'unsupported' in c && c.unsupported) ? 'partial' : 'complete';
  if (parsingStatus === 'partial') warnings.push(`Field '${node.id}' (${node.aqlPath}) has an unsupported constraint type: ${valueConstraints.map((c) => c.rmType).join(', ')}`);
  return {
    id: canonicalFieldId(instanceKey, relativePath),
    archetypeId,
    archetypeInstanceKey: instanceKey,
    nodeId,
    rmType: 'ELEMENT',
    path: node.aqlPath || '',
    label: node.localizedNames || (node.name ? { [defaultLanguage]: node.name } : {}),
    ...(node.localizedDescriptions ? { description: node.localizedDescriptions } : {}),
    ...(node.annotations?.comment ? { comment: node.annotations.comment } : {}),
    occurrences: occurrencesOf(node),
    valueConstraints,
    parsingStatus,
    ...(parsingStatus === 'partial' ? { warnings: [`Unsupported constraint type: ${valueConstraints.find((c) => 'unsupported' in c)?.rmType}`] } : {}),
  };
}

let instanceCounter = new Map<string, number>();

function nextIndexFor(archetypeId: string): number {
  const current = instanceCounter.get(archetypeId) ?? 0;
  instanceCounter.set(archetypeId, current + 1);
  return current;
}

function buildArchetypeInstance(node: WtNode, defaultLanguage: string, warnings: string[]): ArchetypeInstanceDefinition {
  const archetypeId = node.nodeId as string;
  const nameConstraint = extractNameConstraint(node.aqlPath);
  const index = nextIndexFor(archetypeId);
  const instanceKey = canonicalInstanceKey(archetypeId, nameConstraint, index);
  const terminology: ArchetypeTerminology = { archetypeId, languages: {} };
  collectTerminology(node, terminology, true);

  const fields: OpenEhrFieldDefinition[] = [];
  const childInstances: ArchetypeInstanceDefinition[] = [];

  function walk(current: WtNode): void {
    if (current !== node && isArchetypeRoot(current)) {
      childInstances.push(buildArchetypeInstance(current, defaultLanguage, warnings));
      return;
    }
    if (isLeaf(current)) {
      fields.push(buildField(current, archetypeId, instanceKey, node.aqlPath || '', defaultLanguage, warnings));
      return; // a leaf's own children (polymorphic alternatives) are not walked further
    }
    for (const child of current.children || []) walk(child);
  }
  for (const child of node.children || []) walk(child);

  return {
    archetypeId,
    instanceKey,
    ...(node.id ? { nodeId: node.id } : {}),
    rmType: node.rmType || 'UNKNOWN',
    ...(nameConstraint ? { nameConstraint } : {}),
    path: node.aqlPath || '',
    occurrences: occurrencesOf(node),
    terminology,
    fields,
    children: childInstances,
  };
}

/** Builds the full neutral constraint model for one WebTemplate. Pure
 * function of its input - safe to call repeatedly/in parallel (the
 * archetype-instance disambiguation counter is scoped to one call). */
export function buildConstraintModelFromWebTemplate(webTemplate: WebTemplateJson, options: { language?: string } = {}): TemplateConstraintModel {
  instanceCounter = new Map<string, number>();
  const defaultLanguage = webTemplate.defaultLanguage || 'en';
  const languages = webTemplate.languages && webTemplate.languages.length > 0 ? webTemplate.languages : [defaultLanguage];
  // The language CodedTextOption.text/field.label resolve to by default -
  // independent of the template's own defaultLanguage, and independent of
  // ArchetypeTerminology (which always keeps every language regardless of
  // this choice; resolveTerm can still ask for any of them).
  const displayLanguage = options.language && languages.includes(options.language) ? options.language : defaultLanguage;
  const warnings: string[] = [];
  const archetypeInstances: ArchetypeInstanceDefinition[] = [];

  function walkRoot(node: WtNode): void {
    if (isArchetypeRoot(node)) {
      archetypeInstances.push(buildArchetypeInstance(node, displayLanguage, warnings));
      return;
    }
    for (const child of node.children || []) walkRoot(child);
  }
  walkRoot(webTemplate.tree);

  const terminologyIndex: OpenEhrTerminologyIndex = {};
  function indexTerminologies(instance: ArchetypeInstanceDefinition): void {
    // Two instances of the same archetype (e.g. problem_qualifier.v2 used
    // three times) share one terminology scope by definition (same
    // archetype id = same term definitions) - merge rather than overwrite
    // so no instance's terms are lost if they were parsed slightly
    // differently, though in practice they are identical.
    const existing = terminologyIndex[instance.archetypeId];
    if (!existing) {
      terminologyIndex[instance.archetypeId] = instance.terminology;
    } else {
      for (const [lang, terms] of Object.entries(instance.terminology.languages)) {
        existing.languages[lang] = { ...(existing.languages[lang] || {}), ...terms };
      }
    }
    instance.children.forEach(indexTerminologies);
  }
  archetypeInstances.forEach(indexTerminologies);

  const version = webTemplate.semVer || webTemplate.version;
  return {
    templateId: webTemplate.templateId,
    ...(version ? { version } : {}),
    defaultLanguage,
    languages,
    archetypeInstances,
    terminologyIndex,
    warnings,
  };
}

/**
 * Attaches term_bindings (from parseTermBindingsFromOpt, raw OPT XML) onto
 * the matching DV_CODED_TEXT options of an already-built constraint model -
 * a separate, additive step so buildConstraintModelFromWebTemplate() never
 * needs raw XML to produce a complete, correct model on its own (see the
 * module doc comment). Pure: returns a new model, the input is untouched.
 *
 * Deliberately only ever adds `CodedTextOption.semanticBindings` - never
 * touches `codeString`/`terminologyId`, and has no way to reach
 * `defining_code` at all (that only exists on a *runtime* value, built
 * later, from `codeString`/`terminologyId` alone). This is the concrete
 * mechanism that keeps a term_binding from ever being usable as the value
 * actually stored for a clinical selection - see "Term Bindings separat
 * behandeln" in the architecture doc: selecting "Hauptdiagnose"
 * (local::at0064) must always serialize as `local::at0064`, never silently
 * as the bound `SNOMED-CT::8319008`, however that binding is surfaced in an
 * inspector.
 */
export function mergeSemanticBindings(model: TemplateConstraintModel, bindingsByArchetype: SemanticBindingIndex): TemplateConstraintModel {
  const cloned: TemplateConstraintModel = JSON.parse(JSON.stringify(model));
  function annotateField(field: OpenEhrFieldDefinition): void {
    const bindings = bindingsByArchetype[field.archetypeId];
    if (!bindings || bindings.length === 0) return;
    for (const constraint of field.valueConstraints) {
      if (!isDvCodedTextConstraint(constraint) || !constraint.options) continue;
      for (const option of constraint.options) {
        const matches = bindings.filter((b) => b.sourceCode === option.codeString);
        if (matches.length > 0) option.semanticBindings = matches;
      }
    }
  }
  function walk(instance: ArchetypeInstanceDefinition): void {
    instance.fields.forEach(annotateField);
    instance.children.forEach(walk);
  }
  cloned.archetypeInstances.forEach(walk);
  return cloned;
}
