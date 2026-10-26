# petra-hoffmann-copd-2

**Category:** bug

## What I was trying to do

Continuing Petra Hoffmann's case after the required-field validation bug
(`petra-hoffmann-copd-1.md`) was fixed and the **Laborbefund** form was
republished as v1.2.0 (`d65aa1dc-284f-4c6e-bd03-9f09a82f28ab`) with an
expanded unit list. I was recording the remaining lab timepoints from the
case brief (Kontrolllabor 2026-08-25 06:30, Abschlusslabor 2026-08-27 08:00),
which include CRP (mg/L) and arterial blood gases pO2/pCO2 (mmHg).

## What happened

`d65aa1dc-284f-4c6e-bd03-9f09a82f28ab`'s `quantity_value` field
(`unitOptions`) now lists: `g/dL`, `mg/dL`, `mmol/L`, `µmol/L`, `µg/L`,
`U/L`, `G/L`, `T/L`, `%`. It is still missing **`mmHg`** (needed for pO2/pCO2
blood gas values) and **`mg/L`** (needed for CRP, which is reported in mg/L,
not mg/dL - those are not interchangeable, off by a factor of 10).

Reproduction in session `2d64753e-8755-46c3-8939-2a98aa2dfbe8` (patient
`3681f033-cded-42de-9d0e-ffae9bf01641`):

1. `patch_form_session` with
   `vg_observationlab.v1.2.0_quantity_value: {"magnitude": 72, "unit": "mmHg"}`
   (pO2, Kontrolllabor) → `validate_form_session` returns:
   ```json
   {"valid": false, "issues": [{"path": "quantity_value", "code": "unit", "message": "Messwert has an unsupported unit."}]}
   ```
2. Same session, re-patched with
   `vg_observationlab.v1.2.0_quantity_value: {"magnitude": 72, "unit": "mg/L"}`
   (CRP, Kontrolllabor) → same `unit`/"unsupported unit" validation error.

So the backend's unit whitelist for `quantity_value` rejects both `mmHg` and
`mg/L`, even though every other field on the same submission (test_name,
analyte_name, result_status_time, textual_reference_range, comment) was
accepted fine.

## What I expected

The Laborbefund form's `quantity_value` unit list should cover the units
actually used by the case's lab panel - specifically `mmHg` (arterial blood
gases: pO2, pCO2) and `mg/L` (CRP is conventionally reported in mg/L in this
lab panel, distinct from mg/dL). Without these, CRP and blood-gas trend data
cannot be recorded through this form at all.

## Impact on this case

I did not submit CRP or blood-gas (pO2/pCO2) values for the Kontrolllabor
(2026-08-25 06:30) or Abschlusslabor (2026-08-27 08:00) timepoints, since
entering them under a different unit (e.g. mg/dL instead of mg/L) would
silently corrupt the value by 10x. I did submit the analytes that do have
supported units for both timepoints: Leukozyten (G/L), Procalcitonin (µg/L,
Kontrolllabor only - not part of Abschlusslabor per the case brief),
Kreatinin (mg/dL, Abschlusslabor only), and Glukose (mg/dL, both
timepoints). The admission panel's CRP/Procalcitonin/blood-gas values
(2026-08-24 15:00) were also never recorded for the same reason - only
Leukozyten went in at admission.

This is a form/template design gap for whoever owns the Laborbefund
form/template (`vg_ObservationLab.v1.2.0`) - the unit list needs `mmHg` and
`mg/L` added.
