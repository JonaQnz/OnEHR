import type { Track, TrackType } from '../../../shared/types';

const TRACK_LABELS: Record<TrackType, string> = {
  heartRate: '❤️ Herzfrequenz',
  respirationRate: '🫁 Atemfrequenz',
  spo2: '🩸 SpO₂',
  bodyTemperature: '🌡️ Temperatur',
  bloodPressure: '💉 Blutdruck',
};

const ALL_TRACK_TYPES: TrackType[] = ['heartRate', 'respirationRate', 'spo2', 'bodyTemperature', 'bloodPressure'];

interface Props {
  tracks: Track[];
  selectedTrackId: string | undefined;
  onSelect: (trackId: string) => void;
  onAdd: (type: TrackType) => void;
  onRemove: (trackId: string) => void;
}

export function TrackList({ tracks, selectedTrackId, onSelect, onAdd, onRemove }: Props) {
  const usedTypes = new Set(tracks.map((t) => t.type));
  const availableTypes = ALL_TRACK_TYPES.filter((type) => !usedTypes.has(type));

  return (
    <div style={{ display: 'grid', gap: '0.4rem' }}>
      {tracks.map((track) => (
        <div
          key={track.id}
          onClick={() => onSelect(track.id)}
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '0.5rem 0.75rem', borderRadius: 6, cursor: 'pointer',
            background: track.id === selectedTrackId ? '#e6f0ff' : '#f5f5f5',
            border: track.id === selectedTrackId ? '1px solid #4a90e2' : '1px solid transparent',
          }}
        >
          <span>{TRACK_LABELS[track.type]}</span>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(track.id); }}
            title="Entfernen"
            style={{ border: 'none', background: 'transparent', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      ))}
      {availableTypes.length > 0 && (
        <select
          value=""
          onChange={(e) => { if (e.target.value) onAdd(e.target.value as TrackType); }}
          style={{ marginTop: '0.5rem' }}
        >
          <option value="">+ Track hinzufügen…</option>
          {availableTypes.map((type) => (
            <option key={type} value={type}>{TRACK_LABELS[type]}</option>
          ))}
        </select>
      )}
    </div>
  );
}
