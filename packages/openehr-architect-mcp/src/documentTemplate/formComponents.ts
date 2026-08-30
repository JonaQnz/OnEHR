import { ComponentResolutionError, type DocumentComponent } from './types.js';

/** The minimal shape this module needs from a Forms `CanonicalForm` - kept
 * duck-typed on purpose (no dependency on the `core` package) so
 * `deriveDocumentComponents` stays a pure, easily unit-testable function
 * fed with plain fixtures, exactly like the rest of this module. Matches
 * `packages/core/src/canonical/index.ts`'s real `CanonicalForm`/
 * `OpenEhrBinding` shape closely enough that a real form record satisfies
 * it directly. */
export interface FormLikeBinding {
  openehr: {
    path: string;
    archetypeId?: string;
  };
}
export interface FormLike {
  name: string;
  sourceTemplates?: Array<{ id: string }>;
  bindings?: Record<string, FormLikeBinding>;
}

export interface DeriveDocumentComponentsOptions {
  /** Overrides the label(s) this form's component(s) get in the composed
   * document. Defaults to the form's own name - suffixed per-archetype if
   * the form yields more than one component (see below). */
  label?: string;
  /** Forwarded to every derived DocumentComponent. Defaults to true, same
   * as compose_document_template's own convention. */
  wrapInSection?: boolean;
}

/** Extracts the openEHR `name/value='...'` disambiguator from a raw AQL
 * path string, e.g. ".../and name/value='primary diagnosis']/..." ->
 * "primary diagnosis" - the exact same convention
 * ComponentResolver.nameConstraintOf reads off the real OPT XML, applied
 * here to the path string a Form's own binding already carries. */
function extractSourceName(path: string): string | undefined {
  return path.match(/and name\/value='([^']+)'/)?.[1];
}

/** The human-readable "concept" segment of an archetype id, e.g.
 * "openEHR-EHR-EVALUATION.clinical_synopsis.v1" -> "clinical synopsis".
 * Used only to keep multiple components derived from one form
 * distinguishable by label (see below) - purely cosmetic, never used for
 * identity/matching. */
function archetypeConceptName(archetypeId: string): string {
  const parts = archetypeId.split('.');
  return (parts.length >= 2 ? parts[1] : archetypeId).replace(/_/g, ' ');
}

/**
 * Translates an already-built Form into the DocumentComponent(s) it
 * represents, so "pack these Forms together" needs no manual
 * sourceTemplateId/sourceArchetypeId entry - see
 * packages/mcp-server's pack_forms_into_document_template tool, the only
 * caller. A Form's own `bindings` already carry `archetypeId`/`path` per
 * field (populated by webTemplateParser.ts at generation time) - this is a
 * pure re-derivation of what's already there, not new data.
 *
 * A Form can map more than one archetype (confirmed live:
 * "Entlassungsbrief-Zusammenfassung" binds both EVALUATION.clinical_synopsis
 * and EVALUATION.recommendation) - that yields multiple DocumentComponents
 * from one Form, not one. Likewise a Form binding the same archetype twice
 * under two different `name/value` qualifiers (e.g. "primary diagnosis" /
 * "secondary diagnosis") yields two distinct components, each carrying its
 * own `sourceName`.
 *
 * Rejects (rather than guesses) when a Form doesn't have exactly one
 * sourceTemplates entry, or has no archetype-bound bindings at all - the
 * same "fail loud, don't silently pick" principle ComponentResolver already
 * follows for the archetype-level pipeline this sits in front of.
 */
export function deriveDocumentComponents(form: FormLike, options: DeriveDocumentComponentsOptions = {}): DocumentComponent[] {
  const sourceTemplates = form.sourceTemplates ?? [];
  if (sourceTemplates.length !== 1) {
    throw new ComponentResolutionError(
      `Form '${form.name}' nutzt ${sourceTemplates.length} sourceTemplates (erwartet genau 1) - `
      + 'deriveDocumentComponents unterstützt in v1 nur Forms mit genau einem Source-Template.',
    );
  }
  const sourceTemplateId = sourceTemplates[0].id;

  // Group by (archetypeId, sourceName) so the same archetype bound twice
  // under two different name-qualifiers still yields two distinct
  // components, not one merged/ambiguous one.
  const seen = new Map<string, { archetypeId: string; sourceName?: string }>();
  for (const binding of Object.values(form.bindings ?? {})) {
    const archetypeId = binding.openehr.archetypeId;
    if (!archetypeId) continue;
    const sourceName = extractSourceName(binding.openehr.path);
    const key = `${archetypeId}::${sourceName ?? ''}`;
    if (!seen.has(key)) seen.set(key, { archetypeId, sourceName });
  }

  if (seen.size === 0) {
    throw new ComponentResolutionError(
      `Form '${form.name}' hat keine Bindings mit erkennbarer archetypeId - kann nicht als Document Component verwendet werden.`,
    );
  }

  const entries = [...seen.values()];
  const baseLabel = options.label ?? form.name;
  const wrapInSection = options.wrapInSection ?? true;

  return entries.map(({ archetypeId, sourceName }) => ({
    sourceTemplateId,
    sourceArchetypeId: archetypeId,
    ...(sourceName ? { sourceName } : {}),
    // Only suffix the label when this form yields more than one component -
    // the common single-archetype case keeps the caller's plain label.
    label: entries.length > 1 ? `${baseLabel} – ${archetypeConceptName(archetypeId)}` : baseLabel,
    wrapInSection,
  }));
}
