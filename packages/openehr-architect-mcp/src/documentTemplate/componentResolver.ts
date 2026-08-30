import { XMLParser } from 'fast-xml-parser';
import { ALLOWED_COMPONENT_RM_TYPES, ComponentResolutionError, type ComponentProjection, type ComponentRmType, type DocumentComponent, type XmlNode } from './types.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

/** Fetches and parses one source OPT once per (templateId), so resolving
 * several components from the same source template (e.g. a document that
 * reuses two archetypes out of the same template) only does one HTTP call. */
export interface OptSource {
  getTemplateOpt(templateId: string): Promise<string>;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as Record<string, unknown>)['#text'] === 'string') return (value as Record<string, unknown>)['#text'] as string;
  return undefined;
}

/** Depth-first search for every C_ARCHETYPE_ROOT element anywhere in a
 * parsed OPT (including nested ones, e.g. a slot-filling archetype nested
 * inside another archetype's own `items`) - deliberately structure-agnostic
 * (it does not assume archetype roots only ever appear directly under
 * `content`) so a genuine duplicate `archetype_id` is caught wherever it
 * occurs, not just at the top level. */
function findArchetypeRoots(node: unknown, out: XmlNode[] = []): XmlNode[] {
  if (Array.isArray(node)) {
    for (const item of node) findArchetypeRoots(item, out);
    return out;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if (obj['@_xsi:type'] === 'C_ARCHETYPE_ROOT') out.push(obj);
    for (const key of Object.keys(obj)) {
      if (key === '@_xsi:type') continue;
      findArchetypeRoots(obj[key], out);
    }
  }
  return out;
}

function archetypeIdOf(root: XmlNode): string | undefined {
  const archetypeId = root.archetype_id as Record<string, unknown> | undefined;
  return archetypeId ? textOf(archetypeId.value) : undefined;
}

/** Depth-first search for the first `list` value anywhere under a node -
 * used to read a C_STRING/C_DV_TEXT constraint's actual text
 * (`<item xsi:type="C_STRING"><list>primary diagnosis</list></item>`)
 * without hardcoding the exact C_SINGLE_ATTRIBUTE/C_COMPLEX_OBJECT nesting
 * chain a real OPT uses to express it (confirmed live against
 * vg_Diagnosis.v1.1.1's real OPT XML), matching this module's existing
 * structure-agnostic style rather than a brittle fixed path. */
function findFirstListText(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) { const found = findFirstListText(item); if (found !== undefined) return found; }
    return undefined;
  }
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    if ('list' in obj) {
      const listValue = obj.list;
      const text = textOf(Array.isArray(listValue) ? listValue[0] : listValue);
      if (text !== undefined) return text;
    }
    for (const key of Object.keys(obj)) {
      const found = findFirstListText(obj[key]);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Reads a C_ARCHETYPE_ROOT's own `name` attribute constraint text, if it
 * has one - the same `name/value='...'` qualifier openEHR's own AQL paths
 * use to disambiguate the same archetype reused more than once (e.g.
 * "primary diagnosis" vs. "secondary diagnosis" for two
 * EVALUATION.problem_diagnosis.v1 roots in the same template). */
function nameConstraintOf(root: XmlNode): string | undefined {
  const nameAttr = asArray(root.attributes as XmlNode | XmlNode[] | undefined)
    .find((attr) => textOf((attr as XmlNode).rm_attribute_name) === 'name');
  return nameAttr ? findFirstListText(nameAttr) : undefined;
}

function isAllowedComponentRmType(value: string | undefined): value is ComponentRmType {
  return (ALLOWED_COMPONENT_RM_TYPES as readonly string[]).includes(value ?? '');
}

/** Resolves one DocumentComponent to its ComponentProjection: fetches the
 * source OPT, locates the single C_ARCHETYPE_ROOT whose archetype_id matches
 * `sourceArchetypeId`, determines its real RM type, and rejects anything
 * that isn't a valid top-level component (see ALLOWED_COMPONENT_RM_TYPES).
 * Never renumbers or otherwise touches the found subtree. */
export async function resolveComponent(source: OptSource, component: DocumentComponent): Promise<ComponentProjection> {
  const optXml = await source.getTemplateOpt(component.sourceTemplateId);
  const parsed = parser.parse(optXml) as XmlNode;
  const roots = findArchetypeRoots(parsed);
  let matches = roots.filter((root) => archetypeIdOf(root) === component.sourceArchetypeId);

  if (matches.length === 0) {
    throw new ComponentResolutionError(
      `Archetyp '${component.sourceArchetypeId}' wurde in Template '${component.sourceTemplateId}' nicht gefunden.`,
    );
  }

  // The same archetype_id can legitimately appear more than once in one
  // template, disambiguated by its own `name` constraint - confirmed live
  // against vg_Diagnosis.v1.1.1 (EVALUATION.problem_diagnosis.v1 used for
  // both "primary diagnosis" and "secondary diagnosis"). `sourceName` is
  // openEHR's own disambiguator for exactly this case (see types.ts).
  if (component.sourceName !== undefined) {
    const named = matches.filter((root) => nameConstraintOf(root) === component.sourceName);
    if (named.length === 0) {
      const available = matches.map(nameConstraintOf).filter((name): name is string => Boolean(name));
      throw new ComponentResolutionError(
        `sourceName '${component.sourceName}' passt auf keine der ${matches.length} Fundstelle(n) von '${component.sourceArchetypeId}' in Template '${component.sourceTemplateId}'. `
        + `Verfügbare name-Qualifier: ${available.length ? available.join(', ') : '(keine erkannt)'}.`,
      );
    }
    if (named.length > 1) {
      throw new ComponentResolutionError(
        `sourceName '${component.sourceName}' ist selbst nicht eindeutig für '${component.sourceArchetypeId}' in Template '${component.sourceTemplateId}' (${named.length}x).`,
      );
    }
    matches = named;
  } else if (matches.length > 1) {
    const available = matches.map((root) => nameConstraintOf(root) ?? '(kein name-Constraint)');
    throw new ComponentResolutionError(
      `Archetyp '${component.sourceArchetypeId}' kommt mehrfach in Template '${component.sourceTemplateId}' vor (${matches.length}x) - `
      + `eine eindeutige Zuordnung ist ohne \`sourceName\` nicht möglich. Verfügbare name-Qualifier: ${available.join(', ')}.`,
    );
  }

  const node = matches[0];
  const rmType = textOf(node.rm_type_name);
  if (!isAllowedComponentRmType(rmType)) {
    throw new ComponentResolutionError(
      `Archetyp '${component.sourceArchetypeId}' in Template '${component.sourceTemplateId}' hat RM-Typ '${rmType ?? 'unbekannt'}' - `
      + `als Document Component sind nur CONTENT_ITEM-Typen zulässig (${ALLOWED_COMPONENT_RM_TYPES.join(', ')}). `
      + 'CLUSTER/ITEM_STRUCTURE/ELEMENT sind Bestandteile innerhalb eines Entry/einer Section, keine eigenständigen Document Components.',
    );
  }

  return {
    sourceTemplateId: component.sourceTemplateId,
    sourceArchetypeId: component.sourceArchetypeId,
    rmType,
    label: component.label,
    wrapInSection: Boolean(component.wrapInSection),
    node,
  };
}

export async function resolveComponents(source: OptSource, components: DocumentComponent[]): Promise<ComponentProjection[]> {
  const projections: ComponentProjection[] = [];
  for (const component of components) projections.push(await resolveComponent(source, component));
  return projections;
}
