# DV_TEXT terminology code mappings

A DV_TEXT-bound text field can now optionally carry one or more terminology
code mappings alongside its free text (openEHR RM: `DV_TEXT.mappings`, a
`List<TERM_MAPPING>`) - e.g. a free-text diagnosis description additionally
tagged with an ICD-10-GM code, without changing the text itself. Off by
default; a designer opts a specific field into it deliberately, same
pattern as `manualAdd` on Composition blocks - every existing DV_TEXT field
keeps behaving exactly as before.

Distinct from `DV_CODED_TEXT.defining_code` (where the value itself *is* a
coded term, rendered today as a closed dropdown from the WebTemplate's own
value set) - this is a free-text value with independent, optional code
attachment(s). Open, non-enumerated `defining_code` entry for
DV_CODED_TEXT/CODE_PHRASE fields (an "offener Code" toggle replacing the
closed dropdown) was scoped as a related but separate gap and is not part
of what shipped here.

## Data model (`packages/core`)

```ts
interface CodeMappingTerminologyOption {
  id: string;      // written verbatim as CODE_PHRASE.terminology_id
  label: string;    // designer-facing label shown at runtime - the "hidden catalog"
  match?: '>' | '=' | '<' | '?';  // TERM_MAPPING.match, defaults to '='
}
interface CodeMappingConfig {
  enabled: boolean;
  terminologies: CodeMappingTerminologyOption[];
  allowMultiple?: boolean;  // defaults to true - the "+" control
}
```

`FormElementLayout.codeMappings` carries this design-time config.
`RuntimeFieldDescriptor.codeMappings` mirrors it once `enabled` (see
`toDescriptor` in `form-runtime/index.ts`).

**Runtime value shape** once `codeMappings.enabled`: instead of a plain
string, the field's value becomes `CodeMappedTextValue`:

```ts
{ value: string, mappings?: Array<{ terminologyId: string; code: string; match?: string }> }
```

A field with no mapping entered yet stores `{ value }` (mappings omitted
entirely, never an empty array) - see `unwrapCodeMappedValue` in
`form-runtime/index.ts`, which unwraps this shape before running the
field's normal required/pattern validation against the text alone (a
mapping never satisfies `required` on the text's behalf).

## Terminology is always designer-configured, never typed by the clinician

"Katalog hidden": the clinician only ever sees the short, curated
`terminologies` list (or nothing to choose at all if there's exactly one) -
never a raw `terminology_id` string to type from scratch, and never a
browsable code catalog embedded in the form. Phase 1 (this shipped state)
is manual code entry only - no lookup/autocomplete service. A terminology
lookup plugin (mirroring `formbuilder-plugin-postal-lookup`'s pattern) is a
deliberately deferred follow-up, not part of this change.

## Write paths - two, both updated

This app has two parallel openEHR serialization paths, and both needed
updating for correctness:

1. **`packages/openehr-engine/src/canonicalComposition.ts`** (nested RM
   JSON, used by the Contribution/atomic-commit flow) - `buildLeafDvValue`'s
   `DV_TEXT` branch. This is the higher-confidence of the two: its exact
   output shape was built directly against a real production Composition
   example (`vg_Diagnosis.v1.1.0`'s "Problem/Diagnosis name" field), not
   inferred from documentation alone:
   ```json
   { "_type": "DV_TEXT", "value": "...", "mappings": [
     { "_type": "TERM_MAPPING", "match": "=", "target": {
       "_type": "CODE_PHRASE",
       "terminology_id": { "_type": "TERMINOLOGY_ID", "value": "http://fhir.de/CodeSystem/dimdi/icd-10-gm" },
       "code_string": "F16.0"
     } }
   ] }
   ```
2. **`packages/openehr-engine/src/index.ts`** (FLAT format, used by the
   single-form provider-commit path) - `setFlatValue` writes an
   underscore-prefixed `_mappings/N` key group alongside the bare value key
   (EHRbase's documented convention for a LOCATABLE's non-value structural
   attributes); `fromOpenEhrFlatComposition`/`readCodeMappings` reads it
   back. **This convention is not verified against a live EHRbase
   instance** - unlike the canonical path above, this app had no prior FLAT
   `mappings` usage to confirm the exact key shape against. Treat it as
   best-effort until confirmed against a real EHRbase FLAT round trip; the
   canonical/Contribution path is the one to trust first.

Both are additive and backward compatible: a `codeMappings`-disabled DV_TEXT
field takes neither branch, unchanged from before this feature existed.

## Design-time UX

`apps/web/src/pages/FormBuilder.tsx`'s field properties panel, only offered
for a field whose binding is `DV_TEXT` (never for an already-coded
DV_CODED_TEXT select): a "Code-Zuordnung(en) aktivieren" toggle, then a
"Mehrere Zuordnungen gleichzeitig erlauben" toggle, then a repeatable list
of terminology rows (id / label / match), add/remove per row.
`apps/web/src/adapters/formBuilderAdapter.ts` carries `codeMappings`
through `custom_metadata` in both directions (canvas item ⇄
`FormElementLayout`), the same mechanism `unitOptions`/`options` already use.

## Runtime UX

`apps/web/src/components/FormRuntime.tsx`'s `fieldInput` - the plain text
input renders unchanged; below it, one row per existing mapping (a
terminology picker only appears when more than one terminology is
configured; otherwise just the configured label as static text) plus a
manual code input and a remove control. A "+ Code hinzufügen" button
appears below the rows whenever `allowMultiple !== false` or no mapping
exists yet, and disappears once `allowMultiple: false` already has its one
mapping. Picking a different terminology on an existing row re-derives
`match` from that terminology's own configured value - a clinician never
edits `match` directly.

## Tests

- `packages/core/tests/*` (validation unwrap, `formatRuntimeValue`) -
  covered inline in `form-runtime/index.ts`'s existing test coverage.
- `packages/openehr-engine/tests/canonical-composition.test.js` - 4 tests
  against the real production example shape (single mapping, explicit
  non-default `match`, multiple mappings in order, no-mapping-yet stays
  plain `DV_TEXT`).
- `packages/openehr-engine/tests/code-mappings-flat.test.js` - 7 tests
  covering the FLAT write/read round trip, including a malformed/partial
  `_mappings` group being dropped rather than fabricated.
- `apps/web/src/components/FormRuntime.codeMappings.test.tsx` - 6 component
  tests (no visible catalog before a mapping is added, add/remove,
  `allowMultiple: false` capping, multi-terminology picker, disabled field
  unaffected).

## Deliberately out of scope (Phase 1)

- No terminology lookup/autocomplete service - manual code entry only.
- No validation of the code's format/existence against the configured
  terminology - any non-empty string is accepted.
- `DV_TEXT.language`/`.encoding`/`.hyperlink` (deprecated) remain
  unimplemented - out of scope for this change.
