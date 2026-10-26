import type { Rng } from '../rng';
import { evaluateConstant } from './constant';
import { evaluateRandomWalkSeries } from './randomWalk';
import { evaluateDrawnCurveSeries } from './drawnCurve';
import type { SignalModel } from '../../../../shared/types';

export { applyNoise } from './noise';
export { interpolateDrawnCurve } from './drawnCurve';
export type { CurvePoint } from './drawnCurve';

/** Registry entry point: one base (pre-noise) value per requested instant,
 * for whichever SignalModel.kind was configured. A future model kind
 * (e.g. a named "Preset/Pattern") registers here - callers (tracks/*.ts)
 * never switch on `model.kind` themselves. */
export function evaluateSignalModelSeries(model: SignalModel, timestampsMs: number[], startTimeMs: number, durationMs: number, rng: Rng): number[] {
  switch (model.kind) {
    case 'constant':
      return timestampsMs.map((t) => evaluateConstant(model, durationMs > 0 ? (t - startTimeMs) / durationMs : 0));
    case 'randomWalk':
      return evaluateRandomWalkSeries(model, timestampsMs, rng);
    case 'drawnCurve':
      return evaluateDrawnCurveSeries(model.points, timestampsMs, startTimeMs, durationMs);
    default: {
      const exhaustive: never = model;
      throw new Error(`Unknown signal model kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
