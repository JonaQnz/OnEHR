# petra-hoffmann-copd-3

**Category:** bug

## What I was trying to do

After the Laborbefund required-field bug (`petra-hoffmann-copd-1.md`) was
fixed and Laborbefund republished as a new form id/version
(`d65aa1dc-284f-4c6e-bd03-9f09a82f28ab`, v1.2.0, same parentId
`e878cc75-9820-45ad-9492-1359af4b6b99` as the old v1.1.0), I tried to
formally complete the **Entlassung** Composition's "Laborergebnisse" page
(`block-lab`) for Petra Hoffmann (patient
`3681f033-cded-42de-9d0e-ffae9bf01641`) using the proper composition
workflow: `start_composition_session` → `attach_composition_block` with a
Laborbefund child session.

## What happened

1. `get_form` on the **Entlassung** composition form
   (`ba084766-2567-458a-9202-de3bd5310f5d`, v1.1.0) shows `block-lab` still
   declares `formId: "e878cc75-9820-45ad-9492-1359af4b6b99"` - the **old,
   now-archived** v1.1.0 of Laborbefund. Publishing the v1.2.0 fix did not
   update the composition's block reference to the new form id.
2. `start_composition_session` (`compositionFormId: "ba084766-..."`, mode
   `edit`) → session `3b0f78c8-fee9-4874-bd41-6da20415aaf0`, whose
   `children` array confirms `block-lab` still points at the archived
   `e878cc75-...`.
3. Tried `attach_composition_block` with a session already built and
   successfully submitted against the *new* form
   (`d65aa1dc-...`, session `2d64753e-8755-46c3-8939-2a98aa2dfbe8`):
   ```
   Forms API error (HTTP 422): Child form session does not match this composition context
   {"error": "Child form session does not match this composition context"}
   ```
   Rejected because the child session's formId doesn't match the block's
   declared (stale, archived) formId.
4. Tried the other direction: launch a fresh session directly against the
   block's declared formId `e878cc75-9820-45ad-9492-1359af4b6b99` to satisfy
   the match:
   ```
   Forms API error (HTTP 409): Only published forms can be launched through the integration API
   {"error": "Only published forms can be launched through the integration API"}
   ```
   Rejected because that form version is archived (superseded by
   `d65aa1dc-...`) and can no longer be launched at all.

So `block-lab` of the **Entlassung** composition is caught between two
errors: it demands a session bound to the archived old formId, but sessions
can no longer be created against that archived formId, and a session bound
to the new (current, published, bug-fixed) formId is rejected as "does not
match this composition context". There is no way to formally attach a
Laborbefund submission to this composition block through the composition
workflow right now.

## What I expected

Publishing a new version of a form that's referenced as a composition block
should either (a) automatically update live/published compositions'
`block-*.formId` references to the new version, or (b) let
`attach_composition_block` accept a child session bound to any current
published version sharing the block form's `parentId`, rather than requiring
an exact formId match against a specific (and possibly now-archived)
version. As it stands, republishing a block's underlying form silently
breaks that composition page going forward.

## Impact on this case

I could not formally wire any Laborbefund submission into the **Entlassung**
composition's `block-lab` page via `attach_composition_block` /
`validate_composition_session`. The underlying clinical lab data itself
*is* recorded in EHRbase as real, standalone `vg_ObservationLab.v1.2.0`
Compositions (submitted directly via `launch_form`/`submit_form_session_to_provider`
against the current `d65aa1dc-...` form, same patient/ehrId) - so the data
exists and is queryable - but the **Entlassung** composition object itself
cannot represent that page as filled/complete through the formal composition
session workflow. Whoever owns the Entlassung composition definition needs
to repoint `block-lab` at `d65aa1dc-284f-4c6e-bd03-9f09a82f28ab` (or the
platform needs to fix the version-matching behavior described above).
