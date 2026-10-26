const assert = require('node:assert/strict');
const test = require('node:test');
const { parseIsoDurationMs, formatIsoDuration } = require('../dist/shared/isoDuration');

test('formatIsoDuration produces readable H/M output, not a raw seconds count - regression for a real bug found live ("PT69120S" in the events editor)', () => {
  assert.equal(formatIsoDuration(69120000), 'PT19H12M');
  assert.equal(formatIsoDuration(51840000), 'PT14H24M');
  assert.equal(formatIsoDuration(3600000), 'PT1H');
  assert.equal(formatIsoDuration(1800000), 'PT30M');
  assert.equal(formatIsoDuration(90000000), 'P1DT1H'); // >24h rolls into days
});

test('formatIsoDuration never emits an empty/zero duration', () => {
  assert.equal(formatIsoDuration(0), 'PT1M');
  assert.equal(formatIsoDuration(10000), 'PT1M'); // rounds up from a few seconds
});

test('formatIsoDuration output round-trips back through parseIsoDurationMs within one rounded minute', () => {
  for (const ms of [69120000, 51840000, 3600000, 1800000, 90000000, 12345000]) {
    const roundTripped = parseIsoDurationMs(formatIsoDuration(ms));
    assert.ok(Math.abs(roundTripped - ms) <= 60000, `${ms} -> ${formatIsoDuration(ms)} -> ${roundTripped}, drifted too far`);
  }
});
