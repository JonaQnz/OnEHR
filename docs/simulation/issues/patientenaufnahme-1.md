Category: bug

## What I was trying to do

Submit the "Patientenaufnahme" form (bound to `vg_Person.v1.1.1`) for a test
patient, with `vg_person.v1.1.1_versicherungstyp` (Versicherungsart) bound
to the template's `Versicherungstyp` field and populated with one of the
form's own generated options (`"GKV"` / `"PKV"`, matching
`get_template_fields`'s `options` for that field).

## What happened

`submit_form_session_to_provider` failed with EHRbase HTTP 422:

```
/content[openEHR-EHR-ADMIN_ENTRY.versicherungsinformationen.v0]/data[at0001]/items[at0002 and name/value='Versicherungstyp']/value:
DV_CODED_TEXT/defining_code/terminology_id does not match.
expected: http://fhir.de/CodeSystem/identifier-type-de-basis; found: local
```

Traced it to `packages/openehr-engine/src/index.ts`, `setFlatValue()`
(the `DV_CODED_TEXT`/`CODE_PHRASE` branch, ~line 78-90):

```ts
const option = binding.options?.find((candidate) => candidate.value === String(code));
const terminology = source?.terminology ?? source?.terminologyId ?? option?.terminology ?? 'local';
```

This *already* reads a per-option `terminology` off `binding.options[]` -
the runtime plumbing to send the right `terminology_id` exists. The gap is
upstream: nothing ever populates `option.terminology`.

- `get_remote_template_detail` on `vg_Person.v1.1.1` shows the real
  WebTemplate carries this info per input:
  `inputs: [{ suffix: "code", type: "CODED_TEXT", list: [...],
  terminology: "http://fhir.de/CodeSystem/identifier-type-de-basis" }]`.
- But `get_template_fields`'s flattened `options` for the same field are
  just `{ value, text }` pairs - the `inputs[].terminology` from the raw
  WebTemplate never survives into `parsed_registry_json` (presumably
  dropped in `apps/api/src/parsers/webTemplateParser.ts`, wherever it
  flattens `inputs[].list` into per-option `{value,text}`).
- `packages/core`'s `OpenEhrBinding` interface
  (`templateAlias, path, rmType, flatPath`) has no `options` field at
  all, so even a correctly-populated registry couldn't be carried into a
  form's `bindings[fieldName].openehr` today - `generateCanonicalForm`
  (`apps/api/src/services/formGenerator.ts`) has nowhere to put it.

Net effect: **any field bound to `DV_CODED_TEXT` under an external
terminology (not the default openEHR "local" one) fails to submit**,
silently succeeding at every step (draft, validate) until the real
EHRbase 422 at submit time. Fields with no external terminology
constraint (e.g. `Namensart`, which only "prefers" but doesn't require
one) are unaffected.

## What I expected

The submission to succeed, the same way it does for `Kontaktart`
(`vg_person.v1.1.1_art`) and other coded fields that happen to use
openEHR's own local terminology.

## Workaround taken for now

Dropped `vg_person.v1.1.1_versicherungstyp` from the published
"Patientenaufnahme" form (v1.3.0) so the rest of the form - which has no
other externally-terminology-constrained fields - submits successfully.
Versicherungsnummer (free text) stayed. This is a real feature loss
(Versicherungsart is a genuinely useful field), not a fix.

## Suggested fix path (not attempted - three-file, cross-package change)

1. `apps/api/src/parsers/webTemplateParser.ts`: when flattening a
   WebTemplate's `inputs[].list` into `parsed_registry_json.fields[].options`,
   also carry `inputs[].terminology` through per option (or per field, if
   it's uniform across a field's options).
2. `packages/core/src/canonical/index.ts`: extend `OpenEhrBinding` with an
   `options?: Array<{ value: string; text: string; terminology?: string }>`
   (or equivalent) so a form's `bindings[fieldName].openehr` can actually
   carry this.
3. `apps/api/src/services/formGenerator.ts` (`generateCanonicalForm`):
   copy the registry's per-option terminology into the generated binding's
   `options`.

`openehr-engine`'s `setFlatValue` needs no change - it already prefers
`option.terminology` over the `'local'` fallback once it's populated.
