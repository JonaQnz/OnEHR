import type { SimpleTrack } from '../../../shared/types';

/** Hard physiological clamps applied after noise, so a noisy/misconfigured
 * scenario can never produce a value EHRbase's own archetype-range
 * validation would reject (confirmed live: an unclamped random walk sent
 * SpO2 to 114% on this project's own first end-to-end run) - not a
 * substitute for the archetype's own range/precision validation, just a
 * sanity floor/ceiling on generated data. Deliberately generous (not
 * "normal range") - a demo scenario should still be able to represent a
 * genuinely sick patient. */
export const SIMPLE_TRACK_RANGES: Record<SimpleTrack['type'], { min: number; max: number }> = {
  heartRate: { min: 20, max: 250 },
  respirationRate: { min: 4, max: 60 },
  spo2: { min: 0, max: 100 },
  bodyTemperature: { min: 25, max: 45 },
};

export const BLOOD_PRESSURE_RANGE = {
  systolic: { min: 60, max: 260 },
  diastolic: { min: 30, max: 150 },
};

export function clamp(value: number, range: { min: number; max: number }): number {
  return Math.min(Math.max(value, range.min), range.max);
}
