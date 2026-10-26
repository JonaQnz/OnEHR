import type { Rng } from '../rng';
import { gaussian } from '../rng';
import type { NoiseSpec } from '../../../../shared/types';

/** Additive gaussian noise layered on top of a base series, applied
 * independently per sample (unlike the random-walk model's own internal
 * correlated noise) - e.g. a drawn curve still gets realistic per-reading
 * jitter without the underlying trend itself becoming noisy. */
export function applyNoise(series: number[], noise: NoiseSpec | undefined, rng: Rng): number[] {
  if (!noise || noise.stdDev <= 0) return series;
  return series.map((value) => value + noise.stdDev * gaussian(rng));
}
