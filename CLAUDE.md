# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

onEHR — an openEHR-first Clinical Form Platform: a visual drag-and-drop form
designer, a runtime engine, a typed plugin SDK, native openEHR/EHRbase
interoperability, and two MCP servers so an agent can design and operate
forms directly against a real EHRbase instance. npm workspaces monorepo
(`apps/*`, `packages/*`).

**Form Section vs. Form** — a distinction used everywhere in code/docs:
- **Form Section** (`kind: "form"` internally) — a reusable clinical building
  block bound to an openEHR archetype/template (e.g. "Diagnosis"). Cannot be
  launched standalone for a patient, only as a block wired into a running
  Composition session.
- **Form** (`kind: "composition"` internally, called "Composition" in
  code/APIs/MCP tool names) — a patient-launchable, multi-page assembly of
  Form Section blocks + data-widget blocks + text blocks. Not to be confused
  with the actual openEHR RM Composition (the submitted clinical document —
  `CompositionRepository`, `/api/patients/:id/compositions`), which is a
  separate, correctly-untouched concept.

## Commands

```bash
npm install                 # from repo root
npm run build:packages      # build core, openehr-engine, plugin-api, and all plugins
npm test                    # build:packages, then run every workspace's own test script
```

`npm test` runs, in order: `core` → `openehr-engine` → `plugin-api` →
`formbuilder-plugin-hapi-terminology` → `openehr-architect-mcp` →
`formbuilder-mcp-server` → `api` → `web`. None of these require a running
database or EHRbase — API/HTTP-layer tests mock the service layer.

Per-workspace, most packages use plain `node:test` (`npm run build && node
--test tests/*.test.js`); run a single file directly once built, e.g.:

```bash
cd packages/core && npm run build && node --test tests/someFile.test.js
cd apps/api && npm run build && node --test tests/someFile.test.js       # unit/service tests
cd apps/api && node --test tests/http/someRoute.test.js                  # HTTP-layer tests (real Express app, in-process)
```

`apps/web` uses Vitest:

```bash
cd apps/web && npx vitest run src/path/to/File.test.tsx   # single file
cd apps/web && npm run test:watch                          # watch mode
cd apps/web && npm run lint
```

Local dev servers (need Postgres + `apps/api/.env` configured, or use
`docker-compose up`):

```bash
cd apps/api && npm run dev     # Express API
cd apps/web && npm run dev     # Vite frontend
```

**E2E** (`apps/e2e`, Playwright) needs a full running stack (Docker + a
reachable EHRbase) and is deliberately **not** part of root `npm test`:

```bash
npm run test --workspace=e2e         # headless
npm run test:headed --workspace=e2e  # headed
```

**EHRbase integration test** (opt-in, real isolated EHRbase on port 8082,
separate from dev EHRbase): `apps/api` → `npm run test:integration:ehrbase`.
See `docs/testing/ehrbase-integration.md`.

CI (`.github/workflows/ci.yml`) runs the full `npm test` aggregate on Node 22
(vitest requires >=20), plus a separate production-build job for `apps/web`
on Node 18 mirroring `Dockerfile.web` exactly — a build that passes `vite
build` in dev can still break in that job (a past real failure: a worker
chunk's CJS/ESM interop broke under Rollup only in production).

## Picking where a new test belongs

See `docs/testing/README.md` for the full decision guide. Short version:
pure logic → a plain unit test in whichever package it lives in (cheapest,
prefer this by default); a React component's render/interaction logic →
`apps/web` Vitest with `fetch` mocked; a service function's own logic
(validation, computed status, concurrency-retry) → `apps/api/tests/*.test.js`
calling the service directly with Prisma/EHRbase mocked at module level
(most business logic belongs here); whether a request actually reaches that
logic — route wiring, `attachAuth`/`requirePermission`, `errorHandler`'s
response shape — → `apps/api/tests/http/*.test.js` against the real
`createApp()` Express app; "does this work end-to-end against a real
browser/backend/EHRbase" → `apps/e2e`, reserved for genuinely cross-boundary
concerns, not a substitute for the layers above.

## Architecture

### Monorepo layout

- **`apps/api`** — Node/Express + Prisma (Postgres) backend. Owns auth/
  sessions, Form/Composition CRUD, form-session and Composition-session
  runtime state, AQL function execution, data widgets, EHRbase connectivity,
  exporters, and plugin loading. `app.ts` builds the pure Express app (no
  side effects, used by HTTP-layer tests); `index.ts` is the only place that
  loads `.env`/config, loads plugins, and actually `.listen()`s.
- **`apps/web`** — React 18 + Vite frontend, route-level code splitting
  (`React.lazy`) per page.
- **`apps/e2e`** — Playwright smoke tests against a running instance.
- **`packages/core`** — shared TypeScript types + canonical form/Composition
  normalization logic. Single source of truth both `apps/api` and `apps/web`
  import from directly by source (`src/`, not a built `dist/`, in both Vite
  and the API's module resolution) — duplicating a type here instead of
  importing it has caused real bugs before. Contains the form-runtime,
  form-scripting/composition-scripting engines, AQL runtime, canonical
  model, openEHR RM constraint handling, terminology contract,
  fhir-mapping, folder-mapping, and form-launch logic.
- **`packages/openehr-engine`** — WebTemplate parsing (`opt/`) and openEHR
  RM data-type read/write handling (`canonicalComposition.ts`, wire-format
  conversion for DV_* types).
- **`packages/plugin-api`** — the plugin SDK contract (extension points,
  manifests, frontend/backend registrar interfaces) that every plugin
  package implements.
- **`packages/react-form-builder2`** — vendored/forked drag-and-drop
  designer library the Form Builder canvas is built on; has its own
  `build:lib` (Babel transpile + Sass) consumed by `apps/web`.
- **`packages/mcp-server`** (`formbuilder-mcp-server`) — MCP server exposing
  the Forms app's own APIs as tools (`create_form`, `publish_form`,
  `launch_form`, `create_patient`, `create_data_widget`,
  `submit_form_session_to_provider`, ...); logs in via the same
  `POST /api/auth/login` a browser session would use.
- **`packages/openehr-architect-mcp`** — a second MCP server that talks
  directly to EHRbase's own openEHR Definitions REST API (not through the
  Forms app) for template/WebTemplate authoring. Both servers are
  registered in `.mcp.json` at the repo root.
- Plugin packages — `example-vitals-plugin`, `example-n8n-plugin`,
  `formbuilder-plugin-iframe`, `postal-lookup-plugin`,
  `formbuilder-plugin-clinical-scores`, `formbuilder-plugin-hapi-terminology`
  — ordinary npm packages against the `plugin-api` contract, loaded (backend,
  in-process, no sandbox) via `apps/api/src/plugins/pluginRegistry.ts` based
  on the `pluginPackages` list in env/`data/config.json`. AQL prefill is
  **not** a plugin — it's core, Form-Script-integrated functionality
  (`packages/core/src/aql-runtime`, `field(id).prefill(...)`); see
  `docs/features/aql-prefill.md`.

### Core domain model

- **`parent_id` vs `id` versioning** — every `publish_form` mints a new
  `Form.id`; `parent_id` stays stable across every version of one Form/Form
  Section's lineage. Code needing "every prior submission of this Form
  Section regardless of which version was active" resolves by `parent_id`.
- **Data widgets** — read-only clinical-data cards (list/text/trend/metric/
  matrix/timeline), each backed by a stored AQL function. Adding a new
  display type requires updating it in **two** independent places:
  `CompositionDataBlock['display']` (`packages/core`) and
  `dataWidgetService.ts`'s own `displays` array — forgetting the second one
  silently produces a widget type that fails to save.
- **Klinisches Cockpit** — a Composition-kind Form embedded natively (not
  iframe) inside `PatientDetail.tsx` as a tab, auto-selected once a Form
  named exactly `"Klinisches Cockpit"` is published and the viewer has
  `form.execute`. `CompositionRuntime.tsx` accepts prop overrides (`formId`,
  `initialPatientId`, `initialEhrId`, `embedded`, ...) for everything it
  would otherwise read from routing, specifically so it can be mounted
  directly as well as routed to.
- **Composition-data cache** — `WidgetDataCard.tsx` calls
  `POST /forms/:id/composition-data`, which always re-runs the AQL query
  server-side in full (AQL is arbitrary author-written text, can't safely
  rewrite a WHERE clause). The frontend
  (`apps/web/src/integration/compositionDataCache.ts`) keeps a
  localStorage-backed cache per user/form/block/patient/EHR and asks only
  for rows newer than `since`; this reduces transfer/render cost only, not
  EHRbase query cost. An explicit refresh bypasses the cache, since the
  incremental path can only learn about strictly-newer rows, never a
  correction to an existing row at the same timestamp.

### Plugin extension points

`plugin-api`'s `PLUGIN_EXTENSION_POINTS`: `settings`, `field`, `form`,
`renderer`, `designer`, `runtime`, `scripting`, `dataProvider`,
`terminology`, `workflow`, `lifecycle`, `ui`, `widget`. Frontend
contributions register via `registerField` (new drag-and-drop components in
the Form Builder toolbox) and `registerRenderer` (React implementations for
those fields inside `FormRuntime`). Backend plugins access their own
persisted settings via a generic `context.getSettings()` the host calls per
plugin — never hardcode one plugin's settings shape into shared dispatch
code (a real bug fixed this way before).

### Known sharp edges

1. Duplicated display/type enums (see "Data widgets" above) — search both
   places before adding a new display type.
2. Widespread `any` in `react-form-builder2` typings, some plugin
   implementations, and parts of `core/src/canonical` and
   `core/src/form-runtime`.
3. Frontend/backend WebTemplate-parsing duplication —
   `apps/web/src/adapters/` and `apps/api/src/parsers/webTemplateParser.ts`
   both map WebTemplate fields to form definitions; re-check convergence
   before assuming either is the sole source of truth.
4. `apps/api` and `apps/web` still import some plugins directly rather than
   discovering them dynamically through `plugin-api`'s boundary.
5. Union-typed archetype fields (e.g. DV_TEXT-or-DV_CODED_TEXT) can be bound
   differently across Form Sections that share one aqlPath — read-path code
   (`readFlatValue` and friends) must dispatch per-binding, not per-rmType.
6. **Concurrent editing on the live dev instance.** More than one
   development session (human or agent) can be working against the same
   checked-out tree and the same live Form Builder database at once. Always
   re-fetch a Form's current state immediately before editing it via MCP
   tools, and never blindly `git add -A` — check `git status` for files you
   didn't intend to touch before committing.

`docs/architecture/current-state.md` tracks this in more depth (and
`target-state.md`/`migration-plan.md` for direction); treat it as the
canonical architecture reference alongside this file, but note it can lag
reality on fast-moving details (e.g. it predates the CI workflow that now
exists).

## Documentation map

- `docs/architecture/` — current/target state, migration plan.
- `docs/features/` — feature-specific deep dives (AQL prefill, composition
  data cache, repeatable blocks, DV_TEXT/coded-text mappings, FHIR debug,
  HIP FHIR patient creation, OPT constraint engine, RM type-spec
  conformance).
- `docs/integration/form-launch-v1.md` — form-launch contract.
- `docs/testing/` — testing layer guide + EHRbase integration test setup.
- `docs/concepts/value-catalogs.md`, `docs/authentication.md`,
  `docs/scripting-integration.md`, `docs/debug-ehrbase.md`.
- GitHub Wiki (linked from `README.md`) — fuller architecture, auth/RBAC,
  multi-connection EHRbase, Form Scripting Engine, integration functions,
  plugin SDK, and MCP server reference.
