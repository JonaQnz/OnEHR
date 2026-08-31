# Testing overview

Four layers, each with a different job. Start here to find the right one
before adding a new test.

| Layer | Where | Runner | Needs a running stack? | Part of root `npm test`? |
|---|---|---|---|---|
| Backend unit/integration | `apps/api/tests/*.test.js` | `node:test` | No (mocks Prisma/EHRbase calls) | Yes |
| Frontend component | `apps/web/src/**/*.test.tsx` | Vitest + Testing Library | No (jsdom, `fetch` mocked per test) | Yes |
| End-to-end | `apps/e2e/tests/*.spec.ts` | Playwright, real Chromium | **Yes** - Docker (`api`+`web`+`db`) + a reachable EHRbase | No - see `apps/e2e/README.md` |
| Shared packages | `packages/*/tests` | `node:test` (varies per package) | No | Yes |

Run everything that doesn't need a live stack: `npm test` (root).
Run the E2E suite separately, once the stack is up: see
`apps/e2e/README.md`.

## Picking where a new test belongs

- **Pure logic with no DOM, no HTTP, no database** (a validator, a
  formatter, a normalization function) → whichever package/app it lives
  in, plain unit test. Cheapest and fastest to run and debug; prefer this
  whenever the thing under test doesn't actually need a browser or a
  server.
- **A React component's rendering/interaction logic** (does clicking
  this button call the right callback, does this prop change what
  renders) → `apps/web` Vitest, with `fetch`/`localStorage` mocked as
  needed. See `apps/web/src/components/WidgetDataCard.test.tsx` for the
  pattern (render → assert on the DOM via `@testing-library/react`
  queries) and `apps/web/src/pages/CompositionRuntime.test.tsx` for how
  to stub the backend (a `vi.stubGlobal('fetch', ...)` router keyed by
  URL/method).
- **An Express route's request/response contract, validation, or
  permission gating** → `apps/api` `node:test`, importing the compiled
  `dist/` (these tests run after `npm run build` - see the package's
  `test` script) and mocking Prisma/EHRbase calls at the module level
  (see any existing `apps/api/tests/*.test.js` for the pattern - most
  install a fake `prisma.<model>.findFirst` etc. before exercising the
  service function directly).
- **"Does this actually work when a real browser talks to the real
  backend talks to real EHRbase"** → `apps/e2e`. Reserve this layer for
  genuinely cross-boundary concerns (auth actually authenticating,
  routing/navigation, a component tree that's expensive to fully mock).
  It's the slowest and most infrastructure-dependent layer - don't
  duplicate something a unit/component test could already cover just
  because "real browser" feels more thorough.

## What actually has good coverage today, and what doesn't

Good: form/Composition validation (`packages/core`), the reuse-across-
versions and forms-only-launch backend logic, the Matrix/Timeline widget
display components, the Klinisches-Cockpit embedding refactor
(prop-override behavior), the composition-data local cache.

Thin or missing: most of the large page components in `apps/web`
(`PatientDetail.tsx`, `FormBuilder.tsx`, `CompositionBuilder.tsx`,
`LiveForm.tsx`) have little to no dedicated test coverage beyond what's
incidentally exercised by `CompositionRuntime.test.tsx` and the E2E
`patient-detail.spec.ts`; most `apps/api` routes only have coverage for
the specific bug/feature that prompted a test to be written, not
systematic edge-case coverage (empty inputs, permission-boundary cases,
downstream-failure paths). Treat this as an ongoing backlog, not a gap to
close in one pass.
