import type { Rng } from '../rng';
import { gaussian } from '../rng';

export interface RandomWalkParams {
  baseline: number;
  volatility: number;
  meanReversion: number;
}

/** `volatility`/`meanReversion` are defined per this reference interval
 * (15 minutes - the scenario's own common default sampling interval, and
 * the unit the ChatGPT-refined spec's own examples use, e.g. "±4 bpm"
 * "alle 15 min"), not per absolute minute. This is what lets a
 * user-entered number mean the same thing regardless of a track's actual
 * sampling interval. */
const REFERENCE_INTERVAL_MINUTES = 15;

/** Ornstein-Uhlenbeck-style mean-reverting walk over an ordered list of
 * instants (ms since epoch) - each step nudges toward `baseline` and adds
 * volatility-scaled noise, so consecutive samples are correlated rather
 * than independent random(min,max) draws (the "looks fake" failure mode).
 * The first sample always starts exactly at baseline.
 *
 * Uses the exact (not forward-Euler) OU transition - `persistence` decays
 * geometrically with the number of reference-intervals elapsed, so it can
 * never overshoot/invert past baseline the way a naive
 * `previous + meanReversion*(baseline-previous)*dt` step does once dt
 * exceeds roughly `1/meanReversion` (confirmed live: a 15-minute step with
 * meanReversion 0.25 produced a >3x overshoot coefficient under the naive
 * Euler form). `meanReversion` is the fraction pulled back toward baseline
 * per reference interval (0..1, clamped); `volatility` is the noise
 * standard deviation per reference interval, scaled by sqrt(elapsed
 * reference intervals) for any actual sampling gap. */
export function evaluateRandomWalkSeries(params: RandomWalkParams, timestampsMs: number[], rng: Rng): number[] {
  const { baseline, volatility, meanReversion } = params;
  const retainedFractionPerReferenceInterval = Math.min(Math.max(1 - meanReversion, 0), 1);
  const series: number[] = [];
  let previous = baseline;
  for (let i = 0; i < timestampsMs.length; i += 1) {
    if (i === 0) {
      series.push(baseline);
      previous = baseline;
      continue;
    }
    const timestamp = timestampsMs[i];
    const priorTimestamp = timestampsMs[i - 1];
    if (timestamp === undefined || priorTimestamp === undefined) continue;
    const elapsedReferenceIntervals = Math.max((timestamp - priorTimestamp) / 60000, 0) / REFERENCE_INTERVAL_MINUTES;
    const persistence = retainedFractionPerReferenceInterval ** elapsedReferenceIntervals;
    const next = baseline + (previous - baseline) * persistence + volatility * Math.sqrt(elapsedReferenceIntervals) * gaussian(rng);
    series.push(next);
    previous = next;
  }
  return series;
}
