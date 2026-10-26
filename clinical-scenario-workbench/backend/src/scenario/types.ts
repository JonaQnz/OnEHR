/**
 * Spec section 6 - what a scenario declares: the important clinical facts
 * and a timeline of events. Deliberately NOT everything (no org structure,
 * no room names, no exact appointment time unless clinically relevant) -
 * the engine/agent fills the rest in (spec section 4's pipeline).
 */
export interface ScenarioPatient {
  key: string;
  firstName: string;
  lastName: string;
  sex: 'male' | 'female' | 'other' | 'unknown';
  age: number;
  /** An exact real-world birth date, when the scenario author knows one -
   * takes priority over the `age`-derived approximate one patient-arrival
   * otherwise computes. */
  birthDate?: string;
}

export type ScenarioEventType = 'patient-arrival' | 'anamnesis' | 'vital-signs' | 'request-imaging' | 'ward-transfer' | 'nursing-round' | 'doctor-round' | 'lab-result' | 'procedure' | 'diagnostic-report' | 'discharge-letter' | 'medication-order' | 'medication-administration' | 'discharge-medication' | 'coded-diagnosis' | 'lab-value' | 'order-basis' | 'pregnancy-status' | 'patient-conversation';

export interface ScenarioEvent {
  id: string;
  type: ScenarioEventType;
  /** Offset from scenario start, human-readable (e.g. "5m", "1h10m") -
   * purely descriptive/for the Timeline view; the engine executes events in
   * array order, not by racing a clock against this. */
  at: string;
  data?: Record<string, unknown>;
}

export interface Scenario {
  scenarioId: string;
  /** Which facility (context.ts's FacilityRegistry, e.g. "krankenhaus" or
   * "rehazentrum") this scenario is set at - declared once, same as
   * `patient`/`events`. Omit for the original hospital (context.ts's
   * `DEFAULT_FACILITY_ID`) - every scenario file authored before
   * multi-facility support existed keeps working unchanged. */
  facilityId?: string;
  patient: ScenarioPatient;
  events: ScenarioEvent[];
}
