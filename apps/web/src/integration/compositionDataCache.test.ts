import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateCompositionDataCacheScope,
  clearCompositionDataCache,
  compositionDataCacheKey,
  compositionSessionScope,
  loadCachedBlockData,
  purgeLegacyCompositionDataCache,
  saveCachedBlockData,
} from './compositionDataCache';

const context = { sessionScope: 'local::u1', formId: 'form-1', blockId: 'block-1', patientId: 'p1', namespace: 'ns-1', ehrId: 'ehr-1' };

beforeEach(() => {
  activateCompositionDataCacheScope(context.sessionScope);
});

afterEach(() => {
  clearCompositionDataCache();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('compositionDataCacheKey', () => {
  it('scopes the key per authenticated session and the full clinical context', () => {
    const key = compositionDataCacheKey(context);
    expect(key).toContain('u1');
    expect(key).toContain('form-1');
    expect(key).toContain('block-1');
    expect(key).toContain('p1');
    expect(key).toContain('ns-1');
    expect(key).toContain('ehr-1');
    // A different authenticated session, patient, namespace or EHR id must
    // never land on the same key - the same patient id can exist in more
    // than one namespace, and a shared browser profile must not leak one
    // clinician's rows to the next.
    expect(compositionDataCacheKey({ ...context, sessionScope: 'local::u2' })).not.toBe(key);
    expect(compositionDataCacheKey({ ...context, patientId: 'p2' })).not.toBe(key);
    expect(compositionDataCacheKey({ ...context, namespace: 'ns-2' })).not.toBe(key);
    expect(compositionDataCacheKey({ ...context, ehrId: 'ehr-2' })).not.toBe(key);
  });
});

describe('compositionSessionScope', () => {
  it('separates users and auth sources, and collapses to anonymous without auth', () => {
    const localUser = compositionSessionScope({ authenticated: true, mode: 'local', user: { id: 'u1', authSource: 'local' } });
    expect(compositionSessionScope({ authenticated: true, mode: 'local', user: { id: 'u2', authSource: 'local' } })).not.toBe(localUser);
    expect(compositionSessionScope({ authenticated: true, mode: 'hip', user: { id: 'u1', authSource: 'hip' } })).not.toBe(localUser);
    expect(compositionSessionScope({ authenticated: false, mode: 'local', user: { id: 'u1', authSource: 'local' } })).toBe('anonymous');
    expect(compositionSessionScope({ authenticated: true, mode: 'local' })).toBe('anonymous');
  });
});

describe('in-memory save/load', () => {
  it('round-trips rows without writing to localStorage', () => {
    saveCachedBlockData(context, { rows: [{ analyt: 'Hb', wert: 14 }] });
    expect(loadCachedBlockData(context)?.rows).toEqual([{ analyt: 'Hb', wert: 14 }]);
    expect(localStorage.length).toBe(0);
  });

  it('returns undefined for a context that was never written', () => {
    expect(loadCachedBlockData({ ...context, blockId: 'never-written' })).toBeUndefined();
  });

  it('replaces rows completely instead of merging them', () => {
    saveCachedBlockData(context, { rows: [{ analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' }] });
    saveCachedBlockData(context, { rows: [{ analyt: 'Hb', wert: 14.2, recordedAt: '2026-08-20T08:00:00Z' }] });
    // A corrected value with an unchanged timestamp must replace the cached
    // row - merging would keep the stale 14 around forever.
    expect(loadCachedBlockData(context)?.rows).toEqual([{ analyt: 'Hb', wert: 14.2, recordedAt: '2026-08-20T08:00:00Z' }]);
  });
});

describe('scope invalidation (logout, identity switch, auth loss)', () => {
  it('drops every entry on logout/clear and refuses writes while logged out', () => {
    saveCachedBlockData(context, { rows: [{ a: 1 }] });
    clearCompositionDataCache();
    expect(loadCachedBlockData(context)).toBeUndefined();
    // A response from before the logout must not refill the cache.
    saveCachedBlockData(context, { rows: [{ a: 2 }] });
    activateCompositionDataCacheScope(context.sessionScope);
    expect(loadCachedBlockData(context)).toBeUndefined();
  });

  it('does not expose the previous user\'s rows after an identity switch', () => {
    saveCachedBlockData(context, { rows: [{ owner: 'u1' }] });
    activateCompositionDataCacheScope('local::u2');
    expect(loadCachedBlockData(context)).toBeUndefined();
    // A late response from the old user's request cannot refill the cache
    // under the new identity.
    saveCachedBlockData(context, { rows: [{ owner: 'late-u1' }] });
    activateCompositionDataCacheScope(context.sessionScope);
    expect(loadCachedBlockData(context)).toBeUndefined();
  });
});

describe('purgeLegacyCompositionDataCache', () => {
  it('removes only old persisted cache keys, without reading their payloads', () => {
    const legacyKey = 'formbuilder:compositionDataCache:v1:u1:form-1:block-1:p1:ehr-1';
    localStorage.setItem(legacyKey, 'not json - a legacy clinical payload that must never be parsed');
    localStorage.setItem('formbuilder:compositionDataCache:v1:u2:other', '{"rows":[{"analyt":"Hb","wert":14}]}');
    localStorage.setItem('some-unrelated-app-setting', 'keep-me');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');

    purgeLegacyCompositionDataCache();

    // The purge itself never called getItem() for a legacy key - our own
    // assertions below are the only reads, and they happen after this check.
    expect(getItem.mock.calls.some(([key]) => String(key).startsWith('formbuilder:compositionDataCache:v1:'))).toBe(false);
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(localStorage.getItem('formbuilder:compositionDataCache:v1:u2:other')).toBeNull();
    expect(localStorage.getItem('some-unrelated-app-setting')).toBe('keep-me');
  });
});
