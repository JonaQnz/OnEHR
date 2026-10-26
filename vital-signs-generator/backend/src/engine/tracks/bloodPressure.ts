import type { Rng } from '../rng';
import { evaluateSignalModelSeries, applyNoise } from '../signalModels';
import { clamp, BLOOD_PRESSURE_RANGE } from '../physiologicalRanges';
import type { BloodPressureSignalModel, BloodPressureTrack, SignalModel, TrackValue } from '../../../../shared/types';

/** Blood pressure is one coupled track, never two independent ones (see
 * shared/types.ts's own comment on BloodPressureSignalModel). A single
 * "hemodynamic tone" signal - constant/random-walk/drawn-curve, exactly
 * like any other track's model - drives both sides; systolic and
 * diastolic are always derived from the SAME tone value at a given
 * instant, so they move together instead of drifting into a
 * physiologically incoherent combination (e.g. diastolic briefly
 * exceeding systolic). Noise is applied to the tone itself, before
 * deriving all four numbers - never independently per output field. */
function toneAsSignalModel(model: BloodPressureSignalModel): SignalModel {
  switch (model.tone.kind) {
    case 'constant':
      return { kind: 'constant', value: 0 };
    case 'randomWalk':
      return { kind: 'randomWalk', baseline: 0, volatility: model.tone.volatility, meanReversion: model.tone.meanReversion };
    case 'drawnCurve':
      return { kind: 'drawnCurve', points: model.tone.points };
    default: {
      const exhaustive: never = model.tone;
      throw new Error(`Unknown blood pressure tone kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function evaluateBloodPressureSeries(track: BloodPressureTrack, timestampsMs: number[], startTimeMs: number, durationMs: number, rng: Rng): TrackValue[] {
  const toneModel = toneAsSignalModel(track.signalModel);
  const baseTone = evaluateSignalModelSeries(toneModel, timestampsMs, startTimeMs, durationMs, rng);
  const tone = applyNoise(baseTone, track.noise, rng);
  const { baselineSystolic, baselineDiastolic, systolicSensitivity, diastolicSensitivity } = track.signalModel;
  return tone.map((toneValue) => {
    const rawSystolic = baselineSystolic + toneValue * systolicSensitivity;
    const rawDiastolic = baselineDiastolic + toneValue * diastolicSensitivity;
    const systolic = clamp(rawSystolic, BLOOD_PRESSURE_RANGE.systolic);
    // Diastolic is clamped to its own physiological range AND to stay
    // meaningfully below systolic - the two are derived from one shared
    // tone value precisely so they can't drift apart, but independent
    // clamping at the extremes could otherwise let a clamped diastolic
    // cross a clamped systolic.
    const diastolic = Math.min(clamp(rawDiastolic, BLOOD_PRESSURE_RANGE.diastolic), systolic - 5);
    return {
      type: 'bloodPressure' as const,
      systolic,
      diastolic,
      map: diastolic + (systolic - diastolic) / 3,
      pulsePressure: systolic - diastolic,
    };
  });
}
