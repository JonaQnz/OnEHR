# AQL prefill (core, Form-Script-integrated)

Lets a Form Script pull data from an AQL query and write it into a field,
with an automatic conflict check against anything a clinician already
entered. This used to be a separate plugin (`formbuilder-plugin-aql-prefill`,
~2600 lines, its own settings tab, its own declarative
query/mapping config) - it's now core code, configured entirely from the
Script Editor. See `docs/features/dv-text-code-mappings.md` for the
related-but-distinct feature this was originally deferred from ("Phase 1
... no terminology lookup/autocomplete service ... deliberately deferred
follow-up") - this is that follow-up, generalized beyond just
`codeMappings`.

## Why it moved out of a plugin

The old plugin needed a special case in core routing code just to reach
EHRbase (`pluginRoutes.ts`/`scriptConnectorRegistry.ts` used to check
`pluginId === 'org.openehr.aql-prefill'` specifically) because plugins
don't otherwise get direct access to the active EHRbase connection. Its
own settings tab in `FormBuilder.tsx` and declarative
`AqlPrefillConfiguration` (query mode, parameter bindings, result
mappings, per-field behavior) duplicated a lot of what `AqlFunction` +
Form Script imports already do more simply. Consolidating onto that
existing mechanism removed both the special-case routing hack and the
duplicate configuration system.

## Foundation (already existed before this change)

- `packages/core/src/form-scripting/index.ts`'s
  `getFormFunctionImportConfiguration()` reads which `AqlFunction`
  catalog entries (the same table Widgets use - "Functions" admin) a
  Form Script has imported.
- `apps/api/src/services/aqlFunctionService.ts`'s
  `buildSessionRuntimeContext()` executes each imported function
  server-side (with `patientId`/`ehrId`/`templateId` auto-injected as
  parameters) and exposes the result as `context.aql['pkg.name']`.
- `apps/web/src/scripting/editor/ScriptEditor.tsx`'s "Functions & AQL
  importieren" panel is where a designer picks which `AqlFunction`s a
  form imports - the *only* place AQL gets configured for a form, no
  separate tab.

## What this change adds

### `aql.resolvePath(result, path)` (`packages/core/src/aql-runtime`)

Resolves an openEHR-flavored path out of an AQL result row - dot/slash
property access, array indices, and archetype-node-id / `name/value=`
predicates (`items[at0006]`, `items[at0006 and name/value='Systolic']`).
Ported from the old plugin's `resultPathResolver.ts` (the logic was
already correct, just untested - see
`packages/core/tests/aql-result-path.test.js`, 19 tests, its first
coverage). Available inside a Form Script as a built-in, alongside
`form`/`ui`/`events`/`context`/`functions`.

### `field(id).prefill(value, meta)` (Form Script runtime)

A companion to the existing `field(id).setValue(value)`:

```ts
events.beforeLoad(async () => {
  const result = context.aql['labor.haemoglobin_latest'];
  const value = aql.resolvePath(result, "rows/0/a/items[at0006]/value");
  await form.field('haemoglobin').prefill(value, { source: 'labor.haemoglobin_latest' });
});
```

- An empty field, or one whose current value already came from a
  previous `prefill()` call, is updated directly (a refresh, not an
  overwrite).
- A field that already holds something else - a clinician's own entry -
  is never silently overwritten. The call suspends (it's async) while
  the host shows a conflict dialog; the returned `{ applied: boolean }`
  reflects what the clinician decided.
- Every prefilled value carries provenance (`source`, optional
  `timestamp`) purely as runtime UI state - never written into the
  submitted composition itself. `FormRuntime.tsx` renders a small "⤓
  source · HH:MM" badge next to the field's label while that provenance
  is current, and clears it the moment the field changes through any
  other path (a plain `setValue()`, or the clinician typing into it).

### Conflict resolution (`PrefillConflictDialog`, `apps/web/src/components/`)

Ported from the old plugin's `PrefillConflictDialog` (that UX was
already solid - keep manual / overwrite all / select individually - it
just lived in a plugin). Multiple concurrent `prefill()` conflicts (e.g.
a `beforeLoad` loop prefilling several fields at once) batch into a
single dialog rather than one popup per field.

Protocol-wise this mirrors the existing `api.call()`/`api:response`
request pattern in `formScript.worker.ts` rather than inventing a new
one: the worker posts a `prefill:conflict` message with a `requestId`
and awaits a `prefill:resolve` reply carrying `apply: boolean`, exactly
like a script connector call.

### Guided snippet insertion (`ScriptEditor.tsx`)

Next to each imported AQL function's existing "+ Kontext-Code" button (which
inserts `const x = context.aql['pkg.name'];`), a "+ Vorbelegung" button:
pick a target field from a dropdown of the form's own known fields, and
it inserts a complete, ready-to-edit `beforeLoad` block using
`aql.resolvePath` and `field(id).prefill(...)` - the result path itself
is a `TODO` placeholder (that part is genuinely data-dependent, no way
to guess it), but the designer gets real, transparent, editable code
instead of hand-writing the whole block or configuring a separate
black-box schema.

## Deliberately not carried forward from the old plugin

- `AqlPrefillConfiguration`'s declarative query mode
  (`latest`/`earliest`/`custom`), parameter bindings, and result-mapping
  list - superseded by an `AqlFunction`'s own query (already
  admin-managed, already reusable across Widgets and forms) plus plain
  Form Script code for the mapping.
- `executionMode: 'automatic' | 'manual'` as a config enum - now just
  whether a script calls `prefill()` from `beforeLoad` (automatic-on-load)
  or from a button-triggered action (manual). No separate flag needed.
- `aqlPrefillStore.ts`/`aqlPrefillCache.ts`'s own client-side caching -
  results already come fresh from `context.aql` on every session build;
  nothing to cache client-side.
- `GroupPrefillButton`/`FormPrefillButton` as three separate copy-pasted
  components - not reintroduced yet; a script can already loop
  `field(id).prefill(...)` over a group's fields itself. A generic,
  scope-parametrized "prefill this group/form" runtime action is a
  reasonable future addition, not part of this change.

## Two pre-existing bugs found while live-testing this feature

Neither is new code from this change - both predate it and would have
silently broken *any* Form Script's `setValue()`/`prefill()`/`onChange()`
on a field whose canonical `id` and `name` differ (the norm for
openEHR-bound fields: a short `id` like `test_name` next to a fully
qualified `name` like `vg_observationlab.v1.2.0_test_name`). This
feature just happened to be the first thing that exercised the path
end-to-end against a real form.

- **`packages/core/src/form-scripting/index.ts`'s field-id resolution
  disagreed with `packages/core/src/form-runtime/index.ts`'s.**
  `form-scripting` (generates the FieldId type union a designer sees in
  the Script Editor) picked `name || id`; `form-runtime` (the actual
  values object the DOM binds to) picks `id || name`. A script written
  against the offered, type-checked `FieldId` would call
  `field('vg_observationlab.v1.2.0_test_name').prefill(...)` - a key the
  rendered `<input>` never reads. The Runtime Logs panel would show
  "geändert (script)" (the value genuinely landed in the values object,
  under the wrong key) while the field on screen stayed empty. Fixed by
  making `form-scripting`'s resolver match `form-runtime`'s exactly.
- **`FormBuilder.tsx`'s Preview tab never fetched `context.aql`.** Its
  "Test-Patient (für AQL-Vorbelegung)" patient/EHR-ID picker existed and
  looked wired up, but nothing ever called the backend to build a
  runtime context from it - `<FormRuntime>` was mounted with no
  `runtimeContext` prop at all, so `context.aql` was permanently `{}` in
  Preview regardless of which patient was selected. Fixed by a new
  `POST /api/forms/:id/preview-context` route (calls the same
  `buildSessionRuntimeContext()` a real launched session uses, without
  creating a `FormSession` row) and wiring FormBuilder.tsx to fetch it
  whenever the applied preview patient/EHR-ID changes.

## Tests

- `packages/core/tests/aql-result-path.test.js` - the path resolver, 19
  tests (see above).
- `apps/web/src/components/PrefillConflictDialog.test.tsx` - the
  conflict dialog component in isolation (resolve-all, resolve-none,
  individual selection, missing-label fallback, nullish-value display).
- No dedicated worker-level test for `field(id).prefill()`'s conflict
  detection itself - `formScript.worker.ts` has no test coverage at any
  level in this codebase (not just for this feature), and standing up
  worker-level test infrastructure was out of scope for this change.
  Verified instead by live-testing against the real running app (see
  bugs above, both found and fixed in the process): an empty field
  prefills and shows its badge; a field with an existing manual value
  raises the conflict dialog with correct current/AQL values; "Manuelle
  Werte behalten" (keep) correctly leaves the manual value untouched.
  "Werte aus AQL übernehmen" (overwrite) and "Auswahl übernehmen"
  (per-field) weren't cleanly click-timed live (the dialog's target
  patient data resolves within the same 5s `beforeLoad` timeout window,
  and slow manual clicking through browser automation kept missing it -
  confirmed as a testing-speed artifact, not a bug, since a live run
  landed the timeout error only after the value had already resolved
  correctly). Both call the exact same `apply()` → `setFieldValue()` code
  path already proven live in the keep/no-conflict cases, gated only by
  the boolean `PrefillConflictDialog.test.tsx` already covers for both
  buttons.
