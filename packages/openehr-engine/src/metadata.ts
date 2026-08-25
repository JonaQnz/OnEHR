import type { CanonicalForm, FormElementLayout, OpenEhrBinding } from 'core';

/**
 * Everything derivable from one raw WebTemplate `aqlPath` string (EHRbase's
 * own path, already in real AQL-path form) at parse time: the leaf node's
 * own archetype node id, the nearest-enclosing archetype id, and the RM
 * version embedded in that archetype id. This is the ONE place that scrapes
 * these out of a path string - nowhere else should regex an aqlPath for
 * this; call this and read the result.
 *
 * Not a full ADL/AQL grammar parser - a pragmatic best-effort match against
 * the bracket conventions EHRbase's own WebTemplate export actually uses
 * (`[at0004]`, `[openEHR-EHR-OBSERVATION.blood_pressure.v2]`), same spirit
 * as the rest of this package's flat-path handling.
 */
export interface ParsedOpenEhrPath {
  archetypeNodeId?: string;
  archetypeId?: string;
  rmVersion?: string;
}

const AT_CODE_RE = /\[(at\d+(?:\.\d+)?)\]/g;
const ARCHETYPE_BRACKET_RE = /\[(openEHR-[A-Z_]+-[A-Z_]+\.[a-zA-Z0-9_-]+\.(v\d+(?:\.\d+){0,2}))\]/g;

function lastMatch(re: RegExp, input: string): RegExpMatchArray | undefined {
  let last: RegExpMatchArray | undefined;
  for (const match of input.matchAll(re)) last = match;
  return last;
}

export function parseOpenEhrAqlPath(aqlPath: string | undefined): ParsedOpenEhrPath {
  if (!aqlPath) return {};
  // The node's own identity is the LAST at-code in the path (path segments
  // read root -> leaf, so the final one is this node); the archetype id is
  // the NEAREST enclosing one, likewise the last archetype-bracket segment.
  const atCode = lastMatch(AT_CODE_RE, aqlPath);
  const archetype = lastMatch(ARCHETYPE_BRACKET_RE, aqlPath);
  return {
    ...(atCode ? { archetypeNodeId: atCode[1] } : {}),
    ...(archetype ? { archetypeId: archetype[1], rmVersion: archetype[2] } : {}),
  };
}

/**
 * The archetype-internal path (at-codes relative to the archetype's own
 * root), derived from the full aqlPath by stripping everything up to and
 * including the nearest-enclosing archetype bracket - e.g.
 * "/content[openEHR-EHR-OBSERVATION.blood_pressure.v2]/data[at0001]/events[at0006]/data[at0003]/items[at0004]"
 * -> "/data[at0001]/events[at0006]/data[at0003]/items[at0004]". Not stored -
 * derived on demand, since it never disagrees with the stored aqlPath.
 */
export function toArchetypePath(aqlPath: string | undefined): string | undefined {
  if (!aqlPath) return undefined;
  const archetype = lastMatch(ARCHETYPE_BRACKET_RE, aqlPath);
  if (!archetype || archetype.index === undefined) return aqlPath;
  return aqlPath.slice(archetype.index + archetype[0].length);
}

function nodeIdentity(node: FormElementLayout): string | undefined {
  return node.id || node.name;
}

interface OpenEhrElementIndex {
  byId: Map<string, FormElementLayout>;
  byNodeId: Map<string, FormElementLayout[]>;
  byPath: Map<string, FormElementLayout[]>;
}

// Layout trees are treated as immutable (replaced, not mutated in place)
// throughout this codebase, so a WeakMap keyed by the layout object itself
// is a safe, simple memoization - the same definition's index is only ever
// built once, however many getX() calls a consumer (e.g. the Developer
// Inspector) makes against it.
const indexCache = new WeakMap<FormElementLayout, OpenEhrElementIndex>();

function buildIndex(layout: FormElementLayout): OpenEhrElementIndex {
  const cached = indexCache.get(layout);
  if (cached) return cached;
  const byId = new Map<string, FormElementLayout>();
  const byNodeId = new Map<string, FormElementLayout[]>();
  const byPath = new Map<string, FormElementLayout[]>();
  const addTo = (map: Map<string, FormElementLayout[]>, key: string | undefined, node: FormElementLayout) => {
    if (!key) return;
    const list = map.get(key);
    if (list) list.push(node); else map.set(key, [node]);
  };
  function walk(node: FormElementLayout): void {
    const id = nodeIdentity(node);
    if (id) byId.set(id, node);
    addTo(byNodeId, node.binding?.archetypeNodeId, node);
    addTo(byPath, node.binding?.path, node);
    node.children?.forEach(walk);
  }
  walk(layout);
  const index = { byId, byNodeId, byPath };
  indexCache.set(layout, index);
  return index;
}

/** The single per-element openEHR identity record - RM type, archetype
 * node id, archetype id, paths, template origin. `undefined` if the
 * element doesn't exist or was never bound (e.g. a pure layout container
 * with no openEHR meaning). */
export function getElementMetadata(definition: Pick<CanonicalForm, 'layout'>, elementId: string): OpenEhrBinding | undefined {
  return buildIndex(definition.layout).byId.get(elementId)?.binding;
}

/** Archetype-internal path (at-codes only, no template/composition prefix) - see toArchetypePath(). */
export function getArchetypePath(definition: Pick<CanonicalForm, 'layout'>, elementId: string): string | undefined {
  return toArchetypePath(getElementMetadata(definition, elementId)?.path);
}

/** The WebTemplate's own id-based technical/flat path (what submission actually uses). */
export function getTemplatePath(definition: Pick<CanonicalForm, 'layout'>, elementId: string): string | undefined {
  return getElementMetadata(definition, elementId)?.flatPath;
}

/** EHRbase's own aqlPath, verbatim - already a real AQL-usable path. */
export function getAqlPath(definition: Pick<CanonicalForm, 'layout'>, elementId: string): string | undefined {
  return getElementMetadata(definition, elementId)?.path;
}

/** The (first) element whose own aqlPath equals `path` exactly. */
export function resolveElementByPath(definition: Pick<CanonicalForm, 'layout'>, path: string): FormElementLayout | undefined {
  return buildIndex(definition.layout).byPath.get(path)?.[0];
}

/** Every element sharing this archetype node id - e.g. every occurrence of
 * a repeating CLUSTER, or every place in a template a given at-code is
 * reused. Runtime occurrence identity (which instance) is a separate,
 * orthogonal concept - see the array-index/`:N` flat-path convention in
 * this package's toOpenEhrFlatComposition/fromOpenEhrFlatComposition. */
export function resolveElementsByNodeId(definition: Pick<CanonicalForm, 'layout'>, nodeId: string): FormElementLayout[] {
  return buildIndex(definition.layout).byNodeId.get(nodeId) || [];
}
