const assert = require('node:assert/strict');
const test = require('node:test');

// Supports the frontend's client-side composition-data cache (see
// apps/web/src/integration/compositionDataCache.ts) - POST
// /forms/:id/composition-data in formRoutes.ts uses this to serve only
// what's newer than a client-supplied `since` cursor instead of the full
// result every time.
const { rowTimeMs, diffRowsSince } = require('../dist/services/compositionDataDiff');

test('rowTimeMs reads a string or numeric timeColumn value as epoch ms', () => {
  assert.equal(rowTimeMs({ recordedAt: '2026-08-20T08:00:00Z' }, 'recordedAt'), Date.parse('2026-08-20T08:00:00Z'));
  assert.equal(rowTimeMs({ recordedAt: 1755676800000 }, 'recordedAt'), 1755676800000);
});

test('rowTimeMs returns undefined for a missing, non-date, or unparsable value', () => {
  assert.equal(rowTimeMs({}, 'recordedAt'), undefined);
  assert.equal(rowTimeMs({ recordedAt: 'not a date' }, 'recordedAt'), undefined);
  assert.equal(rowTimeMs({ recordedAt: null }, 'recordedAt'), undefined);
});

test('diffRowsSince without a timeColumn always returns every row, with no cachedThrough', () => {
  const rows = [{ a: 1 }, { a: 2 }];
  const result = diffRowsSince(rows, undefined, 500);
  assert.deepEqual(result.rows, rows);
  assert.equal(result.cachedThrough, undefined);
});

test('diffRowsSince with no `since` (first fetch) returns everything, but still computes cachedThrough', () => {
  const rows = [
    { analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' },
    { analyt: 'Hb', wert: 13.5, recordedAt: '2026-08-21T08:00:00Z' },
  ];
  const result = diffRowsSince(rows, 'recordedAt', undefined);
  assert.equal(result.rows.length, 2);
  assert.equal(result.cachedThrough, Date.parse('2026-08-21T08:00:00Z'));
});

test('diffRowsSince returns only rows strictly newer than `since`', () => {
  const older = Date.parse('2026-08-20T08:00:00Z');
  const newer = Date.parse('2026-08-21T08:00:00Z');
  const rows = [
    { analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' },
    { analyt: 'Hb', wert: 13.5, recordedAt: '2026-08-21T08:00:00Z' },
  ];
  const result = diffRowsSince(rows, 'recordedAt', older);
  assert.deepEqual(result.rows, [rows[1]]);
  // cachedThrough is the newest across the FULL input, not just what's
  // returned - the client's next cursor must not regress.
  assert.equal(result.cachedThrough, newer);
});

test('diffRowsSince returns nothing when `since` already covers every row', () => {
  const rows = [{ analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' }];
  const result = diffRowsSince(rows, 'recordedAt', Date.parse('2026-08-20T08:00:00Z'));
  assert.deepEqual(result.rows, []);
  assert.equal(result.cachedThrough, Date.parse('2026-08-20T08:00:00Z'));
});

test('diffRowsSince keeps a row with no usable time value rather than silently dropping it', () => {
  const rows = [
    { analyt: 'Hb', wert: 14, recordedAt: '2026-08-20T08:00:00Z' },
    { analyt: 'Freitext-Notiz', wert: 'siehe Anhang', recordedAt: null },
  ];
  const result = diffRowsSince(rows, 'recordedAt', Date.parse('2026-08-25T00:00:00Z'));
  assert.deepEqual(result.rows, [rows[1]]);
});
