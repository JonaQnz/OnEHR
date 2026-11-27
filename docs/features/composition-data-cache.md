# Composition data widget cache

Data widgets (lab values, medication, timeline/matrix entries in
Klinisches Cockpit and any other Composition) used to re-fetch and
re-render their entire result set from EHRbase/AQL on every load. This
document describes the current contract between
`apps/web/src/integration/compositionDataCache.ts`,
`apps/web/src/pages/CompositionRuntime.tsx` and - for older clients only -
`apps/api/src/services/compositionDataDiff.ts`.

## What this does and does not do

- **Does**: keep each data block's last result in a **volatile,
  in-memory cache** for the lifetime of the authenticated page session,
  paint instantly from it on revisit, and replace those rows completely
  with the next full fetch.
- **Does not**: persist clinical rows in `localStorage`/`sessionStorage`
  or any other storage that survives a reload. The cache is gone on page
  reload, logout, identity switch and auth loss.
- **Does not**: reduce the EHRbase/AQL query cost. The backend still runs
  the full underlying query every time; AQL is arbitrary, author-written
  text stored per data widget. A genuine reduction in EHRbase load would
  need a server-side result cache - a separate, larger piece of work.

## Volatile cache and scoping

`compositionDataCacheKey(context)` is an in-memory key built from:

1. the **authenticated session** (`compositionSessionScope`: auth mode,
   auth source and user id - `anonymous` once auth is lost), and
2. the **full clinical context**: form id, block id, patient id,
   **namespace** and EHR id.

The namespace is part of the key because the same patient id can exist
in more than one namespace. A shared browser profile used by more than
one clinician must never surface one user's cached clinical data to
another.

`activateCompositionDataCacheScope(scope)` is called by `AuthGate` and by
`CompositionRuntime` before a read. Whenever the scope changes, every
entry is dropped. `clearCompositionDataCache()` clears all entries and
the active scope; it runs on logout, on an identity switch and when the
`/auth/me` reload reports that authentication was lost. A cached entry
also expires after `MAX_AGE_MS` (24h) as a defensive bound for a very
long-lived tab.

## Removing the old persisted cache at startup

Earlier versions stored rows under the prefix
`formbuilder:compositionDataCache:v1:`. `purgeLegacyCompositionDataCache()`
is called once at app startup and removes **only** keys at that known
prefix. It uses `localStorage.key()`/`removeItem()` exclusively - it never
reads (`getItem`) or parses a persisted clinical payload, and it never
touches keys from other features.

## Full fetch on every request - deliberately higher transfer volume

`POST /forms/:id/composition-data` is still called with the block id,
patient (`id` + optional `namespace`) and EHR id, but the runtime **no
longer sends a `since` cursor**. Every load transfers the full widget
result. That is intentionally more network traffic than the previous
incremental path, and it buys correctness:

- A corrected value whose `timeColumn` did not change (e.g. a typo fix
  that keeps the original recorded-at time) becomes visible immediately.
- Rows removed server-side disappear instead of lingering in the cache.
- No dedupe/merge heuristic is needed for timeless rows.

The response **replaces** the block's cached rows and the rendered rows
completely (`result.rows`), it is never merged with the previous set.

## Preventing stale requests from repopulating UI or cache

A fetch captures its clinical scope (`sessionScope`, form, patient,
namespace, EHR id) and a per-block sequence number. A response (success
or error) is ignored unless:

- no newer request for the same block was started, and
- the context was not reset (patient/namespace/EHR/mode switch bumps a
  shared epoch), and
- the captured scope still equals the currently rendered scope, and
- the cache module's active session scope still matches (a late response
  after logout/identity switch is refused a cache write).

So a slow response for patient A / namespace X can never paint over or
fill the cache for patient B / namespace Y after a switch.

## Explicit refresh and error behaviour

`force` is unchanged: `refreshData(blockId, true)` (used by the
`data.refresh()` composition-script API and page-visibility-triggered
refreshes) bypasses the cache, fetches everything fresh and overwrites
the cache with the result. Non-forced loads still paint cached rows
first, show the loading state when nothing is cached, and on failure keep
the previously cached rows alongside the error message.

## Backend compatibility

The backend's `since` / `cachedThrough` contract
(`apps/api/src/services/compositionDataDiff.ts`, wired into
`formRoutes.ts`) is unchanged and still covered by
`apps/api/tests/composition-data-diff.test.js`. Earlier cursor clients
remain compatible even though this frontend no longer sends `since`.

## Testing

- `apps/web/src/integration/compositionDataCache.test.ts` - key scoping
  by session/patient/namespace/EHR, in-memory round-trip without
  localStorage writes, complete row replacement, scope invalidation on
  logout/identity switch, and selective legacy-key purge without reading
  payloads.
- `apps/web/src/pages/CompositionRuntime.test.tsx`'s "data cache wiring"
  describe block - component-level wiring: instant paint from the
  volatile cache, requests without `since`, full replacement (including a
  corrected value with an unchanged timestamp), and late responses after
  patient/namespace switches being ignored by UI and cache.
- `apps/api/tests/composition-data-diff.test.js` - the backend `since`
  diffing logic kept for older clients.
