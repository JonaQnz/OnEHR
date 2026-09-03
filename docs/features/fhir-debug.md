# FHIR Debug

Lets a designer check, per Form Section, whether HIP's server-side openEHR
→ FHIR conversion actually produced the expected FHIR resource - without
Postman/Bruno, directly in the Form Builder. This **verifies**, it never
**writes**: HIP itself converts a committed Composition into FHIR
server-side (see `fhirCdrService.ts`'s own doc comment on the
Patient/Encounter-vs-clinical-templates split), so Forms' job here is only
to search for and display what landed.

## Why this shape

The low-level infrastructure already existed in full before this feature:
`fhirCdrService.ts` (generic FHIR create/get/search against the CDR),
`integrationCallLogService.ts` + `ehrbaseAdminRoutes.ts`'s `/call-logs`
family (full request/response history, already filterable by `ehrId`/
`patientId`/`resourceType`), and an existing debug-tab UI precedent in
`apps/web/src/pages/patients/PatientDetail.tsx`. This feature wires that
into the Form Builder rather than rebuilding it.

## Pieces

### `Patient.fhirPatientId` (`apps/api/prisma/schema.prisma`)

Set only when a patient was created through the FHIR CDR connector (a
`hip-keycloak` connection - see `patientService.createPatient()`'s `'fhir'`
mode). `ehrbaseConnectionPlugins.ts`'s `createFhirPatient()` already reads
the created FHIR `Patient`'s `identifier` entry with `system:
'ehrbase://love.is.in.the.ehr'` to get the authoritative linked `ehrId`
(confirmed live against the sandbox connector, predates this feature) -
this only adds persistence for the `fhirPatientId` half, previously
discarded after the call returned.

Not stored as openEHR clinical data on the Person template: `vg_Person
.v1.1.1`'s only `DV_IDENTIFIER` fields are insurance number and
organisation identifiers (checked while building this), none a free
person-level identifier slot - so it lives here as Forms-internal
metadata alongside `ehrId`, which was already a `Patient` column.

### `FORM_FHIR_MAPPING_EXTENSION_KEY` (`packages/core/src/fhir-mapping`)

`'formbuilder.fhir-mapping'` on a form's `extensions` - `{ resourceType:
string; searchParams?: Record<string, string> }`. Set via the FHIR Debug
tab's "FHIR-Ressourcenzuordnung" field (a plain text input, not a fixed
enum - HIP's actual resource-type vocabulary isn't hardcoded anywhere in
this app), saved through the same generic `PUT /forms/:id` every other
FormBuilder tab already uses (`LiveJsonEditor`'s save call is the same
shape).

### `fhirVerificationService.ts` (`apps/api/src/services/`)

`verifyFhirForSubmission(formId, ehrId, options)` → one of:
- `{ status: 'unmapped' }` - no `FORM_FHIR_MAPPING_EXTENSION_KEY` set (the
  default for a form that hasn't opted in yet).
- `{ status: 'no-fhir-patient' }` - the form is mapped, but this patient
  has no `fhirPatientId` on file (only patients created through the FHIR
  CDR connector have one).
- `{ status: 'ok', resourceType, bundle, composition? }` - a real FHIR
  search (`GET /{resourceType}?patient=<fhirPatientId>&_sort=-_lastUpdated
  &_count=5&...searchParams`, via `fhirCdrService.searchFhirResource()`)
  plus, best-effort, the same latest-Flat-Composition context
  `buildSessionRuntimeContext()` already loads for `context.composition`
  (`EhrbaseDataProvider.loadLatestCompositionContext()`) - so a designer
  can eyeball the openEHR side and the FHIR side together. A composition-
  context failure never hides an otherwise-successful FHIR result.

`searchFhirResource()` itself gained an optional `context` parameter
(`ehrId`/`patientId`/`formId`/`sessionId`/`operation`) so this specific
caller's searches get logged via `logIntegrationCall()` the same way
`createFhirResource()`'s writes already were - every other existing
caller (the raw admin `/fhir-cdr/:resourceType` route) omits it and stays
unlogged, unchanged.

Two callers:
- **Manual** - `POST /api/forms/:id/fhir-verify` (`formRoutes.ts`, same
  `form.design` permission gate as the rest of that router), the FHIR
  Debug tab's "Jetzt prüfen" button. Callable any time, including against
  a draft, for on-demand debugging.
- **Automatic** - `formSessionService.ts`'s `submitFormSessionToProvider`,
  fire-and-forget right after the existing `afterSubmit` hook point (same
  spot as the pre-existing `markPatientHasPersonArchetype` call). Never
  awaited before returning the submit result, never allowed to fail the
  submit itself.

Deliberately **not** wired to draft autosave, despite the literal request
covering "submit or save as draft": `LiveForm.tsx`'s `saveDraftNow()` is
the identical code path for the manual "Entwurf speichern" button and the
debounced autosave timer (default 2.5s of inactivity, and
`pushDraftsToProviderByDefault: true` means most forms already round-trip
every draft to the provider) - not distinguishable server-side, and a FHIR
verify call on every autosave tick would be noise against a real external
CDR. The manual "Jetzt prüfen" button covers the "I just saved a draft and
want to check" case instead.

### `IntegrationCallLog.formId` / `.sessionId`

Added so a FHIR Debug verification call is traceable back to the form/
session that triggered it - every other call site (patient creation, a
normal Composition commit, the raw admin explorer) leaves both unset, same
as `ehrId`/`patientId` already do for calls that aren't about a specific
patient. `GET /admin/ehrbase/call-logs` gained a `formId` filter; the FHIR
Debug tab's "Letzte FHIR-Prüfungen" history section uses it (admin-gated,
`system.configure`, same as the rest of that router - unlike the verify
action itself, which only needs `form.design`).

## Deliberately out of scope (for now)

- Forms never authors/writes a FHIR resource itself - see "Why this
  shape" above.
- No enum/autocomplete for `resourceType` - HIP's actual per-Form-Section
  FHIR mappings come from the HIP FHIR mapping docs (the same source used
  to build the Form Sections in the first place, see
  `docs/concepts/fhir-mapping-form-rework-method` in memory), set by a
  designer per form via the tab, not guessed or hardcoded here.
- `searchParams` beyond `patient=` is API-/extension-level only for now -
  no dedicated UI to edit it yet (edit `formbuilder.fhir-mapping` directly
  via the Live JSON tab if a form needs one).

## Tests

- `packages/core/tests/fhir-mapping.test.js` - `getFormFhirMapping()`'s
  parsing/trimming/filtering.
- `apps/api/tests/fhir-verification-service.test.js` - all three result
  statuses, search-parameter/context construction, and that a failed
  best-effort composition-context lookup never hides a successful result.
- Live-tested against the real HIP sandbox FHIR CDR: created a real
  FHIR-CDR-backed test patient (confirmed `fhirPatientId` persisted),
  mapped a real form to `Observation` via the FHIR Debug tab, ran "Jetzt
  prüfen" - real Bundle response rendered, call log appeared in the tab's
  history filtered by `formId`, `IntegrationCallLog.form_id`/`ehr_id`
  confirmed correct in the database directly.
