import { describe, expect, it } from 'vitest';
import {
  clearCompositionDataCache,
  compositionDataCacheKey,
  loadCachedBlockData,
  mergeCachedRows,
  saveCachedBlockData,
} from './compositionDataCache';

const params = { userId: 'u1', formId: 'form-1', blockId: 'block-1', patientId: 'p1', ehrId: 'ehr-1' };

describe('compositionDataCacheKey', () => {
  it('scopes the key per user, form, block, patient and EHR', () => {
    const key = compositionDataCacheKey(params);
    expect(key).toContain('u1');
    expect(key).toContain('form-1');
    expect(key).toContain('block-1');
    expect(key).toContain('p1');
    expect(key).toContain('ehr-1');
    // A different user must never land on the same key - that's what keeps
    // one clinician's cached clinical data from leaking to the next person
    // on a shared browser profile.
    expect(compositionDataCacheKey({ ...params, userId: 'u2' })).not.toBe(key);
  });
});

describe('save/loadCachedBlockData', () => {
  it('round-trips rows and cachedThrough', () => {
    const key = compositionDataCacheKey(params);
    saveCachedBlockData(key, { rows: [{ analyt: 'Hb', wert: 14 }], cachedThrough: 1000 });
    const loaded = loadCachedBlockData(key);
    expect(loaded?.rows).toEqual([{ analyt: 'Hb', wert: 14 }]);
    expect(loaded?.cachedThrough).toBe(1000);
  });

  it('returns undefined for a key that was never written', () => {
    expect(loadCachedBlockData(compositionDataCacheKey({ ...params, blockId: 'never-written' }))).toBeUndefined();
  });

  it('treats a corrupted entry as no cache, not a crash', () => {
    const key = compositionDataCacheKey(params);
    localStorage.setItem(key, 'not json{{{');
    expect(loadCachedBlockData(key)).toBeUndefined();
  });

  it('discards an entry older than the 24h safety-net expiry', () => {
    const key = compositionDataCacheKey(params);
    localStorage.setItem(key, JSON.stringify({ rows: [{ a: 1 }], savedAt: Date.now() - 25 * 60 * 60 * 1000 }));
    expect(loadCachedBlockData(key)).toBeUndefined();
    // Also removed, not just ignored - a later save() to the same key
    // shouldn't have to fight a lingering stale entry.
    expect(localStorage.getItem(key)).toBeNull();
  });
});

describe('mergeCachedRows', () => {
  it('appends new rows onto the previously cached set', () => {
    const previous = [{ analyt: 'Hb', wert: 14, recordedAt: '2026-08-20' }];
    const incoming = [{ analyt: 'Hb', wert: 13.8, recordedAt: '2026-08-21' }];
    expect(mergeCachedRows(previous, incoming)).toEqual([...previous, ...incoming]);
  });

  it('returns the previous rows unchanged when there is nothing new', () => {
    const previous = [{ analyt: 'Hb', wert: 14 }];
    expect(mergeCachedRows(previous, [])).toBe(previous);
  });

  it('does not duplicate a row the backend keeps re-returning because it has no usable timeColumn value', () => {
    // diffRowsSince (compositionDataDiff.ts) deliberately always re-returns
    // a row with no usable timeColumn value on every single fetch, since it
    // can never be judged "older than since" - e.g. a "Versorgungsverlauf"
    // entry whose valueColumn is `composer` (a name) rather than a number,
    // or any row with a null/unparsable recordedAt. Without dedup here,
    // that exact row would pile up as a duplicate on every refresh.
    const timelessRow = { compositionName: 'Aufnahme', composer: 'Dr. Meier', recordedAt: null };
    const previous = [timelessRow];
    // Simulates diffRowsSince re-sending it on the very next incremental fetch.
    expect(mergeCachedRows(previous, [timelessRow])).toEqual([timelessRow]);
    // A genuinely different timeless row is still added, not dropped.
    const anotherTimelessRow = { compositionName: 'Entlassung', composer: 'Dr. Weber', recordedAt: null };
    expect(mergeCachedRows(previous, [timelessRow, anotherTimelessRow])).toEqual([timelessRow, anotherTimelessRow]);
  });
});

describe('clearCompositionDataCache', () => {
  it('removes every cached entry, for every user, and nothing else', () => {
    saveCachedBlockData(compositionDataCacheKey(params), { rows: [{ a: 1 }] });
    saveCompositionDataCacheUnrelatedKey();
    clearCompositionDataCache();
    expect(loadCachedBlockData(compositionDataCacheKey(params))).toBeUndefined();
    expect(localStorage.getItem('some-unrelated-app-setting')).toBe('keep-me');
    localStorage.removeItem('some-unrelated-app-setting');
  });
});

function saveCompositionDataCacheUnrelatedKey() {
  // A key from a totally different feature (e.g. compositionViewMode: -
  // see CompositionRuntime.tsx) must survive clearCompositionDataCache(),
  // which should only ever touch its own prefix.
  localStorage.setItem('some-unrelated-app-setting', 'keep-me');
}
