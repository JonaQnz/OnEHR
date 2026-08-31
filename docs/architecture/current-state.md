# Current Architecture State

Last substantially updated after the Klinisches-Cockpit / local-cache /
E2E-testing work. This tracks reality, not aspiration - see
`target-state.md` for where the team wants to end up and
`migration-plan.md` for the path there.

## Monorepo Structure
npm workspaces (`apps/*`, `packages/*`):

- **`apps/api`** - Node.js/Express + Prisma (Postgres) backend. Owns
  authentication/sessions, form/Composition CRUD, form-session and
  Composition-session runtime state, AQL function execution, data widgets,
  EHRbase connectivity, exporters (Cambio, mapping), and plugin loading.
- **`apps/web`** - React 18 + Vite frontend. Route-level code splitting
  (`React.lazy`) for every page except the always-needed shell.
- **`apps/e2e`** - Playwright smoke tests against a *running* instance
  (Docker + EHRbase). Deliberately not part of the root `npm test`
  aggregate - see `apps/e2e/README.md`.
- **`packages/core`** - Shared TypeScript types + canonical
  form/Composition normalization logic (`normalizeCompositionDefinition`,
  `getCompositionDefinition`, ...). Single source of truth both
  `apps/api` and `apps/web` import from directly (aliased to `src/`, not a
  built `dist/`, in both Vite and the API's own module resolution) -
  duplicating a type here instead of importing it has caused real bugs
  before (see "Known sharp edges" below).
- **`packages/mcp-server`** - MCP server exposing the Forms API as tools
  for AI agents (`launch_form`, `create_form`, `list_patients`, ...) -
  logs in via the same `POST /api/auth/login` a browser session would use.
- **`packages/openehr-architect-mcp`** - a second MCP server, scoped to
  openEHR template/WebTemplate inspection and Form design (used by the
  `openehr-architect` subagent).
- **`packages/openehr-engine`** - WebTemplate parsing and openEHR RM data
  type handling.
- **`packages/plugin-api`** + plugin packages (`aql-prefill-plugin`,
  `example-vitals-plugin`, `example-n8n-plugin`,
  `formbuilder-plugin-iframe`, `postal-lookup-plugin`,
  `formbuilder-plugin-clinical-scores`) - backend/frontend plugin
  extension points.
- **`packages/react-form-builder2`** - vendored/forked drag-and-drop form
  designer library the Form Builder canvas is built on.

## Core domain model

- **Form Section** (`kind: "form"` internally) - one atomic, reusable
  building block bound to an openEHR template (e.g. "Diagnosen /
  Vorerkrankungen"). Cannot be launched standalone for a patient - only
  as a block already wired into a running Composition session
  (`assertFormSectionLaunchAllowed` in `formSessionService.ts`).
- **Form** (`kind: "composition"` internally, called "Composition" in
  code/APIs/MCP tools - the rename to "Form" only landed in user-facing UI
  text) - a multi-page assembly of Form Section blocks + data-widget
  blocks + text blocks, run as one `CompositionSession` per patient. Not
  to be confused with the *real* openEHR RM Composition (the actual
  submitted clinical document - `CompositionRepository`,
  `context.composition`, `/api/patients/:id/compositions`) - that concept
  is separate and correctly untouched by the naming above.
- **`parent_id` vs `id` versioning** - every `publish_form` mints a new
  `Form.id`; `parent_id` stays stable across every version of one
  Form/Form Section's lineage. Code that needs "every prior submission of
  this Form Section regardless of which version was active" resolves by
  `parent_id`, not `id` (see `listFormSessions`'s `parentFormId` filter).
- **Data widgets** - read-only clinical-data cards (list/text/trend/
  metric/matrix/timeline display), each backed by a stored AQL function.
  `CompositionDataBlock['display']` (in `packages/core`) and
  `dataWidgetService.ts`'s own `displays` array are two independent
  places that both have to list every display value - a known sharp edge,
  see below.
- **Klinisches Cockpit** pattern - a Composition-kind Form embedded
  *natively* (not via iframe) directly inside `PatientDetail.tsx` as a
  tab, auto-selected once a Form named exactly `"Klinisches Cockpit"` is
  published and the viewer has `form.execute`. `CompositionRuntime.tsx`
  accepts prop overrides (`formId`, `initialPatientId`, `initialEhrId`,
  `embedded`, ...) for everything it would otherwise read from
  `useParams()`/`useSearchParams()`, specifically so it can be mounted
  directly instead of only routed to - the standalone `/compositions/:id`
  route still uses the unmounted-props path, both are exercised by
  `CompositionRuntime.test.tsx`.

## Data flow for clinical data widgets (and its cache)

`WidgetDataCard.tsx` renders whatever `POST /forms/:id/composition-data`
returns for a block. That endpoint always re-runs the underlying AQL
query/data-provider call in full server-side (AQL is arbitrary,
author-written text - the endpoint can't safely rewrite a WHERE clause
into it), but as of the composition-data local-cache work, the frontend
(`apps/web/src/integration/compositionDataCache.ts`) keeps a
localStorage-backed cache per user/form/block/patient/EHR and only asks
for rows newer than what it already has (`since`, compared against the
block's `timeColumn`); the backend replies with just the diff plus
`cachedThrough` for the next cursor
(`apps/api/src/services/compositionDataDiff.ts`). This only reduces
transfer size and re-render cost, not EHRbase query cost - a genuine
reduction in EHRbase load would need a server-side result cache, which
doesn't exist yet. An explicit "Aktualisieren" refresh
(`data.refresh()` from a composition script) bypasses the cache entirely,
since the incremental path can only ever learn about rows strictly newer
than what's cached, never a correction to an existing row's value at the
same timestamp.

## Testing layers

1. `apps/api` - `node:test`, ~193 tests, run via `npm test` (also runs
   `tsc` build first).
2. `apps/web` - Vitest + Testing Library component tests, run via
   `npx vitest run` (or `npm test --workspace=web`). No browser, no
   backend - fetch is mocked per test.
3. `apps/e2e` - Playwright, real browser against a real running Docker +
   EHRbase stack. See `apps/e2e/README.md` for prerequisites; not part of
   the root `npm test` aggregate.
4. `packages/core`, `packages/mcp-server`, `packages/openehr-architect-mcp`,
   `packages/plugin-api` each have their own `npm test`, aggregated by the
   root `npm test` script.
5. `docs/testing/ehrbase-integration.md` - opt-in integration test against
   a real isolated EHRbase instance (port 8082), separate from the dev
   EHRbase.

## Known sharp edges (still true as of this writing)

1. **Duplicated display/type enums.** `CompositionDataBlock['display']`
   (`packages/core`) and `dataWidgetService.ts`'s own `displays` array
   independently list the same values - adding a new display type (as
   happened with `matrix` and `timeline` this session) requires updating
   both, and forgetting the second one previously shipped a widget type
   that silently failed to save. Search for both places before adding a
   sixth display type.
2. **Widespread `any`** - still true in `react-form-builder2` typings,
   some plugin implementations, and parts of `core/src/canonical` and
   `core/src/form-runtime`. Not solved by anything landed since the
   original audit that first wrote this doc.
3. **Frontend/backend parsing duplication** - `web/src/adapters/`
   (frontend) and `api/src/parsers/webTemplateParser.ts` (backend) both
   have logic mapping WebTemplate fields to form definitions; worth
   re-checking whether this has actually converged since the last audit
   or if it's still two implementations.
4. **Hardcoded plugin dependencies** - `apps/api` and `apps/web` still
   import specific plugins directly rather than discovering them
   dynamically through `plugin-api`'s boundary.
5. **No CI pipeline.** Every merge to `main` today is gated only by
   whoever's doing the merge manually running `npm test`/`tsc` first, not
   by an automated check. Flagged as the highest-priority infrastructure
   gap; deliberately deferred (see project conversation history) in favor
   of first building out actual test coverage (items 1-3 under "Testing
   layers" above) to have something for a CI pipeline to run.
6. **Concurrent editing on the live dev instance.** More than one
   development session (human or agent) can be, and has been, working
   against the same checked-out working tree and the same live Form
   Builder database at once. Always re-fetch the current state of a Form
   immediately before editing it via the MCP tools, and never blindly
   `git add -A` - check `git status` for files you didn't intend to touch
   before committing.
