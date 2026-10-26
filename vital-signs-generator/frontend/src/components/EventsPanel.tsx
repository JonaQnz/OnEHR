import type { DropoutEventEffect, EventEffect, ScenarioEvent, Track, TrackType } from '../../../shared/types';

interface Props {
  events: ScenarioEvent[];
  tracks: Track[];
  onChange: (events: ScenarioEvent[]) => void;
}

const TRACK_LABELS: Record<TrackType, string> = {
  heartRate: 'Herzfrequenz', respirationRate: 'Atemfrequenz', spo2: 'SpO₂', bodyTemperature: 'Temperatur', bloodPressure: 'Blutdruck',
};

function newEvent(): ScenarioEvent {
  return { id: `event-${Date.now()}`, label: 'Neues Ereignis', startTime: new Date().toISOString(), durationIso: 'PT45M', effects: [] };
}

function newEffect(track: TrackType): EventEffect {
  return { track, kind: 'offset', peakValue: 0 };
}

/** Manual editor for time-window interventions (see engine/events.ts) -
 * fever onset, desaturation, tachycardia, measurement dropout, etc. - on
 * top of whatever a track's own signal model already produces. Presets
 * (PresetPicker.tsx) populate this same list; this panel lets a user
 * hand-tune it or build events from scratch. */
export function EventsPanel({ events, tracks, onChange }: Props) {
  const availableTrackTypes = tracks.map((t) => t.type);

  function updateEvent(index: number, patch: Partial<ScenarioEvent>) {
    onChange(events.map((event, i) => (i === index ? { ...event, ...patch } : event)));
  }

  function updateEffect(eventIndex: number, effectIndex: number, patch: Partial<EventEffect> | Partial<DropoutEventEffect>) {
    const event = events[eventIndex];
    const effects = event.effects.map((effect, i) => (i === effectIndex ? ({ ...effect, ...patch } as EventEffect | DropoutEventEffect) : effect));
    updateEvent(eventIndex, { effects });
  }

  return (
    <fieldset style={{ border: '1px solid #ccc', borderRadius: 8, padding: '1rem' }}>
      <legend>Ereignisse</legend>
      {events.length === 0 && <p style={{ color: '#888', fontSize: '0.85rem' }}>Keine Ereignisse - Tracks folgen nur ihrem eigenen Verlauf.</p>}

      {/* Responsive card grid, not one full-width block per event - once
          Ereignisse spans the whole page width (App.tsx's own row-based
          layout), a single narrow event card stretched edge to edge would
          just spread its Start/Dauer fields awkwardly far apart. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem' }}>
      {events.map((event, eventIndex) => (
        <div key={event.id} style={{ border: '1px solid #ddd', borderRadius: 6, padding: '0.6rem' }}>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}>
            <input
              type="text" value={event.label}
              onChange={(e) => updateEvent(eventIndex, { label: e.target.value })}
              style={{ flex: 1, fontWeight: 600 }}
            />
            <button type="button" onClick={() => onChange(events.filter((_, i) => i !== eventIndex))} title="Ereignis entfernen" style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}>✕</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginBottom: '0.4rem' }}>
            <label style={{ fontSize: '0.8rem' }}>
              Start
              <input
                type="datetime-local" value={event.startTime.slice(0, 16)}
                onChange={(e) => updateEvent(eventIndex, { startTime: `${e.target.value}:00.000Z` })}
                style={{ width: '100%' }}
              />
            </label>
            <label style={{ fontSize: '0.8rem' }}>
              Dauer (ISO-8601)
              <input
                type="text" value={event.durationIso}
                onChange={(e) => updateEvent(eventIndex, { durationIso: e.target.value })}
                style={{ width: '100%' }}
              />
            </label>
          </div>

          {event.effects.map((effect, effectIndex) => (
            <div key={effectIndex} style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', marginBottom: '0.3rem', fontSize: '0.85rem' }}>
              <select value={effect.track} onChange={(e) => updateEffect(eventIndex, effectIndex, { track: e.target.value as TrackType })}>
                {availableTrackTypes.map((type) => <option key={type} value={type}>{TRACK_LABELS[type]}</option>)}
              </select>
              <select value={effect.kind} onChange={(e) => updateEffect(eventIndex, effectIndex, { kind: e.target.value as EventEffect['kind'] } as Partial<EventEffect>)}>
                <option value="offset">+/- Verschiebung</option>
                <option value="setLevel">Zielwert</option>
                <option value="dropout">Messausfall</option>
              </select>
              {effect.kind !== 'dropout' && (
                <input
                  type="number" value={effect.peakValue}
                  onChange={(e) => updateEffect(eventIndex, effectIndex, { peakValue: Number(e.target.value) } as Partial<EventEffect>)}
                  style={{ width: '5rem' }}
                />
              )}
              <button
                type="button"
                onClick={() => updateEvent(eventIndex, { effects: event.effects.filter((_, i) => i !== effectIndex) })}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => updateEvent(eventIndex, { effects: [...event.effects, newEffect(availableTrackTypes[0] ?? 'heartRate')] })}
            style={{ fontSize: '0.8rem' }}
          >
            + Effekt
          </button>
        </div>
      ))}
      </div>

      <button type="button" onClick={() => onChange([...events, newEvent()])} style={{ marginTop: '0.75rem', padding: '0.4rem 0.75rem' }}>
        + Ereignis hinzufügen
      </button>
    </fieldset>
  );
}
