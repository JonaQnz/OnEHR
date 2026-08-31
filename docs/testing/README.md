# Testing overview

Four layers, each with a different job. Start here to find the right one
before adding a new test.

| Layer | Where | Runner | Needs a running stack? | Part of root `npm test`? |
|---|---|---|---|---|
| Backend unit/integration | `apps/api/tests/*.test.js` | `node:test` | No (mocks Prisma/EHRbase calls) | Yes |
| Backend HTTP-layer | `apps/api/tests/http/*.test.js` | `node:test` | No (real Express app via `createApp()`, in-process on an ephemeral port; mocks service-module calls) | Yes |
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
- **A service function's own logic** (validation, a computed status, a
  concurrency-retry path) → plain `apps/api/tests/*.test.js`, calling the
  service function directly and mocking Prisma/EHRbase at the module level
  (see any existing file there for the pattern - most install a fake
  `prisma.<model>.findFirst` etc.). This is the cheaper, more common case -
  most business logic belongs here, not one layer up.
- **Whether a request actually reaches that logic in the first place** -
  route wiring, `express.json()` body parsing, `attachAuth`/
  `requirePermission` actually blocking an unauthenticated/under-permissioned
  request, `errorHandler`'s response shape (an `HttpError`'s message/details
  passed through as-is; any other thrown error redacted to a generic 500,
  never echoing internals) → `apps/api/tests/http/*.test.js`. These start
  the real `createApp()` Express app (see `app.ts`) on an ephemeral
  in-process port via `tests/support/httpServer.js`, then mock whichever
  service-module function(s) the route under test calls - same
  monkeypatch-the-`dist`-module technique as the plain service tests, just
  applied one layer further out. `tests/support/testAuth.js` controls what
  `attachAuth` sees per request (`asAdmin()`/`asUser(permissions)`/
  `asAnonymous()`) without touching a real session/cookie/DB. Reach for
  this layer specifically to prove a permission check or error-shape
  guarantee holds at the actual HTTP boundary - not to re-test logic a
  plain service test already covers just because "through Express feels
  more thorough".
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
`patient-detail.spec.ts`; most `apps/api` routes still only have
service-level coverage for the specific bug/feature that prompted a test
to be written, not systematic edge-case coverage (empty inputs,
downstream-failure paths). The HTTP-boundary layer itself
(`tests/http/`) is brand new and only covers `compositionSessionRoutes`
end to end so far (auth/permission gating, `errorHandler`'s response
shape, a 400 from the route itself) - the same pattern should be extended
to the other route files over time, not treated as done. Treat this as an
ongoing backlog, not a gap to close in one pass.
