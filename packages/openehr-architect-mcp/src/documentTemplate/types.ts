/**
 * Document Template compiler pipeline:
 *
 *   DocumentTemplate -> ComponentResolver -> ComponentProjection[] -> OperationalTemplateCompiler -> OPT
 *
 * This is deliberately NOT a general ADL2/AOM2 slot-filling engine. It is a
 * narrow, pragmatic compiler that reuses already-published, already-uploaded
 * OPTs as reusable content building blocks for a new document (see
 * ../../../.claude/plans - "Document Templates aus wiederverwendbaren
 * Components" for the full rationale). Every existing single-archetype OPT
 * this app has produced so far already *is* a valid Document Component -
 * nothing new needs to be authored to start reusing them.
 */

/** A generic JSON-object representation of one parsed XML element, as
 * produced by fast-xml-parser (ignoreAttributes: false, attributeNamePrefix:
 * '@_'). Kept intentionally untyped beyond "it's a plain object/array/string"
 * - the compiler never interprets this content semantically, it only
 * relocates whole subtrees intact. */
export type XmlNode = Record<string, unknown>;

/** The RM types this compiler accepts as a *top-level* Document Component.
 * Only CONTENT_ITEM (SECTION, or an ENTRY subtype) may stand alone as one
 * document's reusable building block - a CLUSTER, ITEM_STRUCTURE (e.g.
 * ITEM_TREE) or bare ELEMENT is a part *within* an Entry/Section, never a
 * component in its own right, and is rejected rather than silently allowed. */
export const ALLOWED_COMPONENT_RM_TYPES = ['SECTION', 'OBSERVATION', 'EVALUATION', 'ACTION', 'INSTRUCTION', 'ADMIN_ENTRY'] as const;
export type ComponentRmType = (typeof ALLOWED_COMPONENT_RM_TYPES)[number];

/** One reusable building block a Document Template wants to include. No
 * `rmType` field here on purpose - the caller states which archetype boundary
 * it wants, the resolver determines (never assumes) what RM type actually
 * lives there. */
export interface DocumentComponent {
  /** An already-registered EHRbase template_id, e.g. "vg_Diagnosis.v1.1.1". */
  sourceTemplateId: string;
  /** The full archetype_id of the specific C_ARCHETYPE_ROOT to extract from
   * that template's OPT, e.g. "openEHR-EHR-EVALUATION.problem_diagnosis.v1"
   * - an archetype boundary, never an arbitrary path into an already
   * flattened subtree. */
  sourceArchetypeId: string;
  /** Disambiguates when the same archetype_id is used more than once in the
   * source template - a real, confirmed-live case (vg_Diagnosis.v1.1.1 uses
   * EVALUATION.problem_diagnosis.v1 twice: "primary diagnosis" and
   * "secondary diagnosis", the same convention openEHR's own AQL paths use,
   * e.g. ".../content[...archetype_id... and name/value='primary
   * diagnosis']"). This is that same `name/value` constraint text, still an
   * archetype-boundary-level identifier, not an arbitrary subtree path.
   * Required only when sourceArchetypeId alone does not resolve to exactly
   * one C_ARCHETYPE_ROOT - the resolver's error message lists the available
   * values when this happens. */
  sourceName?: string;
  /** Display name / SECTION label in the new document. */
  label: string;
  /** When true, the compiler wraps this component's projection in a new,
   * compiler-authored ad-hoc SECTION (openEHR-EHR-SECTION.adhoc.v1) so the
   * assembled document gets a labeled grouping even though the source
   * component itself is not already a SECTION (the common case - most
   * existing single-archetype components are bare ENTRY subtypes). Leave
   * unset/false when the projection is already a SECTION, or should hang
   * directly off the document's COMPOSITION root without its own grouping. */
  wrapInSection?: boolean;
}

/** The resolver's output for one DocumentComponent: the real, unmodified
 * C_ARCHETYPE_ROOT subtree found in the source OPT, plus which RM type it
 * actually turned out to be. Local at-codes inside `node` are left exactly
 * as found - at-codes are scoped per archetype terminology, not globally
 * unique within an OPERATIONAL_TEMPLATE, so nothing here is renumbered. */
export interface ComponentProjection {
  sourceTemplateId: string;
  sourceArchetypeId: string;
  rmType: ComponentRmType;
  label: string;
  wrapInSection: boolean;
  /** The C_ARCHETYPE_ROOT XML element, as a parsed JS object, exactly as
   * found in the source OPT (own archetype_id, own term_definitions, own
   * at-codes - untouched). */
  node: XmlNode;
}

export class ComponentResolutionError extends Error {}
