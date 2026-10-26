import { parseIsoDurationMs } from '../../../shared/isoDuration';
import { clamp, SIMPLE_TRACK_RANGES, BLOOD_PRESSURE_RANGE } from './physiologicalRanges';
import type { DropoutEventEffect, EventEffect, ScenarioEvent, SimpleTrack, Timepoint, TrackValue } from '../../../shared/types';

/** Smooth 0..1 easing with zero slope at both ends (no visible "kink" where
 * a ramp meets a flat plateau) - the standard smoothstep polynomial. */
function smoothstep(x: number): number {
  const clamped = Math.min(Math.max(x, 0), 1);
  return clamped * clamped * (3 - 2 * clamped);
}

/** Attack-sustain-release envelope: ramps up over the first ~25% of the
 * window, holds at 1 through the middle ~50%, ramps back down over the
 * last ~25% - 0 outside the window entirely. Not a hard step (avoids the
 * "obviously synthetic" jump a plain on/off effect would produce), and not
 * a symmetric bump either (a plateau lets an event read as "the patient
 * stayed sick for a while", not just a momentary blip). */
export function activationAt(event: ScenarioEvent, timestampMs: number): number {
  const startMs = Date.parse(event.startTime);
  const durationMs = parseIsoDurationMs(event.durationIso);
  const endMs = startMs + durationMs;
  if (timestampMs < startMs || timestampMs > endMs) return 0;
  const rampMs = Math.min(durationMs * 0.25, durationMs / 2);
  const elapsed = timestampMs - startMs;
  const remaining = endMs - timestampMs;
  if (elapsed < rampMs) return smoothstep(rampMs > 0 ? elapsed / rampMs : 1);
  if (remaining < rampMs) return smoothstep(rampMs > 0 ? remaining / rampMs : 1);
  return 1;
}

function isDropout(effect: EventEffect | DropoutEventEffect): effect is DropoutEventEffect {
  return effect.kind === 'dropout';
}

/** Applies one non-dropout effect's contribution at a given activation
 * level to a track's already-evaluated (and already-clamped) value,
 * re-clamping the result - an event can momentarily push a value past its
 * normal envelope (that's the point), but never past the same hard
 * physiological floor/ceiling every other value already respects. */
function applyEffectToValue(value: TrackValue, effect: Exclude<EventEffect, DropoutEventEffect>, activation: number): TrackValue {
  if (activation <= 0) return value;
  if (value.type === 'bloodPressure') {
    // Diastolic follows the same rough 1.5:1 systolic:diastolic ratio the
    // coupled signal model itself uses (bloodPressure.ts), so an event
    // keeps the two moving together instead of pulling them apart.
    const systolicDelta = effect.kind === 'offset' ? effect.peakValue * activation : (effect.peakValue - value.systolic) * activation;
    const diastolicDelta = systolicDelta * (2 / 3);
    const systolic = clamp(value.systolic + systolicDelta, BLOOD_PRESSURE_RANGE.systolic);
    const diastolic = Math.min(clamp(value.diastolic + diastolicDelta, BLOOD_PRESSURE_RANGE.diastolic), systolic - 5);
    return { type: 'bloodPressure', systolic, diastolic, map: diastolic + (systolic - diastolic) / 3, pulsePressure: systolic - diastolic };
  }
  const range = SIMPLE_TRACK_RANGES[value.type as SimpleTrack['type']];
  const current = value.type === 'spo2' ? value.percent : value.magnitude;
  const delta = effect.kind === 'offset' ? effect.peakValue * activation : (effect.peakValue - current) * activation;
  const next = clamp(current + delta, range);
  return value.type === 'spo2' ? { type: 'spo2', percent: next } : { ...value, magnitude: next };
}

/** Layers every ScenarioEvent's effects on top of the timepoints
 * buildTimepoints already produced (base signal model + noise + sampling +
 * missing-value roll all already applied) - events are strictly a
 * post-processing pass, never something the signal models or the openEHR
 * adapter know about. A `dropout` effect removes that track's sample from
 * a timepoint entirely (not a ramped numeric effect - a measurement either
 * happened or it didn't) whenever the timestamp falls anywhere inside the
 * event's window (no ramp - the plateau/ramp shape only applies to
 * offset/setLevel). A timepoint left with zero due tracks after dropouts
 * is filtered out, matching buildTimepoints' own "never an empty
 * Composition" invariant. */
export function applyEvents(timepoints: Timepoint[], events: ScenarioEvent[] | undefined): Timepoint[] {
  if (!events || events.length === 0) return timepoints;

  return timepoints
    .map((timepoint) => {
      const timestampMs = Date.parse(timepoint.timestamp);
      const dueTracks = { ...timepoint.dueTracks };

      for (const event of events) {
        const startMs = Date.parse(event.startTime);
        const endMs = startMs + parseIsoDurationMs(event.durationIso);
        const insideWindow = timestampMs >= startMs && timestampMs <= endMs;

        for (const effect of event.effects) {
          const existing = dueTracks[effect.track];
          if (!existing) continue;
          if (isDropout(effect)) {
            if (insideWindow) delete dueTracks[effect.track];
            continue;
          }
          const activation = activationAt(event, timestampMs);
          if (activation > 0) dueTracks[effect.track] = applyEffectToValue(existing, effect, activation);
        }
      }

      return { ...timepoint, dueTracks };
    })
    .filter((timepoint) => Object.keys(timepoint.dueTracks).length > 0);
}
