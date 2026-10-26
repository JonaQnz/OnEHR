import type { OpenEhrCapabilityConfig } from '../openehr/capabilityBridge';
import type { DynamicCapabilityRegistry } from './dynamicRegistry';

/**
 * Spec section 23's own worked example - which real, already-published Form
 * Builder artifacts back each known openEHR capability. Static, not
 * data-driven: for this POC's scope (spec section 41 - concentrate on the
 * LAE scenario, don't build a generic catalog-authoring system) a plain
 * lookup is exactly enough, and keeps every id in one place instead of
 * scattered across engine.ts's event handlers.
 *
 * Every entry here is hand-reviewed and live-tested by a human/agent before
 * being added - `capability/dynamicRegistry.ts`'s `DynamicCapabilityRegistry`
 * is the sibling, MCP-tool-writable store for a capability discovered or
 * created LATER without editing this file (see mcp/tools/capabilityTools.ts).
 * `resolveCapability` below checks that dynamic registry first (a later
 * correction should win), then falls back to this static catalog.
 */
export const OPENEHR_CAPABILITIES: Record<string, OpenEhrCapabilityConfig> = {
  anamnesis: {
    role: 'composed',
    compositionFormId: '94fba4cc-a179-4780-94f9-1cc9dba42f0a', // "Anamnese"
    blockId: 'block-diagnosis-1',
    formSectionFormId: '88857072-b166-4f1e-bec7-56b779209669', // "Kodierte Diagnose"
    forceNewComposition: false,
  },
  'vital-signs': {
    role: 'composed',
    compositionFormId: 'b82c488f-688a-49d2-8031-447a0440d098', // "Vitalzeichen-Erfassung"
    blockId: 'vitals_block',
    formSectionFormId: '61730ea9-284d-458f-b173-47902d0a7c90', // "Vitalzeichen"
    forceNewComposition: true,
  },
  // User's own ask: nursing/doctor rounds and lab results must be REAL
  // openEHR entries, not invented ones. All three live-verified end to end
  // (create_form_session -> attach_composition_block -> submit) before
  // being wired in here - "Laborbericht mit Probe (Panel)" is ARCHIVED
  // (superseded by a newer published version) but confirmed to still
  // submit correctly at runtime; archiving only affects whether a form is
  // offered for NEW composition designs, not whether an existing binding
  // still works.
  'nursing-round': {
    role: 'composed',
    compositionFormId: '5f70143f-bb4d-4d44-8553-0103b597c246', // "Pflege & Verlauf"
    blockId: 'block-nursing',
    formSectionFormId: '6f1449d1-bd94-4ab4-ac40-d3cbc8412847', // "Pflegebericht"
    forceNewComposition: true,
  },
  // "Klinische Anordnung" is a different, broader shape than the new
  // "order-basis" capability below (vg_ServiceRequest.v1.1.1) - conceptually
  // built on the same order-request idea, tagged `basedOn` for now as
  // documentation only (its own field layout is not rebuilt to embed
  // order-basis's fields in this pass - see OpenEhrCapabilityConfig.role's
  // own doc comment).
  'doctor-round': {
    role: 'composed', basedOn: 'order-basis',
    compositionFormId: 'eb0e66f3-f8d2-4bd2-8924-87b281de83a9', // "Diagnostik & Labor"
    blockId: 'block-order',
    formSectionFormId: 'fe7c41d6-32e8-4840-9974-effb9354fe54', // "Klinische Anordnung"
    forceNewComposition: true,
  },
  // "Laborbericht mit Probe (Panel)" (vg_diagnosticreportlab.v1.1.2, a
  // DiagnosticReport-shaped panel bundling several analytes) is a different
  // archetype from "Laborwert (Basis)" below (vg_ObservationLab.v1.2.0, one
  // atomic analyte result) - a real panel report is, conceptually, made of
  // several Basis-level lab values. Same `basedOn`-as-documentation
  // footnote as doctor-round above.
  'lab-result': {
    role: 'composed', basedOn: 'lab-value',
    compositionFormId: 'eb0e66f3-f8d2-4bd2-8924-87b281de83a9', // "Diagnostik & Labor" (same Composition, different block - independent sessions, no conflict)
    blockId: 'block-lab',
    formSectionFormId: '3d3adbcd-c3b5-4eae-a496-d0e9ab3fd609', // "Laborbericht mit Probe (Panel)"
    forceNewComposition: true,
  },
  // The critic system's own two fixes (see critic/rules.ts's doc comment) -
  // both live-verified end to end (create_form_session -> attach_composition_block
  // -> submit) before being wired in here.
  // Reverted back to "Prozedur (Basis)" (was briefly "Kleine Prozedur" -
  // simpler, no bug, but plain-text only) once the user explicitly asked for
  // OPS-coded procedures: "Prozedur (Basis)"'s own `procedure_name` field
  // has a real OPS codeMappings terminology - exactly what's needed - and
  // the required-field bug found earlier (bare-`id` vs qualified-`name`
  // mismatch, same class as "Entlassungsbrief"'s own bug) is now worked
  // around the same way (both keys supplied), not avoided by form choice.
  procedure: {
    role: 'basis',
    compositionFormId: '573656a0-e52d-4564-a559-47ec8d3cbbf3', // "Prozedur (Basis) – Einzelformular"
    blockId: 'block-1',
    formSectionFormId: '1d7db2e8-f483-431f-94aa-d9d49115bfd8', // "Prozedur (Basis)" (archived version, still the one wired into this composition's own block)
    forceNewComposition: true,
  },
  'diagnostic-report': {
    role: 'composed',
    compositionFormId: 'eb0e66f3-f8d2-4bd2-8924-87b281de83a9', // "Diagnostik & Labor" (same Composition as doctor-round/lab-result, its own third block)
    blockId: 'block-imaging',
    formSectionFormId: 'b99eeb54-ec79-4713-8725-2c936ee0e9c7', // "Diagnostik-Befund"
    forceNewComposition: true,
  },
  // Closes the standing critic's own "missing-discharge-letter" gap for
  // real - "Entlassung" is a real, published, general-purpose (not
  // oncology-specific) Composition already wrapping "Entlassungsbrief -
  // Verlauf & Procedere" at this exact block.
  'discharge-letter': {
    role: 'composed',
    compositionFormId: '2a88d34b-541d-4085-ab7a-23c713346928', // "Entlassung"
    blockId: 'summary-form',
    formSectionFormId: '42d74b75-e2fe-4238-a0a0-1f7c556938a5', // "Entlassungsbrief – Verlauf & Procedere"
    forceNewComposition: true,
  },
  // User's follow-up ask included real, structured ICD-10-coded diagnoses.
  // "Kodierte Diagnose" (the anamnesis capability's own Form Section)
  // turned out to have NO codeMappings at all despite its name. "Diagnose &
  // Problem" IS a real ICD-10-GM-coded archetype - published a standalone
  // Composition wrapper for it (`802dbbec-30c8-4806-9694-a51df6cfada0`,
  // mirroring "Prozedur (Basis) – Einzelformular"'s exact structure) and
  // live-tested it. Found a SECOND, more serious real Form Builder bug,
  // this one NOT working-around-able: its 4 coded-select fields
  // (diagnostic_status/active_inactive/diagnostic_certainty/
  // diagnostic_category) silently ignore whatever value is actually
  // submitted (tried both the option's own `value` code AND its literal
  // English archetype term - EHRbase's own error kept reporting the SAME
  // wrong value back, the German display TEXT, regardless of what was
  // sent) - confirmed live, twice, with different inputs producing an
  // identical wrong result. Unlike "Prozedur (Basis)"'s bug (a workable
  // dual-key fix), this one can't be fixed from the outside - the write
  // path itself never reaches the value this workbench actually sends.
  // Abandoned rather than shipped half-working; the composition wrapper is
  // left published (no delete capability exists) but NOT wired into any
  // capability here.
  //
  // "Diagnose (Basis)" turned out to be the working alternative: its own
  // select options DO carry correct rmValue mappings (live-verified: Status/
  // Diagnosestatus/Diagnosesicherheit/Schweregrad all read back exactly what
  // was submitted, unlike "Diagnose & Problem"'s bug above). A standalone
  // Composition wrapper ("Diagnose (Basis) – Einzelformular",
  // eda16486-e4c3-4d84-859e-87e7f6c505cf) already existed from the original
  // day-1 batch of "X (Basis) – Einzelformular" wrappers but had never been
  // wired into a capability or live-tested. Its required "Kategorie-Code
  // (HIP)" field turned out not to need a real backing terminology at all -
  // same as procedure-code/medication-code below, codeMappings.mappings is
  // just a DV_TEXT.mappings TERM_MAPPING the app stores verbatim, never
  // validated against a live CodeSystem - so a real-world category code
  // (borrowing FHIR's own "Condition Category Codes" convention, e.g.
  // "encounter-diagnosis") is enough. Live-verified end to end
  // (start_composition_session -> create_form_session -> attach_composition_block
  // -> submit_form_session_to_provider -> AQL read-back): a real DV_CODED_TEXT
  // defining_code (ICD-10-GM I26.9) and a real DV_TEXT.mappings TERM_MAPPING
  // both stored and read back byte-for-byte, closing the standing
  // "missing-coded-diagnosis" critic finding (see critic/rules.ts) for real.
  // The wrapper's one block still points at an ARCHIVED "Diagnose (Basis)"
  // version (2e06e44e-1b9a-40c4-bc5b-d7efc139abe1, v1.10.0, not the current
  // published v1.19.0) - same "archiving only affects new composition
  // designs, not an existing binding" situation as "procedure" below, and
  // confirmed to still submit correctly at runtime.
  'coded-diagnosis': {
    role: 'basis',
    compositionFormId: 'eda16486-e4c3-4d84-859e-87e7f6c505cf', // "Diagnose (Basis) – Einzelformular"
    blockId: 'block-1',
    formSectionFormId: '2e06e44e-1b9a-40c4-bc5b-d7efc139abe1', // "Diagnose (Basis)" (archived version, still the one wired into this composition's own block)
    forceNewComposition: true,
  },
  // Real medication ORDER - "Medikation (Basis)" has a genuine
  // medication-code codeMappings terminology too. Same required-field bug
  // class as Procedure/Entlassungsbrief (bare `id` vs qualified `name`) -
  // worked around the same way in engine.ts.
  'medication-order': {
    role: 'basis',
    compositionFormId: '6e2c3a61-df64-4771-8507-0ee30cddd055', // "Medikation (Basis) – Einzelformular"
    blockId: 'block-1',
    formSectionFormId: '226ee58f-0d8e-4309-b744-4098580f469f', // "Medikation (Basis)" (archived, still the one wired into this composition's own block)
    forceNewComposition: true,
  },
  // Real medication ADMINISTRATION (eMAR) - a genuinely different clinical
  // fact from the order above (what was actually given, when, by whom).
  'medication-administration': {
    role: 'composed', basedOn: 'medication-order',
    compositionFormId: '5bc67710-d0e3-4301-ba43-cc93a8f29bec', // "Medikamentengabe (eMAR-Eintrag) – Einzelformular"
    blockId: 'block-1',
    formSectionFormId: '2c2724c9-59a4-4b44-908a-556f4a771de4', // "Medikamentengabe (eMAR-Eintrag)"
    forceNewComposition: true,
  },
  // Closes the critic's "missing-discharge-medication" gap for real -
  // "Entlassmedikation" is ALREADY a second, independent block
  // ("med-form") on the SAME "Entlassung" Composition discharge-letter
  // uses (found live while investigating, not guessed).
  'discharge-medication': {
    role: 'composed', basedOn: 'medication-order',
    compositionFormId: '2a88d34b-541d-4085-ab7a-23c713346928', // "Entlassung" (same Composition as discharge-letter, different block)
    blockId: 'med-form',
    formSectionFormId: 'dddee1ff-3b22-4316-b985-06938694da66', // "Entlassmedikation"
    forceNewComposition: true,
  },
  // User's own architectural ask: wire in the remaining Basis forms, tagged
  // as canonical building blocks (role: 'basis') - "lab-result"/
  // "doctor-round" above stay wired to their own, differently-shaped forms
  // (a DiagnosticReport-style panel; a broader clinical order), annotated
  // `basedOn` these two rather than replaced. Both live-verified end to end
  // (start_composition_session -> create_form_session ->
  // attach_composition_block -> submit_form_session_to_provider -> AQL
  // read-back) the same way as "coded-diagnosis" above. Both forms' own
  // required fields have a bare `id` distinct from their qualified `name`
  // (same class of bug as Procedure/Entlassungsbrief) - values are supplied
  // under both keys in engine.ts, the same established workaround.
  'lab-value': {
    role: 'basis',
    compositionFormId: '8338ddde-26d9-49fd-8edf-095d12415edc', // "Laborwert (Basis) – Einzelformular"
    blockId: 'block-1',
    formSectionFormId: '7c1210b2-39a4-4b4a-a479-62c1925fe38f', // "Laborwert (Basis)" (archived version, still the one wired into this composition's own block)
    forceNewComposition: true,
  },
  'order-basis': {
    role: 'basis',
    compositionFormId: 'a78f1088-44cb-4d98-87b8-8fd4c18974fd', // "Anordnung (Basis) – Einzelformular"
    blockId: 'block-1',
    formSectionFormId: 'ee3e789e-5863-4008-9260-aa0b8f39a8d4', // "Anordnung (Basis)" (archived version, still the one wired into this composition's own block)
    forceNewComposition: true,
  },
};

/** Thrown by `requireOpenEhrCapabilityConfig` when neither the dynamic
 * registry nor the static catalog has a binding for `capability` - a
 * distinct, exported class (not a plain Error) so a caller can branch on it
 * specifically, e.g. to file a `request_missing_form` task (see
 * mcp/tools/capabilityTools.ts) instead of just logging a failure. */
export class CapabilityUnresolved extends Error {
  constructor(readonly capability: string) {
    super(`No known openEHR Form Builder wiring for capability "${capability}".`);
    this.name = 'CapabilityUnresolved';
  }
}

/** Checks the dynamic registry (when given) first, then the static catalog -
 * never throws, returns undefined when neither has a binding. The
 * non-throwing counterpart to `requireOpenEhrCapabilityConfig`, for a
 * caller that wants to handle "not found" itself (e.g. `resolve_capability`
 * MCP tool) rather than catching `CapabilityUnresolved`. */
export function resolveCapability(capability: string, dynamic?: DynamicCapabilityRegistry): OpenEhrCapabilityConfig | undefined {
  return dynamic?.get(capability) ?? OPENEHR_CAPABILITIES[capability];
}

export function requireOpenEhrCapabilityConfig(capability: string, dynamic?: DynamicCapabilityRegistry): OpenEhrCapabilityConfig {
  const config = resolveCapability(capability, dynamic);
  if (!config) throw new CapabilityUnresolved(capability);
  return config;
}

/** Every known capability, static + dynamic - backs the `list_capabilities`
 * MCP tool. A dynamic entry with the same name as a static one shadows it
 * (matches `resolveCapability`'s own precedence), never lists both. */
export function listAllCapabilities(dynamic?: DynamicCapabilityRegistry): Array<{ name: string; config: OpenEhrCapabilityConfig; source: 'dynamic' | 'static' }> {
  const dynamicEntries = dynamic?.list() ?? [];
  const dynamicNames = new Set(dynamicEntries.map((entry) => entry.name));
  const staticEntries = Object.entries(OPENEHR_CAPABILITIES)
    .filter(([name]) => !dynamicNames.has(name))
    .map(([name, config]) => ({ name, config, source: 'static' as const }));
  return [...dynamicEntries.map((entry) => ({ ...entry, source: 'dynamic' as const })), ...staticEntries];
}
