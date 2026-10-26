import type { BloodPressureTrack, SignalModel, SimpleTrack, Track } from '../../../shared/types';
import { CurveEditor } from './CurveEditor';

interface Props {
  track: Track;
  onChange: (patch: Partial<Track>) => void;
}

const VALUE_RANGES: Record<SimpleTrack['type'], { min: number; max: number; unit: string }> = {
  heartRate: { min: 30, max: 180, unit: '/min' },
  respirationRate: { min: 6, max: 40, unit: '/min' },
  spo2: { min: 70, max: 100, unit: '%' },
  bodyTemperature: { min: 34, max: 41, unit: '°C' },
};

function SimpleTrackModel({ track, onChange }: { track: SimpleTrack; onChange: (patch: Partial<SimpleTrack>) => void }) {
  const range = VALUE_RANGES[track.type];
  const model = track.signalModel;

  return (
    <>
      <label>
        Verlauf
        <select
          value={model.kind}
          onChange={(e) => {
            const kind = e.target.value as SignalModel['kind'];
            const next: SignalModel =
              kind === 'constant' ? { kind: 'constant', value: (range.min + range.max) / 2 }
              : kind === 'randomWalk' ? { kind: 'randomWalk', baseline: (range.min + range.max) / 2, volatility: (range.max - range.min) * 0.05, meanReversion: 0.2 }
              : { kind: 'drawnCurve', points: [{ t: 0, value: (range.min + range.max) / 2 }, { t: 1, value: (range.min + range.max) / 2 }] };
            onChange({ signalModel: next });
          }}
          style={{ width: '100%' }}
        >
          <option value="constant">Konstant</option>
          <option value="randomWalk">Zufällig um Basiswert</option>
          <option value="drawnCurve">Kurve zeichnen</option>
        </select>
      </label>

      {model.kind === 'constant' && (
        <label>
          Wert ({range.unit})
          <input type="number" step="0.1" value={model.value} onChange={(e) => onChange({ signalModel: { kind: 'constant', value: Number(e.target.value) } })} style={{ width: '100%' }} />
        </label>
      )}

      {model.kind === 'randomWalk' && (
        <>
          <label>
            Basiswert ({range.unit})
            <input type="number" step="0.1" value={model.baseline} onChange={(e) => onChange({ signalModel: { ...model, baseline: Number(e.target.value) } })} style={{ width: '100%' }} />
          </label>
          <label>
            Streuung (Volatilität)
            <input type="number" step="0.1" min={0} value={model.volatility} onChange={(e) => onChange({ signalModel: { ...model, volatility: Number(e.target.value) } })} style={{ width: '100%' }} />
          </label>
          <label>
            Rückkehr zum Basiswert (0–1)
            <input type="number" step="0.05" min={0} max={1} value={model.meanReversion} onChange={(e) => onChange({ signalModel: { ...model, meanReversion: Number(e.target.value) } })} style={{ width: '100%' }} />
          </label>
        </>
      )}

      {model.kind === 'drawnCurve' && (
        <CurveEditor
          points={model.points}
          onChange={(points) => onChange({ signalModel: { kind: 'drawnCurve', points } })}
          valueMin={range.min}
          valueMax={range.max}
          unit={range.unit}
        />
      )}
    </>
  );
}

function BloodPressureModel({ track, onChange }: { track: BloodPressureTrack; onChange: (patch: Partial<BloodPressureTrack>) => void }) {
  const model = track.signalModel;
  const toneRange = { min: -20, max: 20, unit: 'Tonus-Einheiten' };

  return (
    <>
      <p style={{ fontSize: '0.85rem', color: '#555' }}>
        Systolisch und diastolisch werden gekoppelt aus einem gemeinsamen
        Verlauf ("Tonus") abgeleitet - MAP und Blutdruckamplitude werden
        automatisch berechnet.
      </p>
      <label>
        Basalwert systolisch (mmHg)
        <input type="number" value={model.baselineSystolic} onChange={(e) => onChange({ signalModel: { ...model, baselineSystolic: Number(e.target.value) } })} style={{ width: '100%' }} />
      </label>
      <label>
        Basalwert diastolisch (mmHg)
        <input type="number" value={model.baselineDiastolic} onChange={(e) => onChange({ signalModel: { ...model, baselineDiastolic: Number(e.target.value) } })} style={{ width: '100%' }} />
      </label>
      <label>
        Empfindlichkeit systolisch
        <input type="number" step="0.1" value={model.systolicSensitivity} onChange={(e) => onChange({ signalModel: { ...model, systolicSensitivity: Number(e.target.value) } })} style={{ width: '100%' }} />
      </label>
      <label>
        Empfindlichkeit diastolisch
        <input type="number" step="0.1" value={model.diastolicSensitivity} onChange={(e) => onChange({ signalModel: { ...model, diastolicSensitivity: Number(e.target.value) } })} style={{ width: '100%' }} />
      </label>
      <label>
        Tonus-Verlauf
        <select
          value={model.tone.kind}
          onChange={(e) => {
            const kind = e.target.value as 'constant' | 'randomWalk' | 'drawnCurve';
            const tone: BloodPressureTrack['signalModel']['tone'] =
              kind === 'constant' ? { kind: 'constant' }
              : kind === 'randomWalk' ? { kind: 'randomWalk', volatility: 2, meanReversion: 0.2 }
              : { kind: 'drawnCurve', points: [{ t: 0, value: 0 }, { t: 1, value: 0 }] };
            onChange({ signalModel: { ...model, tone } });
          }}
          style={{ width: '100%' }}
        >
          <option value="constant">Konstant (kein Tonus-Verlauf)</option>
          <option value="randomWalk">Zufällig</option>
          <option value="drawnCurve">Kurve zeichnen</option>
        </select>
      </label>
      {model.tone.kind === 'randomWalk' && (
        <>
          <label>
            Streuung (Volatilität)
            <input type="number" step="0.1" min={0} value={model.tone.volatility} onChange={(e) => onChange({ signalModel: { ...model, tone: { ...model.tone, volatility: Number(e.target.value) } as typeof model.tone } })} style={{ width: '100%' }} />
          </label>
          <label>
            Rückkehr zum Basiswert (0–1)
            <input type="number" step="0.05" min={0} max={1} value={model.tone.meanReversion} onChange={(e) => onChange({ signalModel: { ...model, tone: { ...model.tone, meanReversion: Number(e.target.value) } as typeof model.tone } })} style={{ width: '100%' }} />
          </label>
        </>
      )}
      {model.tone.kind === 'drawnCurve' && (
        <CurveEditor
          points={model.tone.points}
          onChange={(points) => onChange({ signalModel: { ...model, tone: { kind: 'drawnCurve', points } } })}
          valueMin={toneRange.min}
          valueMax={toneRange.max}
          unit={toneRange.unit}
        />
      )}
    </>
  );
}

/** Per-track config: mode selector (Constant/Random/Draw-curve), noise,
 * sampling override, missing-value rate - the union between a plain
 * SimpleTrack and the one coupled BloodPressureTrack (see
 * shared/types.ts's own comment on why blood pressure isn't two
 * independent tracks). */
export function TrackConfigPanel({ track, onChange }: Props) {
  return (
    <fieldset style={{ display: 'grid', gap: '0.6rem', border: '1px solid #ccc', borderRadius: 8, padding: '1rem' }}>
      <legend>Track-Einstellungen</legend>

      {track.type === 'bloodPressure'
        ? <BloodPressureModel track={track} onChange={onChange as (patch: Partial<BloodPressureTrack>) => void} />
        : <SimpleTrackModel track={track} onChange={onChange as (patch: Partial<SimpleTrack>) => void} />}

      <label>
        Rauschen (Standardabweichung)
        <input
          type="number" step="0.1" min={0}
          value={track.noise?.stdDev ?? 0}
          onChange={(e) => onChange({ noise: { stdDev: Number(e.target.value) } })}
          style={{ width: '100%' }}
        />
      </label>
      <label>
        Erfassungsintervall-Override (ISO-8601, leer = Szenario-Standard)
        <input
          type="text" placeholder="z.B. PT30M"
          value={track.sampling?.intervalIso ?? ''}
          onChange={(e) => onChange({ sampling: e.target.value ? { intervalIso: e.target.value } : undefined })}
          style={{ width: '100%' }}
        />
      </label>
      <label>
        Messausfall-Wahrscheinlichkeit (0–1)
        <input
          type="number" step="0.05" min={0} max={1}
          value={track.missingValueRate ?? 0}
          onChange={(e) => onChange({ missingValueRate: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
      </label>
    </fieldset>
  );
}
