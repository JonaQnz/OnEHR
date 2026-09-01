/**
 * Extracts `term_bindings` (external-terminology cross-references, e.g. a
 * SNOMED CT mapping for a local at-code) from a raw OPT (ADL2 XML) - the one
 * piece of the constraint model that a WebTemplate JSON export genuinely
 * cannot carry (confirmed absent from a real vg_Diagnosis.v1.1.1 WebTemplate
 * export; see docs/features/opt-constraint-engine-analysis.md).
 *
 * Confirmed real structure (vg_Diagnosis.v1.1.1's actual OPT XML,
 * packages/openehr-engine/tests/fixtures/vg_Diagnosis.v1.1.1.opt.xml): an
 * OPT flattens each used archetype into a full, self-contained embedded
 * copy - so an archetype used three times (e.g. problem_qualifier.v2, once
 * at composition-context level and once each under "primary"/"secondary
 * diagnosis") appears three times, each with its own <archetype_id>...
 * <ontology>...<term_bindings terminology="SNOMED-CT">...</term_bindings>
 * block - all three copies carry identical bindings, since they all
 * describe the same source archetype. term_bindings is NOT nested inside
 * the template-level <ontology>/<component_ontologies archetype_id="...">
 * summary at the end of the document (that only carries term_definitions);
 * it lives inside each embedded archetype's own ontology, so the scoping
 * archetype id has to be recovered positionally (nearest preceding
 * <archetype_id><value>...</value></archetype_id>), not from an ancestor
 * XML element with an archetype_id attribute.
 *
 * Deliberately a pragmatic regex-based extraction, not a full ADL2/AOM XML
 * grammar parser - same spirit and same explicit non-goal as
 * metadata.ts:parseOpenEhrAqlPath ("a pragmatic best-effort match against
 * the bracket conventions... actually uses", not a general parser). A real
 * XML DOM parse would be more robust to layout changes, but this project's
 * own convention for "one specific known shape out of a much larger format"
 * is a targeted regex, documented as such - reconsider if OPT XML from
 * other CDRs/archetype sets turns out to vary this shape.
 */
import type { SemanticBinding } from 'core';

const ARCHETYPE_ID_VALUE_RE = /<archetype_id>\s*<value>([^<]+)<\/value>\s*<\/archetype_id>/g;
const TERM_BINDINGS_BLOCK_RE = /<term_bindings\s+terminology="([^"]+)">([\s\S]*?)<\/term_bindings>/g;
const BINDING_ITEM_RE = /<items code="([^"]+)">\s*<value>\s*<terminology_id>\s*<value>([^<]+)<\/value>\s*<\/terminology_id>\s*<code_string>([^<]+)<\/code_string>/g;
// EHRbase's own code_string convention for a bound external code:
// "[SNOMED-CT::8319008]" - terminology id and code, brackets optional (kept
// tolerant in case a different CDR omits them).
const CODE_STRING_RE = /^\[?([^:\]]+)::([^\]]+)\]?$/;

/** Every archetype's own term bindings, keyed by archetype id - scoped the
 * same way ArchetypeTerminology is (never a single global at-code map),
 * since the same at-code binds to different external codes in different
 * archetypes. */
export type SemanticBindingIndex = Record<string, SemanticBinding[]>;

export function parseTermBindingsFromOpt(optXml: string): SemanticBindingIndex {
  const archetypePositions: { pos: number; archetypeId: string }[] = [];
  for (const match of optXml.matchAll(ARCHETYPE_ID_VALUE_RE)) {
    const archetypeId = match[1];
    if (!archetypeId) continue;
    archetypePositions.push({ pos: match.index ?? 0, archetypeId: archetypeId.trim() });
  }
  archetypePositions.sort((a, b) => a.pos - b.pos);

  function nearestArchetypeIdBefore(pos: number): string | undefined {
    let result: string | undefined;
    for (const candidate of archetypePositions) {
      if (candidate.pos >= pos) break;
      result = candidate.archetypeId;
    }
    return result;
  }

  const byArchetype: SemanticBindingIndex = {};
  for (const block of optXml.matchAll(TERM_BINDINGS_BLOCK_RE)) {
    const archetypeId = nearestArchetypeIdBefore(block.index ?? 0);
    const body = block[2];
    if (!archetypeId || !body) continue;
    const existing = byArchetype[archetypeId] || [];
    for (const item of body.matchAll(BINDING_ITEM_RE)) {
      const sourceCode = item[1];
      const codeStringRaw = item[3];
      if (!sourceCode || !codeStringRaw) continue;
      const codeStringMatch = CODE_STRING_RE.exec(codeStringRaw.trim());
      if (!codeStringMatch) continue;
      const targetTerminologyId = codeStringMatch[1];
      const targetCode = codeStringMatch[2];
      if (!targetTerminologyId || !targetCode) continue;
      const binding: SemanticBinding = { sourceCode, targetTerminologyId, targetCode };
      // The same archetype's embedded ontology repeats identically at every
      // usage site in a flattened OPT - de-dupe rather than accumulate
      // duplicates.
      if (!existing.some((e) => e.sourceCode === binding.sourceCode && e.targetTerminologyId === binding.targetTerminologyId && e.targetCode === binding.targetCode)) {
        existing.push(binding);
      }
    }
    if (existing.length > 0) byArchetype[archetypeId] = existing;
  }
  return byArchetype;
}
