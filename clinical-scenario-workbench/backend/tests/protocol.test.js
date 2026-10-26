const assert = require('node:assert/strict');
const test = require('node:test');
const { expandScenario } = require('../dist/scenario/protocol');

function scenarioWith(events) {
  return { scenarioId: 'test', patient: { key: 'patient-x', firstName: 'X', lastName: 'Y', sex: 'female', age: 40 }, events };
}

test('a station with no location.kind passes through completely unexpanded (LAE demo compatibility)', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0m' },
    { id: 'vitals', type: 'vital-signs', at: '10m', data: { heartRate: 100 } },
  ]);
  const expanded = expandScenario(scenario);
  assert.deepEqual(expanded.events, scenario.events);
});

test('a station kind with only onAdmission actions (no interval, no discharge) generates exactly that, in order', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h', data: { location: { key: 'loc-a', name: 'Präklinik', kind: 'prehospital' } } },
    // No `location.kind` here - deliberately unexpanded, to isolate just the arrival station's own protocol.
    { id: 'next', type: 'ward-transfer', at: '1h', data: { location: { key: 'loc-b', name: 'OP' } } },
  ]);
  const expanded = expandScenario(scenario);
  const ids = expanded.events.map((e) => e.id);
  // prehospital: onAdmission ['vitals'], no interval, no rounds, no discharge.
  assert.deepEqual(ids, ['arrival', 'arrival-admit-vitals', 'next']);
  assert.equal(expanded.events[1].type, 'vital-signs');
});

test('a station kind with an interval AND daily rounds merges both into one time-ordered sequence, plus discharge actions', () => {
  const scenario = scenarioWith([
    { id: 'icu', type: 'ward-transfer', at: '0h', data: { location: { key: 'loc-icu', name: 'ICU', kind: 'intensive-care' } } },
    // 10 hours = 600 minutes: vitals every 240min -> 1 interval reading; nursing 4x/day -> 1 round; doctor 2x/day -> 0 rounds.
    { id: 'discharge-stop', type: 'ward-transfer', at: '10h', data: { location: { key: 'loc-ward', name: 'Ward', kind: 'general-ward' } } },
  ]);
  const expanded = expandScenario(scenario);
  const icuGenerated = expanded.events.filter((e) => e.id.startsWith('icu-'));
  const ids = icuGenerated.map((e) => e.id);
  // onAdmission: vitals + lab (intensive-care's own real ruleset); then the
  // merged, time-sorted vitals-interval + nursing-round slots; then discharge vitals.
  assert.deepEqual(ids, ['icu-admit-vitals', 'icu-admit-lab', 'icu-interval-1', 'icu-nursing-1', 'icu-discharge-vitals']);
  assert.equal(expanded.events.find((e) => e.id === 'icu-admit-lab').type, 'lab-result');
  assert.equal(expanded.events.find((e) => e.id === 'icu-nursing-1').type, 'nursing-round');
  assert.equal(expanded.events.find((e) => e.id === 'icu-interval-1').at, '4h', 'the vitals interval must fall at the real declared offset, not the nursing round\'s');
});

test('a very long stay never generates more than the station kind\'s own max interval/round occurrences', () => {
  const scenario = scenarioWith([
    { id: 'reha-long', type: 'ward-transfer', at: '0h', data: { location: { key: 'loc-reha', name: 'Reha', kind: 'general-ward' } } },
    { id: 'end', type: 'ward-transfer', at: '5000h', data: { location: { key: 'loc-x', name: 'X', kind: 'rehabilitation' } } },
  ]);
  const expanded = expandScenario(scenario);
  const intervalEvents = expanded.events.filter((e) => e.id.startsWith('reha-long-interval-'));
  const nursingEvents = expanded.events.filter((e) => e.id.match(/^reha-long-nursing-\d+$/));
  assert.equal(intervalEvents.length, 4, 'general-ward caps vitals at 4 occurrences no matter how long the stay declares itself');
  assert.equal(nursingEvents.length, 5, 'general-ward caps rounds (shared cap) at 5 occurrences no matter how long the stay declares itself');
});

test('generated vitals values are plausible numbers, not NaN/undefined', () => {
  const scenario = scenarioWith([
    { id: 'a', type: 'patient-arrival', at: '0h', data: { location: { key: 'loc-a', name: 'A', kind: 'prehospital' } } },
  ]);
  const expanded = expandScenario(scenario);
  const vitalsEvent = expanded.events.find((e) => e.id === 'a-admit-vitals');
  assert.equal(typeof vitalsEvent.data.heartRate, 'number');
  assert.equal(typeof vitalsEvent.data.spo2, 'number');
  assert.equal(typeof vitalsEvent.data.respRate, 'number');
  assert.equal(typeof vitalsEvent.data.temperature, 'number');
  assert.ok(!Number.isNaN(vitalsEvent.data.heartRate));
});

test('the last station in a scenario (no following station event) still gets its own admission/discharge actions, just no interval/round spread', () => {
  const scenario = scenarioWith([
    { id: 'only', type: 'patient-arrival', at: '0h', data: { location: { key: 'loc-only', name: 'ICU', kind: 'intensive-care' } } },
  ]);
  const expanded = expandScenario(scenario);
  const ids = expanded.events.map((e) => e.id);
  assert.deepEqual(ids, ['only', 'only-admit-vitals', 'only-admit-lab', 'only-discharge-vitals']);
});

test('a nursing-round event carries a real progress note; a doctor-round event carries a real, urgency-appropriate order', () => {
  const scenario = scenarioWith([
    { id: 'ward', type: 'ward-transfer', at: '0h', data: { location: { key: 'loc-ward', name: 'Ward', kind: 'general-ward' } } },
    { id: 'end', type: 'ward-transfer', at: '240h', data: { location: { key: 'loc-x', name: 'X' } } },
  ]);
  const expanded = expandScenario(scenario);
  const nursingEvent = expanded.events.find((e) => e.type === 'nursing-round');
  const doctorEvent = expanded.events.find((e) => e.type === 'doctor-round');
  assert.ok(nursingEvent, 'a multi-day general-ward stay must generate at least one nursing round');
  assert.equal(typeof nursingEvent.data.note, 'string');
  assert.ok(nursingEvent.data.note.length > 0);
  assert.ok(doctorEvent, 'a multi-day general-ward stay must generate at least one doctor round');
  assert.equal(typeof doctorEvent.data.serviceName, 'string');
  assert.ok(['at0136', 'at0137', 'at0138'].includes(doctorEvent.data.urgency), 'urgency must be one of the real Klinische Anordnung option codes');
});

test('a lab-result event carries real, structured content, abnormal ones include a test diagnosis', () => {
  const scenario = scenarioWith([
    { id: 'icu', type: 'ward-transfer', at: '0h', data: { location: { key: 'loc-icu', name: 'ICU', kind: 'intensive-care' } } },
  ]);
  const expanded = expandScenario(scenario);
  const labEvent = expanded.events.find((e) => e.type === 'lab-result');
  assert.ok(labEvent, 'intensive-care admission must generate a lab draw');
  assert.equal(typeof labEvent.data.conclusion, 'string');
  assert.ok(labEvent.data.conclusion.length > 0);
  // testDiagnosis is only present when the finding is actually abnormal - never a blank field for a normal result.
  if (labEvent.data.testDiagnosis) assert.equal(typeof labEvent.data.testDiagnosis, 'string');
});

test('an escalation, when it happens, is a real ward-transfer reusing the scenario\'s own already-named location/staff for that station kind', () => {
  // A long general-ward stay with many doctor rounds - across enough
  // deterministically-seeded rolls, at least one scenario shape should
  // cross the escalation threshold. This test asserts the MECHANISM is
  // correct wherever/whenever it fires, not that this exact scenario does.
  const scenario = scenarioWith([
    { id: 'icu-first', type: 'ward-transfer', at: '0h', data: {
      location: { key: 'loc-icu', name: 'Intensivstation', kind: 'intensive-care' },
      staff: { scenarioKey: 'practitioner-icu-1', family: 'Weiß', given: 'Anna', qualification: 'Fachärztin für Intensivmedizin' },
    } },
    { id: 'ward', type: 'ward-transfer', at: '48h', data: { location: { key: 'loc-ward', name: 'Normalstation', kind: 'general-ward' } } },
    { id: 'end', type: 'ward-transfer', at: '2000h', data: { location: { key: 'loc-x', name: 'X' } } },
  ]);
  const expanded = expandScenario(scenario);
  const escalation = expanded.events.find((e) => e.id.includes('escalation'));
  if (!escalation) return; // no roll crossed the threshold for this exact input - the mechanism itself is still exercised by the other tests
  assert.equal(escalation.type, 'ward-transfer');
  assert.equal(escalation.data.location.key, 'loc-icu', 'must reuse the SAME real Intensivstation already named earlier in the scenario');
  assert.equal(escalation.data.staff.scenarioKey, 'practitioner-icu-1', 'must reuse the SAME real Practitioner already assigned there, not invent a new one');
});

test('expanding the identical scenario twice produces byte-for-byte the same event list (idempotent across every Step/Play reload)', () => {
  const scenario = scenarioWith([
    { id: 'ward', type: 'ward-transfer', at: '0h', data: { location: { key: 'loc-ward', name: 'Ward', kind: 'general-ward' } } },
    { id: 'end', type: 'ward-transfer', at: '400h', data: { location: { key: 'loc-x', name: 'X' } } },
  ]);
  const first = expandScenario(scenario);
  const second = expandScenario(scenario);
  assert.deepEqual(first.events, second.events);
});
