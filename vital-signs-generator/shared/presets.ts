// Named track+event bundles, applied on top of a Scenario's own
// start time/duration - a preset is deliberately just data (no engine
// logic of its own), reusing exactly the same Track/ScenarioEvent shapes
// a hand-built scenario uses. Lives in shared/ (not backend/) because it's
// a pure, openEHR-unaware transform the frontend applies directly to its
// own scenario state - no HTTP round trip needed.
import { parseIsoDurationMs, formatIsoDuration } from './isoDuration';
import type { BloodPressureTrack, Scenario, ScenarioEvent, SimpleTrack, Track } from './types';

/** An event template's timing is relative to the scenario's own start
 * time (an offset, not an absolute timestamp) so the same preset works
 * regardless of what start time/duration the user picked. */
export interface PresetEventTemplate {
  label: string;
  startOffsetIso: string;
  durationIso: string;
  effects: ScenarioEvent['effects'];
}

export interface ScenarioPreset {
  id: string;
  label: string;
  description: string;
  tracks: Track[];
  events: PresetEventTemplate[];
}

function simpleTrack(id: string, type: SimpleTrack['type'], overrides: Partial<SimpleTrack>): SimpleTrack {
  const defaults: Record<SimpleTrack['type'], SimpleTrack> = {
    heartRate: { id, type, signalModel: { kind: 'randomWalk', baseline: 75, volatility: 3, meanReversion: 0.25 }, noise: { stdDev: 2 } },
    respirationRate: { id, type, signalModel: { kind: 'randomWalk', baseline: 16, volatility: 1, meanReversion: 0.3 }, noise: { stdDev: 0.5 }, sampling: { intervalIso: 'PT30M' } },
    spo2: { id, type, signalModel: { kind: 'randomWalk', baseline: 97, volatility: 0.6, meanReversion: 0.3 }, noise: { stdDev: 0.4 } },
    bodyTemperature: { id, type, signalModel: { kind: 'constant', value: 36.8 }, noise: { stdDev: 0.15 }, sampling: { intervalIso: 'PT4H' } },
  };
  return { ...defaults[type], ...overrides, id, type };
}

function bloodPressureTrack(id: string, overrides: Partial<BloodPressureTrack>): BloodPressureTrack {
  const base: BloodPressureTrack = {
    id, type: 'bloodPressure',
    signalModel: {
      kind: 'randomWalk',
      tone: { kind: 'randomWalk', volatility: 2, meanReversion: 0.2 },
      baselineSystolic: 120, baselineDiastolic: 80, systolicSensitivity: 1.5, diastolicSensitivity: 1,
    },
    noise: { stdDev: 1 },
    sampling: { intervalIso: 'PT30M' },
  };
  return { ...base, ...overrides, id, type: 'bloodPressure' };
}

const STABLE_PATIENT: ScenarioPreset = {
  id: 'stable-patient',
  label: 'Stabiler Patient',
  description: 'Alle Werte im Normalbereich, geringe Schwankung, keine Ereignisse.',
  tracks: [
    simpleTrack('hr', 'heartRate', { signalModel: { kind: 'randomWalk', baseline: 72, volatility: 2, meanReversion: 0.3 }, noise: { stdDev: 1.5 } }),
    simpleTrack('resp', 'respirationRate', {}),
    simpleTrack('spo2', 'spo2', {}),
    simpleTrack('temp', 'bodyTemperature', {}),
    bloodPressureTrack('bp', {}),
  ],
  events: [],
};

const POSTOPERATIVE_COURSE: ScenarioPreset = {
  id: 'postoperative-course',
  label: 'Postoperativer Verlauf',
  description: 'Erhöhte Werte durch Schmerz/Stress direkt postoperativ, die sich über den Szenario-Zeitraum schrittweise normalisieren; zusätzlich eine Schmerzspitze in der ersten Stunde.',
  tracks: [
    // Drawn curves showing a gradual return toward normal over the whole
    // scenario - a directional trend like this is what drawnCurve is for,
    // not an "event" (events are ramped bumps that return to baseline,
    // see shared/types.ts's own comment on ScenarioEvent.durationIso).
    simpleTrack('hr', 'heartRate', { signalModel: { kind: 'drawnCurve', points: [{ t: 0, value: 95 }, { t: 0.5, value: 82 }, { t: 1, value: 74 }] }, noise: { stdDev: 2 } }),
    simpleTrack('resp', 'respirationRate', { signalModel: { kind: 'drawnCurve', points: [{ t: 0, value: 20 }, { t: 0.5, value: 17 }, { t: 1, value: 15 }] } }),
    simpleTrack('spo2', 'spo2', { signalModel: { kind: 'randomWalk', baseline: 95, volatility: 0.6, meanReversion: 0.3 } }),
    simpleTrack('temp', 'bodyTemperature', { signalModel: { kind: 'drawnCurve', points: [{ t: 0, value: 37.6 }, { t: 0.5, value: 37.1 }, { t: 1, value: 36.8 }] } }),
    bloodPressureTrack('bp', {
      signalModel: {
        kind: 'drawnCurve',
        tone: { kind: 'drawnCurve', points: [{ t: 0, value: 12 }, { t: 0.5, value: 5 }, { t: 1, value: 0 }] },
        baselineSystolic: 122, baselineDiastolic: 80, systolicSensitivity: 1.5, diastolicSensitivity: 1,
      },
    }),
  ],
  events: [
    { label: 'Schmerzspitze', startOffsetIso: 'PT30M', durationIso: 'PT40M', effects: [{ track: 'heartRate', kind: 'offset', peakValue: 15 }, { track: 'bloodPressure', kind: 'offset', peakValue: 15 }] },
  ],
};

const ACUTE_DETERIORATION: ScenarioPreset = {
  id: 'acute-deterioration',
  label: 'Akute Verschlechterung',
  description: 'Stabiler Start, dann Fieberanstieg mit nachfolgender Desaturation und reflektorischer Tachykardie, die sich innerhalb des Szenario-Zeitraums nicht mehr normalisiert.',
  tracks: [
    simpleTrack('hr', 'heartRate', {}),
    simpleTrack('resp', 'respirationRate', {}),
    simpleTrack('spo2', 'spo2', {}),
    simpleTrack('temp', 'bodyTemperature', {}),
    bloodPressureTrack('bp', {}),
  ],
  events: [
    // Every event here starts partway through the scenario and its
    // duration deliberately extends PAST the scenario's own end (in
    // percent-of-scenario terms: start 40-55%, duration 50-80%, so
    // start+duration always lands north of 100%) - the ramp-down phase
    // (see engine/events.ts's activationAt) never actually plays out
    // within the scenario, regardless of how long the scenario itself is.
    // Confirmed live: with fixed-duration events (e.g. a flat "PT45M"
    // desaturation), a normal-length scenario left plenty of room for the
    // crisis to fully resolve before the scenario ended, contradicting
    // this preset's own "does not recover" description - percent-based
    // durations for every effect here is what actually keeps that promise
    // true regardless of the chosen scenario duration.
    { label: 'Fieberanstieg', startOffsetIso: 'PT40%', durationIso: 'PT80%', effects: [{ track: 'bodyTemperature', kind: 'setLevel', peakValue: 39.4 }] },
    { label: 'Desaturation', startOffsetIso: 'PT55%', durationIso: 'PT60%', effects: [{ track: 'spo2', kind: 'setLevel', peakValue: 86 }] },
    { label: 'Reflektorische Tachykardie', startOffsetIso: 'PT55%', durationIso: 'PT60%', effects: [{ track: 'heartRate', kind: 'offset', peakValue: 30 }] },
    { label: 'Kompensatorische Tachypnoe', startOffsetIso: 'PT55%', durationIso: 'PT60%', effects: [{ track: 'respirationRate', kind: 'offset', peakValue: 8 }] },
  ],
};

export const PRESET_LIBRARY: ScenarioPreset[] = [STABLE_PATIENT, POSTOPERATIVE_COURSE, ACUTE_DETERIORATION];

/** `PT40%`/`PT80%` in a preset's own startOffsetIso/durationIso are a small
 * preset-only convention (a percentage of the SCENARIO's own duration,
 * resolved once here) - never a real ISO-8601 duration a scenario itself
 * carries; every actual Scenario.events[].durationIso is a genuine
 * ISO-8601 duration string (see engine/isoDuration.ts). Keeps presets
 * duration-independent (the same "Akute Verschlechterung" preset produces
 * a sensible timeline whether the scenario is 6h or 48h long) without
 * teaching the real engine a percentage syntax it would otherwise never
 * need to understand. */
function resolveOffset(offsetIso: string, scenarioDurationMs: number): number {
  const percentMatch = /^PT(\d+(?:\.\d+)?)%$/.exec(offsetIso);
  if (percentMatch) return scenarioDurationMs * (Number(percentMatch[1]) / 100);
  return parseIsoDurationMs(offsetIso);
}

/** Replaces the given scenario's tracks/events with the preset's own,
 * keeping the scenario's own id/name/startTime/duration/sampling/seed
 * untouched - applying a preset is a content swap, not a new scenario. */
export function applyPreset(scenario: Scenario, preset: ScenarioPreset): Scenario {
  const scenarioDurationMs = parseIsoDurationMs(scenario.durationIso);
  const startTimeMs = Date.parse(scenario.startTime);
  const events: ScenarioEvent[] = preset.events.map((template, index) => ({
    id: `${preset.id}-event-${index}`,
    label: template.label,
    startTime: new Date(startTimeMs + resolveOffset(template.startOffsetIso, scenarioDurationMs)).toISOString(),
    // Rendered with formatIsoDuration (days/hours/minutes), not a raw
    // seconds count - confirmed live: "PT69120S" is technically valid but
    // reads as broken in the events editor. Real ISO durations (the
    // non-percent branch) are left exactly as the preset author wrote
    // them, e.g. "PT40M" stays "PT40M".
    durationIso: /%$/.test(template.durationIso)
      ? formatIsoDuration(resolveOffset(template.durationIso, scenarioDurationMs))
      : template.durationIso,
    effects: template.effects,
  }));
  return { ...scenario, tracks: preset.tracks, events };
}
