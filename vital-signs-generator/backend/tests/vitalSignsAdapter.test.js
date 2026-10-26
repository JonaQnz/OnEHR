const assert = require('node:assert/strict');
const test = require('node:test');
const { vitalSignsAdapter, FIELD_IDS } = require('../dist/backend/src/engine/openehrAdapter/vitalSignsAdapter');

const scenario = { id: 's', startTime: '2026-01-01T00:00:00.000Z', durationIso: 'PT1H', defaultSamplingInterval: 'PT15M', tracks: [] };

test('adapter ids match the Vitalzeichen Form Section published in Phase 1', () => {
  assert.equal(vitalSignsAdapter.formSectionId, '61730ea9-284d-458f-b173-47902d0a7c90');
  assert.equal(vitalSignsAdapter.compositionFormId, 'b82c488f-688a-49d2-8031-447a0440d098');
  assert.equal(vitalSignsAdapter.blockId, 'vitals_block');
});

test('all five tracks due: produces exactly the expected field ids with the correct runtime shapes', () => {
  const timepoint = {
    timestamp: '2026-01-01T00:15:00.000Z',
    dueTracks: {
      heartRate: { type: 'heartRate', magnitude: 78 },
      respirationRate: { type: 'respirationRate', magnitude: 16 },
      spo2: { type: 'spo2', percent: 97.5 },
      bodyTemperature: { type: 'bodyTemperature', magnitude: 36.8 },
      bloodPressure: { type: 'bloodPressure', systolic: 122, diastolic: 80, map: 94, pulsePressure: 42 },
    },
  };
  const values = vitalSignsAdapter.toFormSessionValues(timepoint, scenario);

  assert.deepEqual(values, {
    [FIELD_IDS.contextStartTime]: '2026-01-01T00:15:00.000Z',
    [FIELD_IDS.heartRate.value]: { magnitude: 78, unit: '/min' },
    [FIELD_IDS.heartRate.time]: '2026-01-01T00:15:00.000Z',
    [FIELD_IDS.respirationRate.value]: { magnitude: 16, unit: '/min' },
    [FIELD_IDS.respirationRate.time]: '2026-01-01T00:15:00.000Z',
    [FIELD_IDS.spo2.value]: { numerator: 97.5 },
    [FIELD_IDS.spo2.time]: '2026-01-01T00:15:00.000Z',
    [FIELD_IDS.bodyTemperature.value]: { magnitude: 36.8, unit: 'Cel' },
    [FIELD_IDS.bodyTemperature.time]: '2026-01-01T00:15:00.000Z',
    [FIELD_IDS.bloodPressure.systolic]: { magnitude: 122, unit: 'mm[Hg]' },
    [FIELD_IDS.bloodPressure.diastolic]: { magnitude: 80, unit: 'mm[Hg]' },
    [FIELD_IDS.bloodPressure.map]: { magnitude: 94, unit: 'mm[Hg]' },
    [FIELD_IDS.bloodPressure.pulsePressure]: { magnitude: 42, unit: 'mm[Hg]' },
    [FIELD_IDS.bloodPressure.time]: '2026-01-01T00:15:00.000Z',
  });
});

test('only 2 of 5 tracks due: the other three tracks\' field ids are entirely absent, never submitted as null/zero', () => {
  const timepoint = {
    timestamp: '2026-01-01T00:30:00.000Z',
    dueTracks: {
      heartRate: { type: 'heartRate', magnitude: 80 },
      bodyTemperature: { type: 'bodyTemperature', magnitude: 37.1 },
    },
  };
  const values = vitalSignsAdapter.toFormSessionValues(timepoint, scenario);
  const keys = Object.keys(values);

  assert.ok(keys.includes(FIELD_IDS.heartRate.value));
  assert.ok(keys.includes(FIELD_IDS.bodyTemperature.value));
  for (const absentId of [
    FIELD_IDS.respirationRate.value, FIELD_IDS.respirationRate.time,
    FIELD_IDS.spo2.value, FIELD_IDS.spo2.time,
    FIELD_IDS.bloodPressure.systolic, FIELD_IDS.bloodPressure.diastolic,
    FIELD_IDS.bloodPressure.map, FIELD_IDS.bloodPressure.pulsePressure, FIELD_IDS.bloodPressure.time,
  ]) {
    assert.ok(!keys.includes(absentId), `${absentId} must be absent, not present as null/zero`);
  }
  // context_start_time is always present - it's the Composition-wide timestamp, not per-track.
  assert.equal(values[FIELD_IDS.contextStartTime], '2026-01-01T00:30:00.000Z');
});

test('zero tracks due: only context_start_time is set', () => {
  const timepoint = { timestamp: '2026-01-01T00:45:00.000Z', dueTracks: {} };
  const values = vitalSignsAdapter.toFormSessionValues(timepoint, scenario);
  assert.deepEqual(values, { [FIELD_IDS.contextStartTime]: '2026-01-01T00:45:00.000Z' });
});
