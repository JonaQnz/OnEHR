const assert = require('node:assert/strict');
const test = require('node:test');
const { activationAt, applyEvents } = require('../dist/backend/src/engine/events');
const { buildTimepoints } = require('../dist/backend/src/engine/timeline');

test('activationAt: zero outside the window, ramps up/down, holds at 1 in the middle plateau', () => {
  const event = { id: 'e1', label: 'Test', startTime: '2026-01-01T00:00:00.000Z', durationIso: 'PT1H', effects: [] };
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  assert.equal(activationAt(event, start - 1000), 0, 'before the window');
  assert.equal(activationAt(event, start + 3600000 + 1000), 0, 'after the window');
  assert.equal(activationAt(event, start), 0, 'at the exact start, ramp begins at 0');
  assert.equal(activationAt(event, start + 1800000), 1, 'dead center is fully at plateau');
  const quarter = activationAt(event, start + 900000); // 25% in = end of the ramp-up
  assert.ok(quarter > 0.9, `expected ramp-up nearly complete by 25%, got ${quarter}`);
});

test('applyEvents: an offset effect nudges a track value up during its window and leaves it untouched outside', () => {
  const timepoints = [
    { timestamp: '2026-01-01T00:00:00.000Z', dueTracks: { heartRate: { type: 'heartRate', magnitude: 70 } } },
    { timestamp: '2026-01-01T00:30:00.000Z', dueTracks: { heartRate: { type: 'heartRate', magnitude: 70 } } },
    { timestamp: '2026-01-01T02:00:00.000Z', dueTracks: { heartRate: { type: 'heartRate', magnitude: 70 } } },
  ];
  const events = [{
    id: 'tachy', label: 'Tachykardie', startTime: '2026-01-01T00:15:00.000Z', durationIso: 'PT30M',
    effects: [{ track: 'heartRate', kind: 'offset', peakValue: 30 }],
  }];
  const result = applyEvents(timepoints, events);
  assert.equal(result[0].dueTracks.heartRate.magnitude, 70, 'before the event window: untouched');
  assert.ok(result[1].dueTracks.heartRate.magnitude > 70, 'inside the event window: pushed up');
  assert.equal(result[2].dueTracks.heartRate.magnitude, 70, 'well after the event window: untouched');
});

test('applyEvents: setLevel blends the value toward an absolute target at full activation', () => {
  const timepoints = [
    { timestamp: '2026-01-01T00:30:00.000Z', dueTracks: { spo2: { type: 'spo2', percent: 97 } } },
  ];
  const events = [{
    id: 'desat', label: 'Desaturation', startTime: '2026-01-01T00:00:00.000Z', durationIso: 'PT1H',
    effects: [{ track: 'spo2', kind: 'setLevel', peakValue: 86 }],
  }];
  const result = applyEvents(timepoints, events);
  // dead center = full activation (1.0) -> value should land essentially AT the target (86), not just moved toward it
  assert.ok(Math.abs(result[0].dueTracks.spo2.percent - 86) < 0.01, `expected ~86, got ${result[0].dueTracks.spo2.percent}`);
});

test('applyEvents: a dropout effect removes the track from any timepoint inside the window, never a ramped partial removal', () => {
  const timepoints = [
    { timestamp: '2026-01-01T00:00:00.000Z', dueTracks: { heartRate: { type: 'heartRate', magnitude: 70 }, spo2: { type: 'spo2', percent: 97 } } },
    { timestamp: '2026-01-01T00:15:00.000Z', dueTracks: { heartRate: { type: 'heartRate', magnitude: 70 } } },
  ];
  const events = [{
    id: 'dropout', label: 'Messausfall', startTime: '2026-01-01T00:00:00.000Z', durationIso: 'PT20M',
    effects: [{ track: 'heartRate', kind: 'dropout' }],
  }];
  const result = applyEvents(timepoints, events);
  // First timepoint: heartRate dropped, spo2 untouched (dropout only targets heartRate).
  assert.equal(result[0].dueTracks.heartRate, undefined);
  assert.equal(result[0].dueTracks.spo2.percent, 97);
  // Second timepoint had ONLY heartRate due - dropping it must remove the whole timepoint
  // (never an empty Composition), so only one timepoint should remain.
  assert.equal(result.length, 1);
});

test('applyEvents: blood pressure offset moves systolic and diastolic together, MAP/pulsePressure stay consistent', () => {
  const timepoints = [
    { timestamp: '2026-01-01T00:30:00.000Z', dueTracks: { bloodPressure: { type: 'bloodPressure', systolic: 120, diastolic: 80, map: 93.3, pulsePressure: 40 } } },
  ];
  const events = [{
    id: 'hyper', label: 'Hypertensive Spitze', startTime: '2026-01-01T00:00:00.000Z', durationIso: 'PT1H',
    effects: [{ track: 'bloodPressure', kind: 'offset', peakValue: 30 }],
  }];
  const result = applyEvents(timepoints, events);
  const bp = result[0].dueTracks.bloodPressure;
  assert.ok(bp.systolic > 120, 'systolic must rise');
  assert.ok(bp.diastolic > 80, 'diastolic must rise too (coupled)');
  assert.ok(bp.systolic > bp.diastolic + 5, 'must stay physiologically consistent (systolic clearly above diastolic)');
  assert.ok(Math.abs(bp.map - (bp.diastolic + (bp.systolic - bp.diastolic) / 3)) < 1e-9);
  assert.ok(Math.abs(bp.pulsePressure - (bp.systolic - bp.diastolic)) < 1e-9);
});

test('an event never targeting a due track leaves that timepoint completely unaffected (no accidental cross-track bleed)', () => {
  const timepoints = [
    { timestamp: '2026-01-01T00:30:00.000Z', dueTracks: { bodyTemperature: { type: 'bodyTemperature', magnitude: 36.8 } } },
  ];
  const events = [{
    id: 'tachy', label: 'Tachykardie', startTime: '2026-01-01T00:00:00.000Z', durationIso: 'PT1H',
    effects: [{ track: 'heartRate', kind: 'offset', peakValue: 30 }],
  }];
  const result = applyEvents(timepoints, events);
  assert.deepEqual(result, timepoints);
});

test('buildTimepoints applies events end-to-end (integration through the real timeline, not just applyEvents in isolation)', () => {
  const scenario = {
    id: 's', startTime: '2026-01-01T00:00:00.000Z', durationIso: 'PT2H', defaultSamplingInterval: 'PT15M', seed: 1,
    tracks: [{ id: 'hr', type: 'heartRate', signalModel: { kind: 'constant', value: 70 } }],
    events: [{
      id: 'tachy', label: 'Tachykardie', startTime: '2026-01-01T01:00:00.000Z', durationIso: 'PT30M',
      effects: [{ track: 'heartRate', kind: 'offset', peakValue: 40 }],
    }],
  };
  const timepoints = buildTimepoints(scenario);
  const at0100 = timepoints.find((tp) => tp.timestamp === '2026-01-01T01:15:00.000Z'); // dead center of the event
  assert.ok(at0100.dueTracks.heartRate.magnitude > 100, `expected a strong bump near the event's peak, got ${at0100.dueTracks.heartRate.magnitude}`);
  const before = timepoints.find((tp) => tp.timestamp === '2026-01-01T00:00:00.000Z');
  assert.equal(before.dueTracks.heartRate.magnitude, 70, 'well before the event: unaffected');
});
