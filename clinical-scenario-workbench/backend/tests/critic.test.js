const assert = require('node:assert/strict');
const test = require('node:test');
const { critiqueScenario } = require('../dist/critic/rules');

function scenarioWith(events) {
  return { scenarioId: 'test', patient: { key: 'patient-x', firstName: 'X', lastName: 'Y', sex: 'female', age: 40 }, events };
}

test('a scenario with a patient-arrival always gets a missing-allergy-history finding anchored to it', () => {
  const scenario = scenarioWith([{ id: 'arrival', type: 'patient-arrival', at: '0h' }]);
  const findings = critiqueScenario(scenario);
  const finding = findings.find((f) => f.code === 'missing-allergy-history');
  assert.ok(finding, 'no capability captures allergy/medication history yet - this must always fire');
  assert.equal(finding.anchorEventId, 'arrival');
});

test('a surgery-kind station with no procedure event before the next station gets both missing-consent and missing-procedure-record', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'op', type: 'ward-transfer', at: '1h', data: { location: { key: 'loc-op', name: 'OP', kind: 'surgery' } } },
    { id: 'ward', type: 'ward-transfer', at: '3h', data: { location: { key: 'loc-ward', name: 'Ward' } } },
  ]);
  const findings = critiqueScenario(scenario);
  const consent = findings.find((f) => f.code === 'missing-consent:op');
  const procedure = findings.find((f) => f.code === 'missing-procedure-record:op');
  assert.ok(consent, 'no consent capability exists anywhere - must always fire for a surgery station');
  assert.equal(consent.anchorEventId, 'op', 'consent is missing right at the OP itself, not later');
  assert.ok(procedure, 'no procedure event was authored between OP and the next station');
  assert.equal(procedure.anchorEventId, 'ward', 'only known once we reach the NEXT station, retrospectively');
});

test('a surgery-kind station WITH a real procedure event in between does not get missing-procedure-record (but still gets missing-consent)', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'op', type: 'ward-transfer', at: '1h', data: { location: { key: 'loc-op', name: 'OP', kind: 'surgery' } } },
    { id: 'op-procedure', type: 'procedure', at: '1h20m', data: { procedureName: 'Appendektomie' } },
    { id: 'ward', type: 'ward-transfer', at: '3h', data: { location: { key: 'loc-ward', name: 'Ward' } } },
  ]);
  const findings = critiqueScenario(scenario);
  assert.equal(findings.find((f) => f.code === 'missing-procedure-record:op'), undefined, 'a real procedure event was authored - this gap is closed');
  assert.ok(findings.find((f) => f.code === 'missing-consent:op'), 'consent is a separate, still-unmodeled gap - must still fire');
});

test('a request-imaging event that opts in (expectsDiagnosticReport) with no following diagnostic-report gets flagged once the next station is reached', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'scan', type: 'request-imaging', at: '30m', data: { serviceName: 'Sonographie Abdomen', expectsDiagnosticReport: true } },
    { id: 'op', type: 'ward-transfer', at: '1h', data: { location: { key: 'loc-op', name: 'OP' } } },
  ]);
  const findings = critiqueScenario(scenario);
  const finding = findings.find((f) => f.code === 'missing-diagnostic-report:scan');
  assert.ok(finding, 'expectsDiagnosticReport was true but no diagnostic-report event followed');
  assert.equal(finding.anchorEventId, 'op');
});

test('a request-imaging event that opts in AND is followed by a real diagnostic-report is not flagged', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'scan', type: 'request-imaging', at: '30m', data: { serviceName: 'Sonographie Abdomen', expectsDiagnosticReport: true } },
    { id: 'finding', type: 'diagnostic-report', at: '45m', data: { studyName: 'Sonographie Abdomen' } },
    { id: 'op', type: 'ward-transfer', at: '1h', data: { location: { key: 'loc-op', name: 'OP' } } },
  ]);
  const findings = critiqueScenario(scenario);
  assert.equal(findings.find((f) => f.code === 'missing-diagnostic-report:scan'), undefined);
});

test('a request-imaging event that never opts in (no expectsDiagnosticReport) is never checked at all - e.g. a pure scheduling booking', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'op-scheduling', type: 'request-imaging', at: '30m', data: { serviceName: 'OP-Planung' } },
    { id: 'op', type: 'ward-transfer', at: '1h', data: { location: { key: 'loc-op', name: 'OP' } } },
  ]);
  const findings = critiqueScenario(scenario);
  assert.equal(findings.some((f) => f.code.startsWith('missing-diagnostic-report')), false);
});

test('the scenario\'s own last event gets all three discharge-time findings when nothing was ever written for any of them', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'discharge', type: 'ward-transfer', at: '5h', data: { location: { key: 'loc-home', name: 'Zuhause' } } },
  ]);
  const findings = critiqueScenario(scenario);
  for (const code of ['missing-discharge-letter', 'missing-followup-appointment', 'missing-discharge-medication']) {
    const finding = findings.find((f) => f.code === code);
    assert.ok(finding, `expected ${code}`);
    assert.equal(finding.anchorEventId, 'discharge');
  }
});

test('an ambulatory encounter (arrival classCode "AMB") never gets the three discharge-time findings - it was never "discharged" in the first place', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h', data: { classCode: 'AMB' } },
    { id: 'confirmed-diagnosis', type: 'coded-diagnosis', at: '1h', data: { diagnosisName: 'Routine', icdCode: 'Z00.0' } },
  ]);
  const findings = critiqueScenario(scenario);
  for (const code of ['missing-discharge-letter', 'missing-followup-appointment', 'missing-discharge-medication']) {
    assert.equal(findings.find((f) => f.code === code), undefined, `${code} should not fire for an ambulatory encounter`);
  }
  // missing-coded-diagnosis stays unconditional - real here since one was recorded.
  assert.equal(findings.find((f) => f.code === 'missing-coded-diagnosis'), undefined);
  // missing-allergy-history is unrelated to ambulatory/stationary and still fires.
  assert.ok(findings.find((f) => f.code === 'missing-allergy-history'));
});

test('a real discharge-letter event anywhere in the scenario closes missing-discharge-letter (but not the other two - no capability models them yet)', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'letter', type: 'discharge-letter', at: '4h55m', data: { synopsis: 'x'.repeat(80) } },
    { id: 'discharge', type: 'ward-transfer', at: '5h', data: { location: { key: 'loc-home', name: 'Zuhause' } } },
  ]);
  const findings = critiqueScenario(scenario);
  assert.equal(findings.find((f) => f.code === 'missing-discharge-letter'), undefined);
  assert.ok(findings.find((f) => f.code === 'missing-followup-appointment'));
});

test('a real request-imaging booking with isFollowUp:true anywhere closes missing-followup-appointment', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'followup', type: 'request-imaging', at: '4h50m', data: { serviceName: 'Kardiologische Nachsorge', isFollowUp: true } },
    { id: 'discharge', type: 'ward-transfer', at: '5h', data: { location: { key: 'loc-home', name: 'Zuhause' } } },
  ]);
  const findings = critiqueScenario(scenario);
  assert.equal(findings.find((f) => f.code === 'missing-followup-appointment'), undefined);
});

test('a request-imaging booking WITHOUT isFollowUp does not close missing-followup-appointment (e.g. the original imaging/OP booking itself)', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'scan', type: 'request-imaging', at: '1h', data: { serviceName: 'CT-Diagnostik' } },
    { id: 'discharge', type: 'ward-transfer', at: '5h', data: { location: { key: 'loc-home', name: 'Zuhause' } } },
  ]);
  const findings = critiqueScenario(scenario);
  assert.ok(findings.find((f) => f.code === 'missing-followup-appointment'));
});

test('a real discharge-medication event anywhere closes missing-discharge-medication', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'meds', type: 'discharge-medication', at: '4h55m', data: { medicationName: 'ASS 100mg' } },
    { id: 'discharge', type: 'ward-transfer', at: '5h', data: { location: { key: 'loc-home', name: 'Zuhause' } } },
  ]);
  const findings = critiqueScenario(scenario);
  assert.equal(findings.find((f) => f.code === 'missing-discharge-medication'), undefined);
});

test('missing-coded-diagnosis fires at the last event when no coded-diagnosis event is anywhere in the scenario', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'discharge', type: 'ward-transfer', at: '5h', data: { location: { key: 'loc-home', name: 'Zuhause' } } },
  ]);
  const findings = critiqueScenario(scenario);
  const finding = findings.find((f) => f.code === 'missing-coded-diagnosis');
  assert.ok(finding);
  assert.equal(finding.anchorEventId, 'discharge');
});

test('a real coded-diagnosis event anywhere closes missing-coded-diagnosis (capability/catalog.ts: "Diagnose (Basis)", live-verified)', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'diagnosis', type: 'coded-diagnosis', at: '1h', data: { diagnosisName: 'Lungenembolie', icdCode: 'I26.9' } },
    { id: 'discharge', type: 'ward-transfer', at: '5h', data: { location: { key: 'loc-home', name: 'Zuhause' } } },
  ]);
  const findings = critiqueScenario(scenario);
  assert.equal(findings.find((f) => f.code === 'missing-coded-diagnosis'), undefined);
});

test('a surgery-kind station with no medication-administration on record beforehand gets missing-preprocedure-medication, anchored right at the station itself', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'op', type: 'ward-transfer', at: '1h', data: { location: { key: 'loc-op', name: 'Herzkatheterlabor', kind: 'surgery' } } },
  ]);
  const findings = critiqueScenario(scenario);
  const finding = findings.find((f) => f.code === 'missing-preprocedure-medication:op');
  assert.ok(finding);
  assert.equal(finding.anchorEventId, 'op');
});

test('a surgery-kind station WITH a medication-administration already on record beforehand does not get missing-preprocedure-medication', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'aspirin', type: 'medication-administration', at: '30m', data: { arzneimittel: 'ASS 300mg' } },
    { id: 'op', type: 'ward-transfer', at: '1h', data: { location: { key: 'loc-op', name: 'Herzkatheterlabor', kind: 'surgery' } } },
  ]);
  const findings = critiqueScenario(scenario);
  assert.equal(findings.find((f) => f.code === 'missing-preprocedure-medication:op'), undefined);
});

test('critiqueScenario is a pure function - calling it twice on the identical scenario returns byte-for-byte the same findings', () => {
  const scenario = scenarioWith([
    { id: 'arrival', type: 'patient-arrival', at: '0h' },
    { id: 'op', type: 'ward-transfer', at: '1h', data: { location: { key: 'loc-op', name: 'OP', kind: 'surgery' } } },
    { id: 'discharge', type: 'ward-transfer', at: '3h', data: { location: { key: 'loc-home', name: 'Zuhause' } } },
  ]);
  assert.deepEqual(critiqueScenario(scenario), critiqueScenario(scenario));
});
