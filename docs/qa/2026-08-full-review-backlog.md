# Full-project QA review - backlog

Three parallel review passes across `apps/api`, `apps/web`, and the
shared packages (`packages/core`, `packages/mcp-server`,
`packages/openehr-engine`, the plugin packages), looking for code
quality/correctness risks, duplicated logic, quality-of-life issues, and
test-coverage gaps (especially edge cases). ~35 findings total.

**Fixed so far** (each ✅ item below is done, with its own PR/tests - not
removed from this list so the original finding stays readable as a
record):

- The three most severe, confirmed findings, fixed immediately: a broken
  regex in `openehr-engine` silently dropping every repeat but the first
  when reading back a repeating field, a Composition-block insertion bug
  that could desync a page's block order from its layout order, and a
  shared mutable array reference corrupting sibling rows of a
  repeat-min>1 group (PR #16, `fix/critical-data-loss-bugs`).
- The composition-data cache's own duplicate-row bug found during this
  review (PR #14, `feature/composition-data-local-cache`).
- apps/web #1 (`isFormEmbedEvent` dropping `'dirty'` events) - PR #17,
  `fix/dirty-event-whitelist`.
- apps/api #1 (`authMode` derivation) and #2 (admin self-lockout guard) -
  PR #18, `fix/auth-mode-and-admin-lockout`.
- apps/api #3 (duplicate-patient 500→409), #4 (error handler leaking
  internals), #6 (`form.publish` not enforced) + shared packages #2
  (`NON_FIELD_TYPES` duplication) - PR #19,
  `fix/error-leakage-permission-dedup`.
- apps/api #7 (draft/restore version-bump collision) - PR #21,
  `fix/draft-version-collision`.
- apps/api #5 (`syncPatientsFromEhrbase` sequential N+1, no
  partial-failure recovery) - PR #22, `fix/patient-sync-resilience`
  (bounded concurrency + per-EHR failure isolation).
- apps/api #10 (no HTTP-layer tests at all) - a real `createApp()`
  export (`apps/api/src/app.ts`, split out of `index.ts`) plus
  `apps/api/tests/http/*.test.js` and its `tests/support/httpServer.js`/
  `testAuth.js` helpers now exercise the actual Express request/response
  cycle - `attachAuth`/`requirePermission` genuinely blocking an
  unauthenticated/under-permissioned request, `errorHandler`'s response
  shape (including the never-leak-internals guarantee from #4, now
  provable at the HTTP boundary instead of only at the function level).
  Still only covers `compositionSessionRoutes` so far, not every route
  file - see `docs/testing/README.md`. The infrastructure and pattern are
  the actual fix here; extending it to the remaining routes is ordinary
  follow-up work, not a new gap.
- apps/web #2 (`http://localhost:3001` hardcoded in ~27 files) - PR #23
  introduced the shared `API_BASE_URL`/`API_ORIGIN` module
  (`integration/apiBaseUrl.ts`) and migrated the bulk of the files; two
  were missed (`HipFhirPatientSettings.tsx`, `PatientCreate.tsx`),
  caught during this pass and fixed in PR #53. Verified with a
  Python-based sweep of every `.ts`/`.tsx` file under `apps/web/src` -
  the only remaining `localhost:3001` occurrences are inside
  `apiBaseUrl.ts` itself (the documented fallback default) and its own
  test file.
- apps/web #3 (Dashboard action handlers ignore `res.ok`) - PR #51,
  `fix/dashboard-action-error-handling`.
- apps/web #5 (`LiveJsonEditor` autosaves on every keystroke, no
  debounce/cancellation) - PR #52, `fix/live-json-editor-debounce`
  (500ms debounce + `AbortController` cancelling any still-in-flight
  save).
- **Not from the original review, found live while wiring up CI**:
  apps/web's production build (`tsc -b && vite build` - the exact
  command `Dockerfile.web` runs) was actually broken on `main` - a
  worker chunk's CJS/ESM interop for `formbuilder-plugin-clinical-
  scores`'s default export failed under Rollup (Vite's dev server never
  showed it, since it pre-bundles CJS via esbuild instead). Fixed in PR
  #54.
- **No CI pipeline existed at all** (`.github/workflows/` was absent)
  despite 4 solid local test layers and a green `npm test` - this was
  the single biggest structural gap toward a real "v1.0" (see the
  now-superseded closing paragraph below). Added in PR #55. Getting it
  to genuinely pass from a truly clean checkout (not a long-lived local
  tree with leftover build artifacts) surfaced four more real, previously
  invisible bugs, each fixed in its own PR: apps/web was missing an
  explicit `@testing-library/dom` devDependency (PR #56); the root
  `test` script built `formbuilder-mcp-server` before its own dependency
  `openehr-architect-mcp`, and never built the example plugins
  `apps/api`'s own tests load at runtime (PR #57); `apps/api`'s build
  silently relied on `@prisma/client`'s postinstall script actually
  running to generate its types (PR #58); and `apps/web`'s own
  `vite@8`/`vitest@4` require Node ≥20, crashing outright on the Node 18
  used to mirror the Dockerfiles (PR #59, test job now on Node 22,
  `build-web` job stays on Node 18 to keep mirroring production). CI is
  now verified green on a real clean-checkout GitHub Actions run, not
  just locally.

Everything else below is **not yet fixed**. Triage this list before
picking the next thing to work on; it's roughly ordered by impact within
each area, not a strict global ranking.

## apps/api

1. ✅ **`authMode` derivation bug** (`formSessionRoutes.ts`,
   `compositionSessionRoutes.ts`, `formLaunchRoutes.ts`,
   `scriptConnectorRoutes.ts`) - all four independently compute
   `authMode: req.principal?.authSource === 'oidc' ? 'hip' : 'local'`, but
   `userAuthService.ts` sets `authSource` to `'plugin:hip-keycloak'` for
   real HIP logins, never `'oidc'`. Every HIP-authenticated clinician gets
   `authMode: 'local'` everywhere this flows (n8n workflows, plugins,
   script connectors). Fix as one shared `actorFromRequest(req)` helper,
   not four independent patches.
2. ✅ **No last-admin/self-lockout guard** (`userAdminRoutes.ts`) - an admin
   can deactivate themselves or demote the sole remaining ADMIN via
   `PATCH /users/:id`, with no recovery besides redeploying with
   `FORMS_BOOTSTRAP_ADMIN_*` env vars.
3. ✅ **Duplicate-patient creation returns 500, not 409**
   (`patientService.ts` `createPatient`) - throws a plain `Error`, which
   `errorHandler.ts` maps to 500 for anything that isn't `HttpError`. A
   routine "patient already exists" case looks like a server crash.
4. ✅ **Error handler leaks internal details** (`errorHandler.ts`) - any
   non-`HttpError` (Prisma, axios/EHRbase, ...) returns its raw
   `.message` to the client at 500 with no redaction.
5. ✅ **`syncPatientsFromEhrbase` is a sequential N+1 with no
   partial-failure recovery** (`patientService.ts`) - one blocking
   EHRbase call + one DB upsert per EHR, fully serialized; one flaky EHR
   aborts the whole sync for every concurrent caller awaiting it.
6. ✅ **`'form.publish'` permission defined but never enforced**
   (`authorizationService.ts` + `formRoutes.ts`) - publish/archive/
   delete/restore are all gated by the same generic `'form.design'`
   check; the apparent finer-grained permission model is fictional.
7. ✅ Inconsistent minor-version-bump logic between `create-draft` and
   `restore` in `formRoutes.ts` can produce duplicate version labels
   among sibling drafts.
8. Dead/vestigial ~35-line "plugin validation" comment block in
   `formRoutes.ts`'s `POST /import/full` that does nothing.
9. `'form-session.read-own'`/`'write-own'`/`'composition.read'`/`'write'`
   permissions exist in `ROLE_PERMISSIONS.USER` but are never checked via
   `requirePermission()` - ownership is enforced by direct comparisons
   instead; the permission strings are decorative.
10. ✅ **No HTTP/integration tests exist at all** - all `apps/api/tests/*`
    call service functions directly against a mocked Prisma, never
    through Express/`requirePermission`. Route-level wiring (which
    permission a route requires, status codes, middleware ordering) was
    entirely unverified - this is exactly the class of bug that hid
    finding #1. `apps/api/tests/http/*.test.js` now covers this for
    `compositionSessionRoutes`; extending the pattern to the other route
    files is ordinary follow-up, not a new gap.
11. `userService.ts` (create/update/deactivate/reset-password/role
    changes) has zero dedicated tests.
12. `dataWidgetService.ts`'s `limit` boundary (1-1000, integer-only) is
    validated but untested at either edge.

## apps/web

1. ✅ **`isFormEmbedEvent` omits `'dirty'` from its event whitelist**
   (`integration/formLaunch.ts`) - `packages/core`'s
   `FormEmbedEventName` includes `'dirty'` and `LiveForm.tsx` really does
   publish it, but the guard rejects it before `CompositionRuntime.tsx`
   ever sees it. The entire "Ungespeicherte Änderungen" unsaved-changes
   navigation guard is dead code as a result - a clinician can navigate
   away from a Composition with unsaved child-form edits and lose them
   with no warning. High priority - this is a real, silent data-loss
   path, same class as the three already fixed.
2. ✅ **`http://localhost:3001` hardcoded as an absolute URL in ~26 files**,
   bypassing `vite.config.ts`'s own `/api` dev proxy entirely and
   hardwiring every environment to "browser and API on the same host" -
   breaks any real multi-machine deployment (the production Dockerfile
   serves static `dist/` with no reverse proxy). One env-driven `API`
   constant/module would fix all sites at once; natural to pair with the
   `request<T>()` duplication fix below.
3. ✅ **Dashboard action handlers ignore `res.ok`**
   (`Dashboard.tsx` publish/archive/restore/delete) - a failed action
   just silently refreshes the list as if it succeeded.
4. `CompositionRuntime.tsx` re-creates a Composition session
   (`POST /composition-sessions`) on every keystroke into the manual
   patient-ID/EHR-ID fields once both are non-empty, because each
   `onChange` calls `reset()` first.
5. ✅ `FormBuilder.tsx`'s `LiveJsonEditor` autosaves the raw JSON textarea
   on every keystroke, no debounce, no in-flight-request cancellation -
   fast typing/pasting can let an older PUT overwrite a newer one.
6. `request<T>()` fetch helper reimplemented ~11 times nearly verbatim
   (each with its own hardcoded API URL, see #2); `Dashboard.tsx`/
   `FormBuilder.tsx`/`PatientList.tsx` instead use raw inline `fetch()`
   with yet another, inconsistent error-handling pattern.
7. "First row determines table columns" bug duplicated in
   `PatientDetail.tsx` (`renderClinicalCompositions`) and
   `WidgetDataCard.tsx` (`list` display) - a later row with extra keys
   silently loses those columns in the rendered table.
8. Status-badge color-map + renderer duplicated between `PatientDetail
   .tsx` (`STATUS_COLORS`/`statusBadge`) and `CompositionRuntime.tsx`
   (`CHILD_STATUS_COLORS`/`childBadge`) with overlapping but not
   identical status vocabularies.
9. No `AbortController`/mount-guard on several fetches triggered from
   message-listener callbacks (`PatientDetail.tsx`, `CompositionRuntime
   .tsx`) - a resolved fetch after the component's state has moved on
   can clobber newer state with stale data.
10. Icon-only buttons rely on `title` alone with no `aria-label` across
    `Dashboard.tsx`, `FunctionsAdmin.tsx`, `WidgetsAdmin.tsx`,
    `CompositionRuntime.tsx`.
11. `WidgetDataCard.tsx` uses raw hex colors throughout instead of the
    `var(--text-muted)`/`var(--danger)`/`var(--border)` custom properties
    every other reviewed component uses - inconsistent today, will
    actively break if the app ever gets a dark theme.
12. `FormBuilder.tsx` (3,083 lines), `LiveForm.tsx` (970),
    `PatientDetail.tsx` (972), `CompositionRuntime.tsx` (473, very dense
    inline JSX) are all single-file components with business logic and
    JSX tightly interleaved - hard to review or test in isolation.
13. **Test coverage** (see `docs/testing/README.md` for the general
    picture): `WidgetDataCard`'s `metric`/`text`/`trend`/`list` displays,
    severity coloring, and the `period` filter are entirely untested
    (only `matrix`/`timeline` are covered); `CompositionRuntime`'s
    session/launch/`commitTransaction`/validation state machine is
    untested beyond embed-chrome visibility (a test here would have
    caught finding #1 above); `PatientDetail.tsx` has zero tests
    (concretely: the Cockpit tab's `canExecuteForms` permission gate,
    the auto-select-once-then-respect-`userPickedTab` logic).

## Shared packages

Already fixed (PR #16): the `openehr-engine` repeat-index regex, the
`insertCompositionBlock` layout-desync bug, and the shared-array bug in
`createInitialRuntimeValues`. Remaining:

1. **`migrateCanonicalFormToV1` validates almost nothing**
   (`packages/core/src/form-definition/index.ts`) - `input as unknown as
   CanonicalForm`, only `schemaVersion`/`revision`/`extensions` are
   actually checked despite this being the trusted upgrade path both
   `apps/api` and `apps/web` rely on for every stored form. A payload
   missing `layout` silently produces an object with no `layout` key
   despite the type requiring one, surfacing as a crash further
   downstream in `collectRuntimeFields` instead of a clear validation
   error at the boundary.
2. ✅ **`NON_FIELD_TYPES` duplicated** between `packages/core/src/
   form-runtime/index.ts` (drives `collectRuntimeFields`) and the inline
   exclusion list in `form-scripting/index.ts`'s `isDataField()` (drives
   generated Form Script types) - the exact "same enum defined twice"
   pattern that previously caused the Matrix-widget save bug; if one list
   gets a new layout type and the other doesn't, generated `FieldId`
   types and runtime validation will silently disagree.
3. `mcp-server/src/apiClient.ts`'s error-response handling does an
   unguarded `JSON.parse(text)` - a non-JSON error body (e.g. a proxy 502
   HTML page) throws a raw `SyntaxError` instead of a clean
   `FormbuilderApiError`, degrading the agent-facing error message.
4. ✅ Dead code in `example-n8n-plugin/src/index.ts`: a ~120-line
   `workflowPayload()` function that's never called (the plugin actually
   uses `emptyWorkflowPayload()`), plus a user-facing "EHRbase URL für
   n8n" setting that's computed and then silently discarded. Confirmed
   absent now (likely via the n8n-provider-to-plugin move) - re-verified
   this pass with a direct file read: `workflowPayload` is gone,
   `emptyWorkflowPayload` is the only one left.
5. `quote()`/`union()` helpers and a diagnostics-array filter predicate
   copy-pasted between `form-scripting/index.ts` and
   `composition-scripting/index.ts`.
6. `packages/openehr-engine/src/canonicalComposition.ts` is extremely
   dense (single-line functions, deep nested ternaries, repeated unsafe
   casts) - hard to review/modify safely despite good prose comments.
7. **Test coverage**: no round-trip test anywhere for a repeating/indexed
   flat field through `fromOpenEhrFlatComposition` before this review's
   fix (now covered - see `packages/openehr-engine/tests/
   flat-composition-repeats.test.js`, but that only covers the read
   path found broken here, not the write side or every rmType branch);
   `packages/core`'s `form-definition` and `form-scripting` modules have
   no test file at all; `validateRuntimeValues`'s option/unit/min/max/
   pattern/`repeat-max`/visibility-evaluator logic is essentially
   untested beyond draft/final mode and basic type checks; 5 of 6 plugin
   packages have zero tests (`aql-prefill-plugin`'s hand-rolled AQL
   predicate parser in `resultPathResolver.ts` is the single highest-risk
   untested piece of logic found in the entire review).

## Suggested next slice

~~Given the pattern so far (fix the worst data-loss risks first, in small
reviewable batches with regression tests), a reasonable next batch:
`apps/web` finding #1 (`isFormEmbedEvent` dirty-event bug - same
data-loss class as what's already fixed) + `apps/api` findings #1 and #2
(authMode bug + admin-lockout guard - the two with real security/
availability impact).~~ Done - see PRs #17/#18 above, plus a follow-on
batch (apps/api #3/#4/#6 + shared packages #2) in PR #19.

~~Reasonable next batch after that: `apps/api` #5
(`syncPatientsFromEhrbase` N+1/no partial-failure recovery) and #7
(version-bump collision between `create-draft`/`restore`) - both real
correctness/reliability issues, no new architecture needed.~~ Done - PR
#21 (#7) and PR #22 (#5).

~~After that, the two bigger, cross-cutting items worth a dedicated pass
rather than a quick fix: `apps/web`'s hardcoded `http://localhost:3001`
in ~26 files (deployment-breaking, but touches a lot of files at once)
and `apps/api`'s complete absence of HTTP-layer tests (the single
highest-leverage remaining gap - would have caught several of the bugs
already fixed here).~~ The hardcoded-URL fix is done - PR #23, plus the
two files it missed (PR #53). The HTTP-layer test gap is done (#10
above, `fix/repeatable-composition-blocks` branch) - though only for
`compositionSessionRoutes` so far, extending it to the rest is ordinary
follow-up.

~~Everything here can wait for a dedicated pass, ideally once a CI
pipeline exists to keep fixes from regressing silently again.~~ Done -
see the "Fixed so far" entry above (PRs #55-#59). CI now runs on every
push/PR to `main` and is verified green from a genuinely clean checkout,
not just a long-lived local tree.

**Re-verified against current code during this pass** (2026-09,
Python-based checks after grep gave unreliable false negatives on this
OneDrive-synced path - see caveat below): apps/web #7 (`Object.keys`-
of-first-row column derivation, confirmed still present in both
`PatientDetail.tsx:781` and `WidgetDataCard.tsx`'s `list` display),
#11 (`WidgetDataCard.tsx` still has zero `var(--...)` usage - raw hex
literals throughout, including in the same `list` display block as
#7), apps/api #8 (dead plugin-validation comment block in
`formRoutes.ts`, unchanged), and shared-packages #5 (`quote`/`union`
still independently duplicated between `form-scripting/index.ts` and
`composition-scripting/index.ts`, not shared via import) are all
confirmed genuinely still open, not incidentally fixed by later work.
apps/web #9's `AbortController` gap is now half-closed: `PatientDetail
.tsx` has it, `CompositionRuntime.tsx` still doesn't.

What's left after those: apps/api #9/#11/#12 (all minor/test-coverage,
no urgency), apps/web #4/#6-#13 (session-recreate-on-keystroke,
`request<T>()` duplication, the two "first row determines table
columns" bugs, status-badge color-map duplication, missing
`AbortController`/mount-guards, missing `aria-label`s, hardcoded hex
colors, oversized single-file components), and the shared-packages
items (#1/#3-#7, plus the test-coverage gaps in finding #7:
`form-definition`/`form-scripting` have no test file at all,
`validateRuntimeValues` option/unit/min/max/pattern/`repeat-max`/
visibility-evaluator coverage, 5 of 6 plugin packages with zero tests -
`aql-prefill-plugin`'s hand-rolled AQL predicate parser is the single
highest-risk untested piece of logic found in the entire review). None
of this is urgent, but with CI now in place, a fix here won't silently
regress the way earlier fixes in this document sometimes did.

**Tooling caveat**: plain `grep`/Bash-`grep` has repeatedly returned
false-negative (empty) results for content demonstrably present in
files on this OneDrive-synced repo path, with no error - just silent
"no match" as if the content were genuinely absent. Every "fixed"/
"absent" conclusion in this document was cross-checked with a Python
`open(...).read()` + `re.search`, not bare `grep`, after this was
first caught mid-review (it had produced at least two wrong
conclusions before being caught). Worth keeping in mind for any future
pass on this repo.
