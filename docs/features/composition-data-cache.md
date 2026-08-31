# Composition data widget local cache

Data widgets (lab values, medication, timeline/matrix entries in
Klinisches Cockpit and any other Composition) used to re-fetch and
re-render their entire result set from EHRbase/AQL on every load. This
document is the contract between `apps/web/src/integration/
compositionDataCache.ts` and `apps/api/src/services/
compositionDataDiff.ts` - read this before changing either side.

## What this does and does not do

- **Does**: cache each data block's rows in the browser's `localStorage`,
  paint instantly from that cache on revisit, and on the next fetch only
  ask the backend for rows newer than what's cached - shrinking the
  response payload and the frontend's re-render work.
- **Does not**: reduce the EHRbase/AQL query cost itself. The backend
  still runs the full underlying query every single time; AQL is
  arbitrary, author-written text stored per data widget, not something
  `POST /forms/:id/composition-data` can safely rewrite a `WHERE` clause
  into. A genuine reduction in EHRbase load would need a server-side
  result cache - a separate, larger piece of work that doesn't exist yet.

## The `since` / `cachedThrough` contract

`POST /forms/:id/composition-data` accepts an optional `since` (epoch
ms) in its request body. Behavior depends on the block's `timeColumn`:

- **No `timeColumn` configured on the block** (e.g. a `metric`/`text`
  display with no natural time axis) → `since` is ignored, every row is
  always returned, and the response's `cachedThrough` is `undefined`.
  There is nothing to diff by; the cache still helps with instant paint
  on revisit, just not with incremental fetching.
- **`timeColumn` configured, no `since` sent** (first-ever fetch for this
  cache key) → every row is returned, but `cachedThrough` is still
  computed (the max `timeColumn` value across the full result), so the
  client can start caching from this very response.
- **`timeColumn` configured, `since` sent** → only rows with a
  `timeColumn` value **strictly greater than** `since` are returned.
  `cachedThrough` is always computed from the **full** underlying result,
  not just the rows sent back, so the client's cursor never regresses. A
  row with no usable `timeColumn` value at all is always kept (can't be
  judged old or new).

Both response paths (the `widgetId` path via `executeDataWidget` and the
raw `aqlFunctionId` path) go through the same `diffed()` helper in
`formRoutes.ts`, which delegates to `diffRowsSince()` in
`compositionDataDiff.ts` - see that file's unit tests
(`apps/api/tests/composition-data-diff.test.js`) for the exact edge
cases covered (no timeColumn, first fetch, `since` already covers
everything, rows with no time value).

## The cache key

`compositionDataCacheKey({ userId, formId, blockId, patientId, ehrId })`
in `compositionDataCache.ts`. Scoped by **user**, not just by
form/block/patient - a shared browser profile used by more than one
clinician must never surface one user's cached clinical data to another.
The cache is cleared entirely on logout (`clearCompositionDataCache()`,
wired into `App.tsx`'s `logout()`).

## The correction-visibility caveat, and how `force` handles it

The incremental path can only ever learn about rows **strictly newer**
than what's already cached - it has no way to learn that an *existing*
cached row's value was corrected in EHRbase without its `timeColumn`
also changing (e.g. a typo fix that keeps the original recorded-at
time). Two things bound how stale that can get in practice:

1. A 24-hour max-age on every cache entry (`MAX_AGE_MS` in
   `compositionDataCache.ts`) - a purely defensive safety net, not the
   primary freshness mechanism.
2. **`force` bypasses the cache entirely.** `refreshData(blockId, true)`
   in `CompositionRuntime.tsx` - used by the existing "Aktualisieren"-
   style `data.refresh()` composition-script API, and by page-visibility-
   triggered refreshes like Klinisches Cockpit's Medikationssicherheit
   page - ignores any cached rows/`cachedThrough`, fetches everything
   fresh, and overwrites the cache with the full, correct result. Any
   code path that cares more about correctness than speed for a given
   reload should call `refreshData(blockId, true)`, not rely on the
   default incremental path.

## Testing

- `apps/web/src/integration/compositionDataCache.test.ts` - the cache
  module in isolation (key scoping, round-trip, corrupted-entry handling,
  expiry, merge, clear).
- `apps/api/tests/composition-data-diff.test.js` - the diffing logic in
  isolation.
- `apps/web/src/pages/CompositionRuntime.test.tsx`'s "data cache wiring"
  describe block - `refreshData`'s actual wiring end to end at the
  component level: a pre-seeded cache paints instantly, the background
  fetch carries the cache's own `cachedThrough` as `since`, the response
  merges into both UI state and the cache, and a genuinely first load
  (nothing cached) sends no `since` at all.
