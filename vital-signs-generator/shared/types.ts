// Single source of truth for the generator's own scenario/track model.
// Deliberately knows nothing about openEHR - that translation lives
// entirely in backend/src/engine/openehrAdapter/. Imported by both the
// backend and the frontend via a relative path (no publish step - this
// project is small and self-contained on purpose).

/** A signal model producing one scalar value per evaluated instant, for
 * every track type except bloodPressure (see BloodPressureSignalModel). */
export type SignalModel =
  | { kind: 'constant'; value: number }
  | {
      /** Smoothed, mean-reverting random walk (Ornstein-Uhlenbeck-style) -
       * deliberately NOT independent random(min,max) per sample, which
       * looks obviously synthetic after only a few points. Consecutive
       * samples are correlated: each step nudges toward `baseline` by
       * `meanReversion` and adds `volatility`-scaled noise. */
      kind: 'randomWalk';
      baseline: number;
      volatility: number;
      meanReversion: number;
    }
  | {
      /** User-placed control points, `t` normalized 0..1 across the
       * scenario's own duration. Piecewise-linear interpolation for MVP;
       * spline is a self-contained swap in signalModels/drawnCurve.ts. */
      kind: 'drawnCurve';
      points: Array<{ t: number; value: number }>;
    };

/** Blood pressure is one coupled track, not two independent ones - see
 * engine/tracks/bloodPressure.ts. One shared tone-generating model, plus
 * fixed baselines/sensitivities the tone is applied against. */
export type BloodPressureSignalModel = {
  kind: 'randomWalk' | 'constant' | 'drawnCurve';
  /** The same shape as the corresponding SignalModel variant, minus its
   * own scalar baseline/value - those are supplied per-side below. Kept as
   * a discriminated union mirroring SignalModel so the same interpolation/
   * random-walk code can evaluate the shared "tone" signal. */
  tone:
    | { kind: 'constant' }
    | { kind: 'randomWalk'; volatility: number; meanReversion: number }
    | { kind: 'drawnCurve'; points: Array<{ t: number; value: number }> };
  baselineSystolic: number;
  baselineDiastolic: number;
  /** How much of one unit of "tone" moves each side, mmHg per unit. */
  systolicSensitivity: number;
  diastolicSensitivity: number;
};

export type NoiseSpec = { stdDev: number };

/** A track's own sampling interval, overriding the scenario's default -
 * e.g. body temperature every 4h while heart rate stays at the scenario
 * default of 15min. ISO-8601 duration string (e.g. "PT15M", "PT4H"). */
export type SamplingOverride = { intervalIso: string };

export type TrackType = 'heartRate' | 'respirationRate' | 'spo2' | 'bodyTemperature' | 'bloodPressure';

interface TrackBase {
  id: string;
  /** 0..1: fraction of this track's own due samples dropped entirely
   * (simulates a missed/skipped measurement). Reuses the platform's
   * existing behavior that an OBSERVATION with no due content is simply
   * omitted - no new capability needed on the openEHR side for this. */
  missingValueRate?: number;
  sampling?: SamplingOverride;
}

export interface SimpleTrack extends TrackBase {
  type: 'heartRate' | 'respirationRate' | 'spo2' | 'bodyTemperature';
  signalModel: SignalModel;
  noise?: NoiseSpec;
}

export interface BloodPressureTrack extends TrackBase {
  type: 'bloodPressure';
  signalModel: BloodPressureSignalModel;
  /** Applied to the shared tone signal before deriving systolic/diastolic,
   * so noise cannot pull the two apart independently. */
  noise?: NoiseSpec;
}

export type Track = SimpleTrack | BloodPressureTrack;

/** A clinical event's effect on one track - applied on top of whatever the
 * track's own signal model already produced (see engine/events.ts), never
 * inside the model or the adapter. Multiple effects (different tracks) can
 * belong to one ScenarioEvent, e.g. a desaturation event that also nudges
 * heart rate up (a reflex tachycardia). */
export type EventEffect =
  | { track: TrackType; kind: 'offset'; peakValue: number }
  // 'offset': at full activation, peakValue is ADDED to the track's own
  // evaluated value (e.g. heartRate peakValue +25 -> +25 bpm at the event's
  // peak). For bloodPressure, peakValue is applied to systolic; diastolic
  // moves by peakValue*0.67 (same rough 1.5:1 ratio the coupled model
  // itself uses), keeping the two coupled through an event too.
  | { track: TrackType; kind: 'setLevel'; peakValue: number };
  // 'setLevel': at full activation, the track's value is blended TOWARD
  // peakValue as an absolute level (e.g. spo2 peakValue 86 -> SpO2 heads
  // toward 86% at the event's peak, not just -86 added). For bloodPressure,
  // peakValue targets systolic directly; diastolic follows the same 0.67
  // ratio toward its own proportional target.

/** A dropout effect is binary (a measurement was skipped, or it wasn't) -
 * not ramped, so it's its own variant rather than sharing offset/setLevel's
 * peakValue shape. */
export type DropoutEventEffect = { track: TrackType; kind: 'dropout' };

export interface ScenarioEvent {
  id: string;
  label: string;
  /** ISO-8601 timestamp - must fall within the scenario's own window for
   * the event to have any visible effect. */
  startTime: string;
  /** ISO-8601 duration. Activation ramps up over the first ~25%, holds at
   * full strength through the middle ~50%, and ramps back down over the
   * last ~25% (see engine/events.ts's activationAt) - a smooth
   * attack-sustain-release envelope, not a hard step. A long duration
   * whose tail extends past the scenario's own end (as the built-in
   * "Akute Verschlechterung" preset does) reads as "the patient doesn't
   * recover within this scenario", without needing a separate flag. */
  durationIso: string;
  effects: Array<EventEffect | DropoutEventEffect>;
}

export interface Scenario {
  id: string;
  name?: string;
  /** ISO-8601 timestamp - the scenario's simulated start instant. */
  startTime: string;
  /** ISO-8601 duration, e.g. "PT24H". */
  durationIso: string;
  /** ISO-8601 duration, e.g. "PT15M" - the master timeline grid every
   * track's own sampling snaps onto (see engine/timeline.ts). */
  defaultSamplingInterval: string;
  /** Deterministic PRNG seed - same scenario + same seed => same output,
   * so the preview and a real generate run are byte-identical. */
  seed?: number;
  tracks: Track[];
  /** Time-window interventions layered on top of the tracks' own signal
   * models (see engine/events.ts) - fever onset, desaturation, tachycardia,
   * measurement dropout, etc. Empty/absent = no events, unchanged behavior. */
  events?: ScenarioEvent[];
}

/** One abstract, openEHR-unaware evaluated value per track type. Kept
 * separate per type (rather than one generic {value:number}) so the
 * adapter never has to guess which numeric field a bare number belongs to. */
export type TrackValue =
  | { type: 'heartRate'; magnitude: number }
  | { type: 'respirationRate'; magnitude: number }
  | { type: 'spo2'; percent: number }
  | { type: 'bodyTemperature'; magnitude: number }
  | {
      type: 'bloodPressure';
      systolic: number;
      diastolic: number;
      map: number;
      pulsePressure: number;
    };

/** One instant on the shared timeline, carrying only the tracks that were
 * actually due (post sampling-grid snap, post missing-value roll) - a
 * timepoint with zero due tracks never reaches the adapter/API layer at
 * all (see engine/timeline.ts). */
export interface Timepoint {
  timestamp: string;
  dueTracks: Partial<Record<TrackType, TrackValue>>;
}
