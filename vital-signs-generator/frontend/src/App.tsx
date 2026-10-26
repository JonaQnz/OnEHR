import { useEffect, useState } from 'react';
import { useScenarioStore } from './state/scenarioStore';
import { ScenarioPanel } from './components/ScenarioPanel';
import { TrackList } from './components/TrackList';
import { TrackConfigPanel } from './components/TrackConfigPanel';
import { PresetPicker } from './components/PresetPicker';
import { EventsPanel } from './components/EventsPanel';
import { PreviewChart } from './components/PreviewChart';
import { GenerateButton } from './components/GenerateButton';
import { previewScenario } from './api/generatorClient';
import type { Timepoint, Track, TrackType } from '../../shared/types';

function defaultTrackFor(type: TrackType): Track {
  const id = `${type}-${Date.now()}`;
  if (type === 'bloodPressure') {
    return {
      id, type,
      signalModel: {
        kind: 'randomWalk',
        tone: { kind: 'randomWalk', volatility: 2, meanReversion: 0.2 },
        baselineSystolic: 120, baselineDiastolic: 80, systolicSensitivity: 1.5, diastolicSensitivity: 1,
      },
    };
  }
  const defaults: Record<Exclude<TrackType, 'bloodPressure'>, number> = { heartRate: 75, respirationRate: 16, spo2: 97, bodyTemperature: 36.8 };
  return { id, type, signalModel: { kind: 'constant', value: defaults[type] } };
}

export default function App() {
  const { scenario, updateScenario, updateTrack, setScenario } = useScenarioStore();
  const [selectedTrackId, setSelectedTrackId] = useState<string | undefined>(scenario.tracks[0]?.id);
  const [timepoints, setTimepoints] = useState<Timepoint[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    previewScenario(scenario)
      .then((result) => { if (!cancelled) { setTimepoints(result); setPreviewError(null); } })
      .catch((err) => { if (!cancelled) setPreviewError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [scenario]);

  const selectedTrack = scenario.tracks.find((t) => t.id === selectedTrackId);

  function handleAddTrack(type: TrackType) {
    const track = defaultTrackFor(type);
    setScenario((current) => ({ ...current, tracks: [...current.tracks, track] }));
    setSelectedTrackId(track.id);
  }

  function handleRemoveTrack(trackId: string) {
    setScenario((current) => ({ ...current, tracks: current.tracks.filter((t) => t.id !== trackId) }));
    if (selectedTrackId === trackId) setSelectedTrackId(undefined);
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1200, margin: '0 auto', padding: '1.5rem' }}>
      <h1>Vitalzeichen-Generator</h1>
      <p style={{ color: '#666' }}>
        Simuliert einen Vitalzeichen-Verlauf über die Zeit und schreibt ihn als
        Serie echter openEHR-Compositions über die Forms-API nach EHRbase.
      </p>

      {/* Explicit stacked ROWS, not two independent full-height columns -
          confirmed live that a rigid 2-column layout let the left column
          (Tracks + Ereignisse, which can grow arbitrarily long as events
          are added) run on far past the right column's short content,
          leaving unrelated sections sitting side by side at the same
          scroll position - reads as "everything overlaps", even though no
          element is literally drawn on top of another. Only the top row
          (Szenario/Tracks+Config, genuinely similar in height) uses a
          side-by-side grid; Vorschau and Ereignisse each get their own
          full-width row below it. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 340px) 1fr', gap: '1.5rem', marginTop: '1.5rem', alignItems: 'start' }}>
        <div style={{ display: 'grid', gap: '1rem' }}>
          <ScenarioPanel scenario={scenario} onChange={updateScenario} />
          <PresetPicker scenario={scenario} onApply={setScenario} />
          <div>
            <h3>Tracks</h3>
            <TrackList
              tracks={scenario.tracks}
              selectedTrackId={selectedTrackId}
              onSelect={setSelectedTrackId}
              onAdd={handleAddTrack}
              onRemove={handleRemoveTrack}
            />
          </div>
        </div>

        <div>
          {selectedTrack ? (
            <TrackConfigPanel track={selectedTrack} onChange={(patch) => updateTrack(selectedTrack.id, patch)} />
          ) : (
            <p style={{ color: '#888' }}>Track links auswählen oder hinzufügen, um ihn zu konfigurieren.</p>
          )}
        </div>
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <h3>Vorschau</h3>
        {previewError ? <p style={{ color: '#c0392b' }}>{previewError}</p> : <PreviewChart timepoints={timepoints} events={scenario.events} />}
        <p style={{ fontSize: '0.85rem', color: '#666' }}>{timepoints.length} Zeitpunkte in dieser Vorschau.</p>
      </div>

      <div style={{ marginTop: '1.5rem' }}>
        <EventsPanel
          events={scenario.events ?? []}
          tracks={scenario.tracks}
          onChange={(events) => updateScenario({ events })}
        />
      </div>

      <div style={{ marginTop: '1.5rem', maxWidth: 480 }}>
        <GenerateButton scenario={scenario} />
      </div>
    </div>
  );
}
