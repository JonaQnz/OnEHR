const assert = require('node:assert/strict');
const test = require('node:test');
const { buildTimepoints } = require('../dist/backend/src/engine/timeline');

test('every track sample lands on the shared master grid, not an independently-drifting clock', () => {
  const scenario = {
    id: 's1',
    startTime: '2026-01-01T00:00:00.000Z',
    durationIso: 'PT1H',
    defaultSamplingInterval: 'PT15M',
    seed: 1,
    tracks: [
      { id: 't1', type: 'heartRate', signalModel: { kind: 'constant', value: 70 } },
      { id: 't2', type: 'bodyTemperature', signalModel: { kind: 'constant', value: 37 }, sampling: { intervalIso: 'PT30M' } },
    ],
  };
  const timepoints = buildTimepoints(scenario);
  const grid = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:15:00.000Z', '2026-01-01T00:30:00.000Z', '2026-01-01T00:45:00.000Z', '2026-01-01T01:00:00.000Z'];
  for (const tp of timepoints) assert.ok(grid.includes(tp.timestamp), `${tp.timestamp} must be on the shared grid`);

  // heartRate (15min default) is due at every grid instant.
  assert.equal(timepoints.filter((tp) => tp.dueTracks.heartRate).length, 5);
  // bodyTemperature (30min override) is due at every OTHER grid instant (00:00, 00:30, 01:00).
  const tempTimestamps = timepoints.filter((tp) => tp.dueTracks.bodyTemperature).map((tp) => tp.timestamp);
  assert.deepEqual(tempTimestamps, ['2026-01-01T00:00:00.000Z', '2026-01-01T00:30:00.000Z', '2026-01-01T01:00:00.000Z']);
});

test('a timepoint with zero due tracks is filtered out entirely, never submitted as an empty Composition', () => {
  const scenario = {
    id: 's2',
    startTime: '2026-01-01T00:00:00.000Z',
    durationIso: 'PT1H',
    defaultSamplingInterval: 'PT15M',
    seed: 1,
    tracks: [
      { id: 't1', type: 'heartRate', signalModel: { kind: 'constant', value: 70 }, sampling: { intervalIso: 'PT1H' } },
    ],
  };
  const timepoints = buildTimepoints(scenario);
  // Only due at 00:00 and 01:00 (interval == duration) - never a bare, empty 00:15/00:30/00:45 timepoint.
  assert.deepEqual(timepoints.map((tp) => tp.timestamp), ['2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z']);
  for (const tp of timepoints) assert.ok(Object.keys(tp.dueTracks).length > 0);
});

test('missingValueRate=1 drops every due sample for that track, without throwing', () => {
  const scenario = {
    id: 's3',
    startTime: '2026-01-01T00:00:00.000Z',
    durationIso: 'PT30M',
    defaultSamplingInterval: 'PT15M',
    seed: 1,
    tracks: [
      { id: 't1', type: 'heartRate', signalModel: { kind: 'constant', value: 70 }, missingValueRate: 1 },
    ],
  };
  const timepoints = buildTimepoints(scenario);
  assert.deepEqual(timepoints, []);
});

test('same scenario + same seed produces byte-identical output across two independent calls (deterministic PRNG)', () => {
  const scenario = {
    id: 's4',
    startTime: '2026-01-01T00:00:00.000Z',
    durationIso: 'PT2H',
    defaultSamplingInterval: 'PT15M',
    seed: 42,
    tracks: [
      { id: 't1', type: 'heartRate', signalModel: { kind: 'randomWalk', baseline: 75, volatility: 3, meanReversion: 0.2 }, noise: { stdDev: 2 } },
      {
        id: 't2', type: 'bloodPressure',
        signalModel: {
          kind: 'randomWalk',
          tone: { kind: 'randomWalk', volatility: 1, meanReversion: 0.1 },
          baselineSystolic: 120, baselineDiastolic: 80, systolicSensitivity: 1.5, diastolicSensitivity: 1,
        },
      },
    ],
  };
  const first = buildTimepoints(scenario);
  const second = buildTimepoints(scenario);
  assert.deepEqual(first, second);
});
