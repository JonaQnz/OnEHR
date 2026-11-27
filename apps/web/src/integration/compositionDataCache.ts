/**
 * Client-side cache for Composition data-widget results (lab values,
 * medication, timeline/matrix entries, ...).
 *
 * Deliberately an in-memory cache, not localStorage: clinical rows must not
 * survive a reload or a browser profile handover. It is scoped twice:
 *
 * - by the authenticated session (user id + auth source + auth mode), so a
 *   shared browser profile used by more than one clinician never surfaces
 *   one user's cached rows to another, and
 * - by the full clinical context (form, block, patient, namespace, EHR id),
 *   because the same patient id can exist in more than one namespace.
 *
 * The cache is invalidated on logout, identity switch and auth loss (see
 * App.tsx's AuthGate/logout wiring). On startup only the old persisted v1
 * keys are removed from localStorage; their clinical payloads are never
 * read or parsed (purgeLegacyCompositionDataCache()).
 *
 * Every fetch replaces a block's cached rows completely - it does not merge
 * them with what was there before. That deliberately re-transfers the whole
 * widget result on every load (a larger transfer volume than the earlier
 * `since` cursor approach), but guarantees that corrected values with an
 * unchanged timestamp still become visible and that rows removed server-side
 * disappear instead of lingering in the cache.
 */

const PREFIX = 'formbuilder:compositionDataCache:v1:';
// Defensive only - bounds how long a genuinely abandoned in-memory entry
// survives in a long-lived tab (e.g. after a patient's data widget hasn't
// been reopened for a long time).
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface CachedBlockData {
  rows: Record<string, unknown>[];
  savedAt: number;
}

export interface CompositionDataCacheContext {
  /** Stable identity of the authenticated session (see compositionSessionScope). */
  sessionScope: string;
  formId: string;
  blockId: string;
  patientId: string;
  namespace?: string;
  ehrId?: string;
}

interface CompositionDataCacheAuth {
  authenticated: boolean;
  mode: string;
  user?: { id?: string; authSource?: string };
}

/**
 * Stable key for "who is logged in". Includes authSource/mode so the same
 * user id via a different auth path (e.g. local vs. HIP) is treated as a
 * different session, and collapses to 'anonymous' as soon as authentication
 * is lost.
 */
export function compositionSessionScope(auth: CompositionDataCacheAuth): string {
  if (!auth.authenticated || !auth.user?.id) return 'anonymous';
  return `${auth.mode}:${auth.user.authSource || ''}:${auth.user.id}`;
}

let activeSessionScope: string | null = null;
const entries = new Map<string, CachedBlockData>();

/**
 * Marks which authenticated session may currently read/write the cache.
 * A change of identity (or a logout that clears the scope) drops every
 * entry, so neither a late response from the previous session nor a later
 * re-login can surface data cached under the old identity.
 */
export function activateCompositionDataCacheScope(sessionScope: string): void {
  if (activeSessionScope === sessionScope) return;
  activeSessionScope = sessionScope;
  entries.clear();
}

export function compositionDataCacheKey(context: CompositionDataCacheContext): string {
  return [
    context.sessionScope,
    context.formId,
    context.blockId,
    context.patientId,
    context.namespace || '',
    context.ehrId || '',
  ].map((part) => encodeURIComponent(part)).join(':');
}

export function loadCachedBlockData(context: CompositionDataCacheContext): CachedBlockData | undefined {
  if (activeSessionScope !== context.sessionScope) return undefined;
  const entry = entries.get(compositionDataCacheKey(context));
  if (!entry) return undefined;
  if (Date.now() - entry.savedAt > MAX_AGE_MS) {
    entries.delete(compositionDataCacheKey(context));
    return undefined;
  }
  return entry;
}

export function saveCachedBlockData(context: CompositionDataCacheContext, data: { rows: Record<string, unknown>[] }): void {
  // A response that arrives after logout/identity switch must not refill the
  // cache under its old scope.
  if (activeSessionScope !== context.sessionScope) return;
  entries.set(compositionDataCacheKey(context), { rows: data.rows, savedAt: Date.now() });
}

/** Clears the in-memory cache and the active scope - logout, identity
 * switch and auth loss never leave the next person's session with the
 * previous clinician's rows. */
export function clearCompositionDataCache(): void {
  entries.clear();
  activeSessionScope = null;
}

/**
 * Removes only the old persisted v1 cache keys at the known prefix. Uses
 * key()/removeItem() exclusively - it never reads (getItem) or parses a
 * persisted clinical payload. Called once at app startup.
 */
export function purgeLegacyCompositionDataCache(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {
    // Storage unavailable (private browsing, disabled) - nothing persisted
    // to clean up, and a startup failure is never worth surfacing.
  }
}
