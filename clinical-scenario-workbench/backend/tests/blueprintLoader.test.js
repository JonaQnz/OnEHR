const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { BlueprintLoader } = require('../dist/fhir/blueprint');

// Blueprints are plain YAML data files, not TypeScript - tsc never copies
// them into dist/, so BlueprintLoader is always pointed at the *source*
// directory (see config.ts's blueprintsDir), both here and at runtime.
const blueprintsDir = path.join(__dirname, '..', 'src', 'fhir', 'blueprints');

test('BlueprintLoader loads Patient.yaml and exposes its declared sections', () => {
  const loader = new BlueprintLoader(blueprintsDir);
  const patient = loader.require('Patient');
  assert.equal(patient.resourceType, 'Patient');
  assert.deepEqual(patient.simulationRequired, ['name.0.family', 'name.0.given.0', 'gender', 'birthDate']);
  assert.deepEqual(patient.dependencies, []);
  assert.deepEqual(patient.mayTrigger, ['Encounter']);
  assert.equal(patient.fields.length, 4);
  assert.equal(patient.fields.find((f) => f.path === 'gender').options.length, 4);
});

test('BlueprintLoader loads Encounter.yaml with its Patient reference/dependency declared', () => {
  const loader = new BlueprintLoader(blueprintsDir);
  const encounter = loader.require('Encounter');
  assert.equal(encounter.resourceType, 'Encounter');
  assert.deepEqual(encounter.dependencies, ['Patient']);
  assert.deepEqual(encounter.references['subject.reference'].target, ['Patient']);
  assert.ok(encounter.llmMayNotGenerate.includes('subject.reference'));
});

test('the CT-imaging chain blueprints (HealthcareService/Schedule/Slot/Appointment) all load and chain their dependencies correctly', () => {
  const loader = new BlueprintLoader(blueprintsDir);
  const service = loader.require('HealthcareService');
  const schedule = loader.require('Schedule');
  const slot = loader.require('Slot');
  const appointment = loader.require('Appointment');

  assert.deepEqual(service.dependencies, []);
  assert.deepEqual(service.mayTrigger, ['Schedule']);

  assert.deepEqual(schedule.dependencies, ['HealthcareService']);
  assert.deepEqual(schedule.references['actor.0.reference'].target, ['HealthcareService']);
  assert.deepEqual(schedule.mayTrigger, ['Slot']);

  assert.deepEqual(slot.dependencies, ['Schedule']);
  assert.deepEqual(slot.references['schedule.reference'].target, ['Schedule']);
  assert.deepEqual(slot.mayTrigger, ['Appointment']);

  assert.deepEqual(appointment.dependencies, ['Patient', 'Slot']);
  assert.deepEqual(appointment.references['participant.0.actor.reference'].target, ['Patient']);
  assert.deepEqual(appointment.references['slot.0.reference'].target, ['Slot']);
  assert.ok(appointment.llmMayGenerate.includes('start'));
  assert.ok(appointment.llmMayNotGenerate.includes('participant.0.actor.reference'));
});

test('require() throws a clear error for a resource type with no blueprint', () => {
  const loader = new BlueprintLoader(blueprintsDir);
  assert.throws(() => loader.require('Organization'), /No Resource Blueprint for "Organization"/);
});
