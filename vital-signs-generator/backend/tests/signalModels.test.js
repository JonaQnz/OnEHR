const assert = require('node:assert/strict');
const test = require('node:test');
const { createRng } = require('../dist/backend/src/engine/rng');
const { evaluateRandomWalkSeries } = require('../dist/backend/src/engine/signalModels/randomWalk');
const { interpolateDrawnCurve } = require('../dist/backend/src/engine/signalModels/drawnCurve');
const { evaluateSignalModelSeries } = require('../dist/backend/src/engine/signalModels/index');
const { evaluateBloodPressureSeries } = require('../dist/backend/src/engine/tracks/bloodPressure');

test('random walk: stays within a bounded envelope around baseline and is smoothed (small step-to-step deltas), not i.i.d. noise', () => {
  const rng = createRng(7);
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const timestamps = Array.from({ length: 100 }, (_, i) => start + i * 60000); // 1-minute steps, 100 points
  const series = evaluateRandomWalkSeries({ baseline: 70, volatility: 2, meanReversion: 0.3 }, timestamps, rng);

  assert.equal(series[0], 70, 'first sample must start exactly at baseline');
  // Bounded envelope: with meanReversion pulling back to baseline every step, the walk should not run away.
  for (const value of series) assert.ok(Math.abs(value - 70) < 30, `value ${value} strayed too far from baseline 70`);
  // Smoothed: consecutive deltas should mostly be small relative to volatility, not wildly jumping like
  // independent random(min,max) draws would.
  const deltas = series.slice(1).map((v, i) => Math.abs(v - series[i]));
  const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  assert.ok(avgDelta < 5, `average step delta ${avgDelta} too large for a smoothed walk`);
});

test('random walk: a zero-volatility, zero-meanReversion walk stays exactly at baseline (pure determinism check)', () => {
  const rng = createRng(1);
  const timestamps = [0, 60000, 120000, 180000];
  const series = evaluateRandomWalkSeries({ baseline: 37, volatility: 0, meanReversion: 0 }, timestamps, rng);
  assert.deepEqual(series, [37, 37, 37, 37]);
});

test('drawn curve: evaluates exactly to each control point\'s own value (interpolation must pass through anchors)', () => {
  const points = [{ t: 0, value: 60 }, { t: 0.5, value: 100 }, { t: 1, value: 70 }];
  assert.equal(interpolateDrawnCurve(points, 0), 60);
  assert.equal(interpolateDrawnCurve(points, 0.5), 100);
  assert.equal(interpolateDrawnCurve(points, 1), 70);
});

test('drawn curve: a midpoint between two points is strictly between them (linear interpolation)', () => {
  const points = [{ t: 0, value: 60 }, { t: 1, value: 100 }];
  const mid = interpolateDrawnCurve(points, 0.5);
  assert.ok(mid > 60 && mid < 100);
  assert.equal(mid, 80);
});

test('drawn curve: before the first point or after the last, holds flat rather than extrapolating', () => {
  const points = [{ t: 0.2, value: 60 }, { t: 0.8, value: 100 }];
  assert.equal(interpolateDrawnCurve(points, 0), 60);
  assert.equal(interpolateDrawnCurve(points, 1), 100);
});

test('registry: constant model ignores the requested instant and always returns its fixed value', () => {
  const rng = createRng(1);
  const series = evaluateSignalModelSeries({ kind: 'constant', value: 42 }, [0, 1000, 2000], 0, 2000, rng);
  assert.deepEqual(series, [42, 42, 42]);
});

test('blood pressure: systolic and diastolic always move in the same direction for a given tone delta (coupled, not independent)', () => {
  const rng = createRng(3);
  const track = {
    id: 'bp1', type: 'bloodPressure',
    signalModel: {
      kind: 'randomWalk',
      tone: { kind: 'randomWalk', volatility: 3, meanReversion: 0.1 },
      baselineSystolic: 120, baselineDiastolic: 80, systolicSensitivity: 1.5, diastolicSensitivity: 1,
    },
  };
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const timestamps = Array.from({ length: 20 }, (_, i) => start + i * 60000);
  const series = evaluateBloodPressureSeries(track, timestamps, start, timestamps.length * 60000, rng);
  for (let i = 1; i < series.length; i += 1) {
    const sysDelta = series[i].systolic - series[i - 1].systolic;
    const diaDelta = series[i].diastolic - series[i - 1].diastolic;
    // Same sign (or one of them ~0) - never opposite directions, since both derive from one shared tone value.
    assert.ok(sysDelta * diaDelta >= -1e-9, `systolic/diastolic moved in opposite directions at step ${i}`);
  }
});

test('blood pressure: MAP and pulse pressure always match the recomputation formula from whatever systolic/diastolic the model produced', () => {
  const rng = createRng(9);
  const track = {
    id: 'bp2', type: 'bloodPressure',
    signalModel: {
      kind: 'randomWalk',
      tone: { kind: 'randomWalk', volatility: 5, meanReversion: 0.2 },
      baselineSystolic: 130, baselineDiastolic: 85, systolicSensitivity: 2, diastolicSensitivity: 1.2,
    },
    noise: { stdDev: 1 },
  };
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const timestamps = Array.from({ length: 15 }, (_, i) => start + i * 60000);
  const series = evaluateBloodPressureSeries(track, timestamps, start, timestamps.length * 60000, rng);
  for (const sample of series) {
    assert.ok(Math.abs(sample.map - (sample.diastolic + (sample.systolic - sample.diastolic) / 3)) < 1e-9);
    assert.ok(Math.abs(sample.pulsePressure - (sample.systolic - sample.diastolic)) < 1e-9);
  }
});
