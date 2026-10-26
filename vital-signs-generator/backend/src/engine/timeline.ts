import { createRng } from './rng';
import { parseIsoDurationMs } from '../../../shared/isoDuration';
import { evaluateTrackSeries } from './tracks/registry';
import { applyEvents } from './events';
import type { Scenario, Timepoint, Track, TrackType } from '../../../shared/types';

/** Turns a Scenario into an ordered list of Timepoints - the one function
 * both the dry-run preview and the real generation loop call (see
 * engine/submission/{dryRun,compositionRunner}.ts), so "what you previewed
 * is what gets submitted" is structural, not a manually-maintained
 * guarantee. Pure and synchronous: same scenario + same seed always
 * produces the same output.
 *
 * Sampling is one mechanism, not "count vs interval": every track's own
 * interval (or the scenario default) determines which instants on ONE
 * shared master grid (built from defaultSamplingInterval) it is due at -
 * never an independently-drifting per-track clock. This is what lets
 * Snapshot mode (one Composition per timepoint) stay coherent: a
 * Composition only ever exists at a grid instant, carrying whichever
 * tracks happen to be due there. */
export function buildTimepoints(scenario: Scenario): Timepoint[] {
  const startTimeMs = Date.parse(scenario.startTime);
  if (Number.isNaN(startTimeMs)) throw new Error(`Scenario startTime is not a valid ISO timestamp: "${scenario.startTime}"`);
  const durationMs = parseIsoDurationMs(scenario.durationIso);
  const defaultIntervalMs = parseIsoDurationMs(scenario.defaultSamplingInterval);

  const gridSize = Math.floor(durationMs / defaultIntervalMs) + 1;
  const grid: number[] = Array.from({ length: gridSize }, (_, i) => startTimeMs + i * defaultIntervalMs);

  const rng = createRng(scenario.seed ?? 1);
  const timepointsByTimestamp = new Map<number, Partial<Record<TrackType, Timepoint['dueTracks'][TrackType]>>>();

  for (const track of scenario.tracks) {
    const trackIntervalMs = track.sampling ? parseIsoDurationMs(track.sampling.intervalIso) : defaultIntervalMs;
    const stepMultiple = Math.max(1, Math.round(trackIntervalMs / defaultIntervalMs));
    const dueIndices = grid.map((_, i) => i).filter((i) => i % stepMultiple === 0);
    const dueTimestamps = dueIndices.map((i) => grid[i]!);

    const values = evaluateTrackSeries(track, dueTimestamps, startTimeMs, durationMs, rng);

    dueTimestamps.forEach((timestamp, index) => {
      const missingRate = track.missingValueRate ?? 0;
      if (missingRate > 0 && rng() < missingRate) return; // simulates a missed/skipped measurement
      const value = values[index];
      if (!value) return;
      const existing = timepointsByTimestamp.get(timestamp) ?? {};
      existing[track.type] = value;
      timepointsByTimestamp.set(timestamp, existing);
    });
  }

  const baseTimepoints = Array.from(timepointsByTimestamp.entries())
    .sort(([a], [b]) => a - b)
    .map(([timestamp, dueTracks]) => ({ timestamp: new Date(timestamp).toISOString(), dueTracks }));

  // Events are a pure post-processing pass over the already-evaluated
  // timeline (base signal model + noise + sampling + missing-value roll
  // all already applied) - see engine/events.ts's own comment for why this
  // stays strictly outside the signal-model/adapter layers.
  return applyEvents(baseTimepoints, scenario.events);
}

/** Convenience re-export so callers only need one import for the common
 * "build a scenario, hand it a Track" case. */
export type { Track };
