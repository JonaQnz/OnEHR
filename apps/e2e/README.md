# E2E tests (Playwright)

Real-browser smoke tests against a running instance - not a substitute for
`apps/web`'s component tests (Vitest) or `apps/api`'s unit tests, but the
one layer that actually exercises browser → API → EHRbase together.

## Prerequisites

- The full stack running: `docker compose up -d` (or `--build` after a
  backend change) from the repo root.
- A working EHRbase instance reachable at whatever `EHRBASE_URL` the `api`
  container is configured with (see `docker-compose.yml`).
- Login credentials in the root `.env` (gitignored) - reuses whichever of
  these is already set, in this order: `E2E_ADMIN_USERNAME`/
  `E2E_ADMIN_PASSWORD`, `FORMBUILDER_MCP_USERNAME`/`FORMBUILDER_MCP_PASSWORD`,
  `FORMS_BOOTSTRAP_ADMIN_USERNAME`/`FORMS_BOOTSTRAP_ADMIN_PASSWORD`. No new
  credential file needed if any of those are already configured.
- Playwright's browser binary: `npx playwright install chromium` (once per
  machine; not installed by a plain `npm install`).

## Running

```sh
npm run test --workspace=e2e        # headless
npm run test:headed --workspace=e2e # watch it click through the app
```

Deliberately **not** part of the root `npm test` aggregate - unlike every
other workspace's tests, these need a live stack (Docker + EHRbase), so
running the root `npm test` without that stack up would just fail for
reasons that have nothing to do with a code change.

## What's covered so far

- `auth.spec.ts` - the non-interactive login (`global-setup.ts`, via the
  same `POST /api/auth/login` `packages/mcp-server` already uses) actually
  authenticates and the app shell renders, not a login screen.
- `patient-detail.spec.ts` - creates a real test patient via the API
  (tagged with an `E2E-` `patientId` prefix - there's no `DELETE
  /api/patients` endpoint yet, so these aren't cleaned up automatically),
  opens its patient page, and clicks through every tab in the tab bar
  (including the Klinisches-Cockpit tab, natively embedded, when one is
  published) verifying each one actually renders distinct content.

Writing more of these is an open, ongoing thing - not meant to be "done".
A natural next one: an actual form-fill-and-submit round trip through to
EHRbase, once there's a disposable/cleanup story for the data it would
write there.
