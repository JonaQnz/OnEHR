const assert = require('node:assert/strict');
const test = require('node:test');
const { PRESET_LIBRARY, applyPreset } = require('../dist/shared/presets');
const { buildTimepoints } = require('../dist/backend/src/engine/timeline');

const baseScenario = {
  id: 's', name: 'Test', startTime: '2026-01-01T00:00:00.000Z', durationIso: 'PT24H',
  defaultSamplingInterval: 'PT15M', seed: 1, tracks: [],
};

test('three presets are registered: stabiler Patient, postoperativer Verlauf, akute Verschlechterung', () => {
  const ids = PRESET_LIBRARY.map((p) => p.id);
  assert.deepEqual(ids, ['stable-patient', 'postoperative-course', 'acute-deterioration']);
});

test('applyPreset keeps the scenario\'s own id/startTime/duration/seed untouched, only swaps tracks+events', () => {
  const preset = PRESET_LIBRARY.find((p) => p.id === 'stable-patient');
  const result = applyPreset(baseScenario, preset);
  assert.equal(result.id, baseScenario.id);
  assert.equal(result.startTime, baseScenario.startTime);
  assert.equal(result.durationIso, baseScenario.durationIso);
  assert.equal(result.seed, baseScenario.seed);
  assert.equal(result.tracks.length, 5, 'all 5 vital-sign tracks');
  assert.deepEqual(result.events, []);
});

test('a percent-based event offset resolves relative to the ACTUAL scenario duration, not a fixed absolute time', () => {
  const preset = PRESET_LIBRARY.find((p) => p.id === 'acute-deterioration');
  const short = applyPreset({ ...baseScenario, durationIso: 'PT10H' }, preset);
  const long = applyPreset({ ...baseScenario, durationIso: 'PT100H' }, preset);
  const feverShort = short.events.find((e) => e.label === 'Fieberanstieg');
  const feverLong = long.events.find((e) => e.label === 'Fieberanstieg');
  // 40% into 10h vs 40% into 100h must land at genuinely different absolute timestamps.
  assert.notEqual(feverShort.startTime, feverLong.startTime);
  const startMs = Date.parse(baseScenario.startTime);
  assert.equal(Date.parse(feverShort.startTime) - startMs, 10 * 3600000 * 0.4);
  assert.equal(Date.parse(feverLong.startTime) - startMs, 100 * 3600000 * 0.4);
});

test('every preset resolves to real ISO timestamps/durations that buildTimepoints can actually consume end-to-end', () => {
  for (const preset of PRESET_LIBRARY) {
    const scenario = applyPreset(baseScenario, preset);
    const timepoints = buildTimepoints(scenario);
    assert.ok(timepoints.length > 0, `${preset.id} must produce at least one timepoint`);
    for (const tp of timepoints) assert.ok(Object.keys(tp.dueTracks).length > 0, `${preset.id}: no empty timepoints allowed`);
  }
});

test('acute-deterioration: body temperature is still near its fevered peak at the very end of the scenario (does not fully recover)', () => {
  const preset = PRESET_LIBRARY.find((p) => p.id === 'acute-deterioration');
  const scenario = applyPreset(baseScenario, preset);
  const timepoints = buildTimepoints(scenario);
  const last = timepoints[timepoints.length - 1];
  const temp = last.dueTracks.bodyTemperature?.magnitude;
  assert.ok(temp !== undefined && temp > 38, `expected the scenario to end still febrile, got ${temp}`);
});

test('acute-deterioration: SpO2 and heart rate are STILL in crisis at the very end too (not just temperature), regardless of scenario length - regression for a real bug found live where fixed-duration crisis events fully resolved before a normal-length scenario ended', () => {
  const preset = PRESET_LIBRARY.find((p) => p.id === 'acute-deterioration');
  for (const durationIso of ['PT6H', 'PT24H', 'PT72H']) {
    const scenario = applyPreset({ ...baseScenario, durationIso }, preset);
    const timepoints = buildTimepoints(scenario);
    const last = timepoints[timepoints.length - 1];
    const spo2 = last.dueTracks.spo2?.percent;
    const hr = last.dueTracks.heartRate?.magnitude;
    assert.ok(spo2 !== undefined && spo2 < 92, `${durationIso}: expected SpO2 still desaturated at scenario end, got ${spo2}`);
    assert.ok(hr !== undefined && hr > 90, `${durationIso}: expected heart rate still elevated at scenario end, got ${hr}`);
  }
});

test('postoperative-course: heart rate trends down over the scenario (drawn-curve recovery), not flat/random', () => {
  const preset = PRESET_LIBRARY.find((p) => p.id === 'postoperative-course');
  const scenario = applyPreset(baseScenario, preset);
  const timepoints = buildTimepoints(scenario);
  const first = timepoints[0].dueTracks.heartRate.magnitude;
  const last = timepoints[timepoints.length - 1].dueTracks.heartRate.magnitude;
  assert.ok(first > last, `expected heart rate to trend down from ${first} to ${last}`);
});
