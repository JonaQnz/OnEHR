/** Minimal ISO-8601 duration parser - just enough for the scenario's own
 * inputs (e.g. "PT15M", "PT4H", "PT24H", "P1D"), not a general-purpose
 * implementation. Weeks/months/years are deliberately unsupported (a
 * demo-data scenario's duration/sampling is always hours-to-days).
 *
 * Lives in shared/ (not backend/src/engine/) so the frontend can use the
 * exact same parser for chart display (e.g. shading an event's time
 * window) as the engine uses for real timeline math - one parser, not two
 * that could quietly drift apart. */
export function parseIsoDurationMs(iso: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso.trim());
  if (!match) throw new Error(`Unsupported ISO-8601 duration: "${iso}"`);
  const [, days, hours, minutes, seconds] = match;
  const totalMs =
    Number(days || 0) * 86400000 +
    Number(hours || 0) * 3600000 +
    Number(minutes || 0) * 60000 +
    Number(seconds || 0) * 1000;
  if (totalMs <= 0) throw new Error(`ISO-8601 duration must be positive: "${iso}"`);
  return totalMs;
}

/** The inverse of parseIsoDurationMs, formatted with the largest sensible
 * units (days/hours/minutes/seconds) rather than always a raw seconds
 * count - a percent-of-scenario-duration event (see shared/presets.ts'
 * resolveOffset) resolves to an arbitrary millisecond count that would
 * otherwise render as something like "PT69120S" in the events editor,
 * technically valid but unreadable and, confirmed live, reads as broken
 * even though the underlying value is correct. Minutes are rounded (a
 * demo scenario never needs sub-minute precision on an event's own
 * duration), so this is intentionally lossy for very short/odd durations
 * - fine for its one real caller. */
export function formatIsoDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days === 0 && hours === 0 && minutes === 0) return 'PT1M'; // never emit an empty/zero duration
  let result = 'P';
  if (days > 0) result += `${days}D`;
  if (hours > 0 || minutes > 0) {
    result += 'T';
    if (hours > 0) result += `${hours}H`;
    if (minutes > 0) result += `${minutes}M`;
  }
  return result;
}
