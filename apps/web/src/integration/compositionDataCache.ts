/**
 * Client-side cache for Composition data-widget results (lab values,
 * medication, timeline/matrix entries, ...) - the "lädt langsam" pain
 * point flagged earlier this session. Rows are kept in localStorage so a
 * revisit paints instantly from what's already there, while the network
 * request behind it only ever asks the backend for rows newer than what's
 * cached (see the `since`/`cachedThrough` contract on POST
 * /forms/:id/composition-data in formRoutes.ts) instead of re-fetching and
 * re-rendering the full result set every time.
 *
 * This does NOT reduce the backend's own EHRbase/AQL query cost - that
 * query still runs in full server-side every time; only the amount of data
 * that crosses the wire to the browser, and the work of re-processing it
 * here, shrinks. A deeper win (skipping the EHRbase query itself) would
 * need a server-side cache, which is a separate, bigger piece of work.
 *
 * Scoped per user (not just per form/block/patient): a shared browser
 * profile used by more than one clinician must never surface one user's
 * cached clinical data to another. Cleared entirely on logout (see
 * App.tsx's clearCompositionDataCache() call).
 */

const PREFIX = 'formbuilder:compositionDataCache:v1:';
// Defensive only (the "since" round trip is what keeps entries fresh) -
// bounds how long a genuinely abandoned cache entry survives in
// localStorage, e.g. after a patient's data widget hasn't been reopened in
// a long time.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CachedBlockData {
  rows: Record<string, unknown>[];
  /** Newest timeColumn value (epoch ms) seen across every row this cache
   * entry has ever received - the next fetch's `since` cursor. Undefined
   * when the block has no timeColumn (nothing to diff by; every fetch
   * returns everything, cache is then purely "paint instantly on revisit"). */
  cachedThrough?: number;
  savedAt: number;
}

export function compositionDataCacheKey(params: { userId: string; formId: string; blockId: string; patientId: string; ehrId?: string }): string {
  return `${PREFIX}${params.userId}:${params.formId}:${params.blockId}:${params.patientId}:${params.ehrId || ''}`;
}

export function loadCachedBlockData(key: string): CachedBlockData | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as CachedBlockData;
    if (!Array.isArray(parsed.rows) || typeof parsed.savedAt !== 'number') return undefined;
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) { localStorage.removeItem(key); return undefined; }
    return parsed;
  } catch {
    // Corrupted entry (manual edit, a future incompatible shape, storage
    // quota weirdness) - treat exactly like "no cache", never let a read
    // failure here break the widget itself.
    return undefined;
  }
}

export function saveCachedBlockData(key: string, data: { rows: Record<string, unknown>[]; cachedThrough?: number }): void {
  try {
    localStorage.setItem(key, JSON.stringify({ ...data, savedAt: Date.now() } satisfies CachedBlockData));
  } catch {
    // Storage quota exceeded or unavailable (private browsing in some
    // browsers) - caching is a pure performance optimization, never worth
    // surfacing an error to the clinician over.
  }
}

/** Appends newly-fetched rows (already filtered server-side to only what's
 * newer than the cache's own cachedThrough) onto the cached set. Simple
 * concatenation, not a sorted merge: the backend only ever returns rows
 * strictly newer than `since`, and the cached rows were themselves already
 * in chronological order, so appending preserves that - callers that need
 * a specific order (Trend/Timeline) already sort their own working copy
 * regardless of what order rows arrive in. */
export function mergeCachedRows(previous: Record<string, unknown>[], incoming: Record<string, unknown>[]): Record<string, unknown>[] {
  return incoming.length === 0 ? previous : [...previous, ...incoming];
}

/** Clears every cached widget result for every user - called on logout so
 * the next person to use this browser never sees a previous clinician's
 * cached clinical data. */
export function clearCompositionDataCache(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // See saveCachedBlockData - storage access failing here is never worth
    // surfacing to the user.
  }
}
