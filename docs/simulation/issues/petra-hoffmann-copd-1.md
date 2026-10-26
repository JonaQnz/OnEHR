# petra-hoffmann-copd-1

**Category:** bug

## What I was trying to do

Record Petra Hoffmann's admission lab panel (2026-08-24, 15:00) using the
published **Laborbefund** form (`e878cc75-9820-45ad-9492-1359af4b6b99`,
v1.1.0, bound to template `vg_ObservationLab.v1.2.0`). This is the same form
used as the "Laborergebnisse" block in both the **Diagnostik & Labor** and
**Entlassung** compositions, so the bug blocks those compositions' lab pages
too.

**Update:** this turned out to be a general bug, not specific to
Laborbefund - see "Second reproduction" below. It also hits
**Entlassungsbrief-Zusammenfassung** (`086e2fae-19e8-4560-8d00-36c6c3e72f03`),
the page-4 "Zusammenfassung & Procedere" block of the **Entlassung**
composition, which is arguably the most important single page of the whole
discharge letter.

Steps:
1. `launch_form` with `formId: "e878cc75-9820-45ad-9492-1359af4b6b99"`,
   patient `3681f033-cded-42de-9d0e-ffae9bf01641` (Petra Hoffmann),
   `mode: "create"` → session `c16609f0-fa70-4211-a9b8-76efee2ef2c3`.
2. `patch_form_session` with:
   ```json
   {
     "vg_observationlab.v1.2.0_test_name": "Blutbild",
     "vg_observationlab.v1.2.0_analyte_name": "Leukozyten",
     "vg_observationlab.v1.2.0_quantity_value": {"magnitude": 13.8, "unit": "G/L"},
     "vg_observationlab.v1.2.0_overall_test_status": "at0038",
     "vg_observationlab.v1.2.0_result_status_time": "2026-08-24T15:00:00",
     "vg_observationlab.v1.2.0_textual_reference_range": "4,5-11,0 G/L",
     "vg_observationlab.v1.2.0_comment_2": "Aufnahmelabor 24.08.2026 15:00 Uhr. Erhöht (Leukozytose)."
   }
   ```
   `get_form_session` afterwards confirms the values are stored correctly
   under those keys (revision 1).
3. `validate_form_session` on that session.

## What happened

`validate_form_session` returns `valid: false` with three `required` errors,
even though the referenced fields are populated in `session.values`:

```json
"validation": [
  {"code": "required", "message": "Testname is required.", "path": "test_name"},
  {"code": "required", "message": "Analyt is required.", "path": "analyte_name"},
  {"code": "required", "message": "Messwert is required.", "path": "quantity_value"}
]
```

The validator's error `path`s are the fields' short `id`s (`test_name`,
`analyte_name`, `quantity_value` - taken from the form's `canonical_json.layout`
node `id` attributes), but the session's actual value keys are the fields'
`name`s (`vg_observationlab.v1.2.0_test_name`,
`vg_observationlab.v1.2.0_analyte_name`, `vg_observationlab.v1.2.0_quantity_value`
- taken from the `name` attributes and matching `bindings` keys). The
required-check is evidently reading `values[field.id]` instead of
`values[field.name]`, so it never finds the value that was actually saved.

This isn't just a client-side validation false-positive: I proceeded to call
`submit_form_session_to_provider` anyway (id
`c16609f0-fa70-4211-a9b8-76efee2ef2c3`, `validatedRevision: 2`), and the
backend hard-rejects it with the same three errors:

```
Forms API error (HTTP 422): 3 Formular-Validierungsfehler verhindern das Absenden
{
  "error": "3 Formular-Validierungsfehler verhindern das Absenden",
  "messages": [
    {"severity": "error", "code": "required", "path": "test_name", "message": "Testname is required."},
    {"severity": "error", "code": "required", "path": "analyte_name", "message": "Analyt is required."},
    {"severity": "error", "code": "required", "path": "quantity_value", "message": "Messwert is required."}
  ]
}
```

So the Laborbefund form is **completely unsubmittable** in its current
published state, no matter what values are entered - both `validate_form_session`
and `submit_form_session_to_provider` reject it identically.

For comparison, sibling forms with the same id-vs-name field pattern
(`Diagnostik-Befund`'s `study_name`/`diagnostik-befund_study_name`, etc.) sit
inside a `repeatable` container (`any_event`/`entry`), and validated fine
elsewhere in this session - only Laborbefund's fields are direct/flat
children (not wrapped in a repeatable group), which may be why this
particular form hits the bug and the others don't.

## Second reproduction: Entlassungsbrief-Zusammenfassung (not Laborbefund-specific)

To characterize the bug I tried the same pattern-match against the
**Entlassungsbrief-Zusammenfassung** form
(`086e2fae-19e8-4560-8d00-36c6c3e72f03`, v1.1.0, template
`vg_entlassungsbrief.0.1.0`) - the "Zusammenfassung & Procedere" page of the
**Entlassung** composition. Its fields (`synopsis`/`entlassungsbrief_synopsis`,
`recommendation`/`entlassungsbrief_recommendation`, etc.) have the exact same
short-`id`-vs-prefixed-`name` split as Laborbefund, and are likewise **not**
nested inside a `repeatable` container (two flat `EVALUATION` containers,
`clinical_synopsis` and `recommendation`, each with plain non-repeating
fields).

Session `e559b175-a2d7-4180-b4ac-2149861327e5`, `patch_form_session` with
`entlassungsbrief_synopsis` and `entlassungsbrief_recommendation` both
populated (confirmed present in `session.values` via the same
`patch_form_session`/`get_form_session` responses), then:
- `validate_form_session` → `valid: false`, `required` errors on paths
  `synopsis` and `recommendation` (the short `id`s, not the `name`s that
  actually hold the data).
- `submit_form_session_to_provider` (`validatedRevision: 2`) → same HTTP 422
  hard-reject:
  ```
  Forms API error (HTTP 422): 2 Formular-Validierungsfehler verhindern das Absenden
  {"error": "2 Formular-Validierungsfehler verhindern das Absenden", "messages": [
    {"severity": "error", "code": "required", "path": "synopsis", "message": "Zusammenfassung is required."},
    {"severity": "error", "code": "required", "path": "recommendation", "message": "Empfehlung is required."}
  ]}
  ```

This confirms the bug is general: **any top-level (non-repeatable-group)
field whose layout `id` differs from its `name`/binding key fails required
validation and is unsubmittable**, regardless of which form/template it's
on. Fields nested inside a `repeatable: true` container (Pflegebericht,
Verlaufsnotiz, Diagnostik-Befund) are unaffected; flat/singleton fields with
an `id` distinct from `name` (Laborbefund, Entlassungsbrief-Zusammenfassung)
are all broken this way.

## What I expected

`validate_form_session`/`submit_form_session_to_provider`'s required-field
check should read the value by the field's `name` (the actual key used in
`session.values` and in `bindings`), not by its `id`, so that a fully filled
Laborbefund entry validates and submits successfully.

## Impact on this case

Blocked entirely for Petra Hoffmann:
- Standalone **Laborbefund** entries for all three lab timepoints (Aufnahmelabor
  24.08 15:00, Kontrolllabor 25.08 06:30, Abschlusslabor 27.08 08:00).
- The "Laborbefund" page of the **Diagnostik & Labor** composition
  (block `block-lab`, formId `e878cc75-9820-45ad-9492-1359af4b6b99`).
- The "Laborergebnisse" page of the **Entlassung** composition (block
  `block-lab`, same formId).
- The "Zusammenfassung & Procedere" page of the **Entlassung** composition
  (block `block-summary`, formId `086e2fae-19e8-4560-8d00-36c6c3e72f03`) -
  meaning the discharge letter's clinical synopsis and physician
  recommendations/procedere could not be submitted either.

I completed the rest of the case (Anamnese, both Verlaufsnotizen, Pflege &
Verlauf composition, the imaging half of Diagnostik & Labor, and the
diagnosis/medication pages of Entlassung) without the lab data and without
the discharge summary/procedere text, and left the orphaned draft form
sessions `c16609f0-fa70-4211-a9b8-76efee2ef2c3` (Laborbefund) and
`e559b175-a2d7-4180-b4ac-2149861327e5` (Entlassungsbrief-Zusammenfassung) in
place (both still `in_progress`, never successfully submitted) as
reproduction cases.

Separately, even once this is fixed, note that the Laborbefund form's fields
are **not** wrapped in a repeatable group the way `Diagnostik-Befund`,
`Pflegebericht`, and `Verlaufsnotiz` are - so it can only ever capture one
analyte per submission/composition. Recording the ~22 parameters in Petra
Hoffmann's admission panel alone would need 22 separate compositions unless
that's addressed too. Filing that as a separate consideration for whoever
looks at this - it may be intentional (one analyte = one Observation event
is arguably correct openEHR modelling), but it's worth a deliberate call
either way now that the bug above is fixed and the form is usable again.
