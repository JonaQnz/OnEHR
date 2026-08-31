/**
 * Supports the frontend's client-side composition-data cache (see
 * apps/web/src/integration/compositionDataCache.ts): narrows a freshly
 * fetched full row set down to only what's newer than a client-supplied
 * `since` cursor, when the block has a timeColumn to compare rows by.
 *
 * This never skips the underlying EHRbase/AQL query itself - callers still
 * fetch the full result every time (AQL is arbitrary, author-written text,
 * not something this can safely rewrite a WHERE clause into) - it only
 * shrinks what crosses the wire back to the browser on a warm cache.
 */

/** Reads a row's timeColumn value as a comparable epoch-ms number, the same
 * way the frontend's own `date()` helper in WidgetDataCard.tsx does. */
export function rowTimeMs(row: Record<string, unknown>, timeColumn: string): number | undefined {
  const value = row[timeColumn];
  const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface DiffedRows {
  rows: Record<string, unknown>[];
  /** Newest timeColumn value (epoch ms) across the FULL input set, not just
   * what's returned - undefined when there's no timeColumn to compare by,
   * or no row had a usable value for it. The client advances its next
   * `since` cursor to this, regardless of how few rows came back. */
  cachedThrough: number | undefined;
}

/** `timeColumn` undefined means the block has nothing to diff by - every
 * row is always returned, `cachedThrough` stays undefined (the cache is
 * then a pure "paint instantly from the last full fetch", no incremental
 * fetching). `since` undefined means "first fetch, nothing cached yet" -
 * every row is returned, but cachedThrough is still computed so the caller
 * can start caching from this very response. */
export function diffRowsSince(rows: Record<string, unknown>[], timeColumn: string | undefined, since: number | undefined): DiffedRows {
  if (!timeColumn) return { rows, cachedThrough: undefined };
  const times = rows.map((row) => rowTimeMs(row, timeColumn)).filter((value): value is number => value !== undefined);
  const cachedThrough = times.length > 0 ? Math.max(...times) : undefined;
  if (since === undefined) return { rows, cachedThrough };
  // A row with no usable time value at all can't be judged "old" or "new" -
  // kept rather than silently dropped, same as before this endpoint could
  // diff at all.
  const filtered = rows.filter((row) => { const time = rowTimeMs(row, timeColumn); return time === undefined || time > since; });
  return { rows: filtered, cachedThrough };
}
