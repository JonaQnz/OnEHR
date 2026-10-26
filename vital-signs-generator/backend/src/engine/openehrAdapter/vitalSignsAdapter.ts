import type { OpenEhrAdapter, RuntimeValue } from './index';
import type { Scenario, Timepoint } from '../../../../shared/types';

/**
 * The Vitalzeichen Form Section's own field ids, exactly as bound during
 * Phase 1 (see repo root: built via the `formbuilder` MCP tools,
 * `import_remote_template({templateId:"Vital_Signs"})` then
 * `create_form`/`update_form`/`publish_form`). Every id here must match a
 * real bound field on that published Form Section - confirmed once at
 * publish time (the generated FormValues TS types echoed back these exact
 * ids/shapes) and re-checked by vitalSignsAdapter.test.ts.
 *
 * Careful: OBSERVATION.pulse.v2 and OBSERVATION.blood_pressure.v2 each
 * have a second sibling event (`events[at1036]` "maximum" /
 * `events[at1042]` "24h average", both INTERVAL_EVENT, out of scope for
 * this generator) - every path below targets the plain any_event
 * (`events[at0003]`/`events[at0006]`), never the sibling.
 */
const FIELD_IDS = {
  contextStartTime: 'context_start_time',
  heartRate: { value: 'hr_rate', time: 'hr_time' },
  respirationRate: { value: 'resp_rate', time: 'resp_time' },
  spo2: { value: 'spo2_value', time: 'spo2_time' },
  bodyTemperature: { value: 'temp_value', time: 'temp_time' },
  bloodPressure: {
    systolic: 'bp_systolic',
    diastolic: 'bp_diastolic',
    map: 'bp_map',
    pulsePressure: 'bp_pulse_pressure',
    time: 'bp_time',
  },
} as const;

/** Fixed units, matching the Vital_Signs template's own constrained unit
 * lists (confirmed live via get_ehrbase_template_webtemplate during
 * Phase 1) - '/min' for heart/respiration rate, 'Cel' for temperature
 * (the archetype also allows '[degF]', unused here), 'mm[Hg]' for blood
 * pressure. SpO2 is a DV_PROPORTION with denominator fixed at 100 by the
 * archetype (proportionType 'percent' on the bound field), so only
 * `numerator` needs to be supplied - the server fills in the denominator. */
function toFormSessionValues(timepoint: Timepoint, scenario: Scenario): Record<string, RuntimeValue> {
  void scenario; // not currently needed by this adapter, kept for interface symmetry / future use
  const values: Record<string, RuntimeValue> = {
    [FIELD_IDS.contextStartTime]: timepoint.timestamp,
  };
  const { dueTracks } = timepoint;

  if (dueTracks.heartRate && dueTracks.heartRate.type === 'heartRate') {
    values[FIELD_IDS.heartRate.value] = { magnitude: dueTracks.heartRate.magnitude, unit: '/min' };
    values[FIELD_IDS.heartRate.time] = timepoint.timestamp;
  }
  if (dueTracks.respirationRate && dueTracks.respirationRate.type === 'respirationRate') {
    values[FIELD_IDS.respirationRate.value] = { magnitude: dueTracks.respirationRate.magnitude, unit: '/min' };
    values[FIELD_IDS.respirationRate.time] = timepoint.timestamp;
  }
  if (dueTracks.spo2 && dueTracks.spo2.type === 'spo2') {
    values[FIELD_IDS.spo2.value] = { numerator: dueTracks.spo2.percent };
    values[FIELD_IDS.spo2.time] = timepoint.timestamp;
  }
  if (dueTracks.bodyTemperature && dueTracks.bodyTemperature.type === 'bodyTemperature') {
    values[FIELD_IDS.bodyTemperature.value] = { magnitude: dueTracks.bodyTemperature.magnitude, unit: 'Cel' };
    values[FIELD_IDS.bodyTemperature.time] = timepoint.timestamp;
  }
  if (dueTracks.bloodPressure && dueTracks.bloodPressure.type === 'bloodPressure') {
    const bp = dueTracks.bloodPressure;
    values[FIELD_IDS.bloodPressure.systolic] = { magnitude: bp.systolic, unit: 'mm[Hg]' };
    values[FIELD_IDS.bloodPressure.diastolic] = { magnitude: bp.diastolic, unit: 'mm[Hg]' };
    values[FIELD_IDS.bloodPressure.map] = { magnitude: bp.map, unit: 'mm[Hg]' };
    values[FIELD_IDS.bloodPressure.pulsePressure] = { magnitude: bp.pulsePressure, unit: 'mm[Hg]' };
    values[FIELD_IDS.bloodPressure.time] = timepoint.timestamp;
  }

  return values;
}

/** ids from Phase 1's live publish - see repo root git history for the
 * exact MCP tool calls that produced them. */
export const vitalSignsAdapter: OpenEhrAdapter = {
  formSectionId: '61730ea9-284d-458f-b173-47902d0a7c90',
  compositionFormId: 'b82c488f-688a-49d2-8031-447a0440d098',
  blockId: 'vitals_block',
  toFormSessionValues,
};

export { FIELD_IDS };
