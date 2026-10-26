import type { Rng } from '../rng';
import { evaluateSignalModelSeries, applyNoise } from '../signalModels';
import { evaluateBloodPressureSeries } from './bloodPressure';
import { clamp, SIMPLE_TRACK_RANGES } from '../physiologicalRanges';
import type { SimpleTrack, Track, TrackValue } from '../../../../shared/types';

function toTrackValue(type: SimpleTrack['type'], magnitude: number): TrackValue {
  const clamped = clamp(magnitude, SIMPLE_TRACK_RANGES[type]);
  if (type === 'spo2') return { type: 'spo2', percent: clamped };
  return { type, magnitude: clamped };
}

/** One entry point per track, regardless of type - the only thing a
 * caller (engine/timeline.ts) needs to know about a track. A future
 * "depends on another track" correlated model would extend this to
 * receive the already-evaluated series of its dependency, mirroring how
 * bloodPressure.ts already receives everything it needs up front. */
export function evaluateTrackSeries(track: Track, timestampsMs: number[], startTimeMs: number, durationMs: number, rng: Rng): TrackValue[] {
  if (track.type === 'bloodPressure') {
    return evaluateBloodPressureSeries(track, timestampsMs, startTimeMs, durationMs, rng);
  }
  const base = evaluateSignalModelSeries(track.signalModel, timestampsMs, startTimeMs, durationMs, rng);
  const noised = applyNoise(base, track.noise, rng);
  return noised.map((value) => toTrackValue(track.type, value));
}
