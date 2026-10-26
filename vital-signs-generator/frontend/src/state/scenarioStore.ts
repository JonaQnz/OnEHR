import { useCallback, useEffect, useState } from 'react';
import type { BloodPressureTrack, Scenario, SimpleTrack, Track } from '../../../shared/types';

const STORAGE_KEY = 'vital-signs-generator.scenario';

function defaultScenario(): Scenario {
  return {
    id: 'default',
    name: 'Neues Szenario',
    startTime: new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 16) + ':00.000Z',
    durationIso: 'PT24H',
    defaultSamplingInterval: 'PT15M',
    seed: 1,
    tracks: [
      { id: 'hr', type: 'heartRate', signalModel: { kind: 'randomWalk', baseline: 75, volatility: 3, meanReversion: 0.25 }, noise: { stdDev: 2 } } as SimpleTrack,
      { id: 'resp', type: 'respirationRate', signalModel: { kind: 'constant', value: 16 }, noise: { stdDev: 1 }, sampling: { intervalIso: 'PT30M' } } as SimpleTrack,
      { id: 'spo2', type: 'spo2', signalModel: { kind: 'randomWalk', baseline: 97, volatility: 0.6, meanReversion: 0.3 }, noise: { stdDev: 0.4 }, sampling: { intervalIso: 'PT15M' } } as SimpleTrack,
      { id: 'temp', type: 'bodyTemperature', signalModel: { kind: 'constant', value: 36.8 }, noise: { stdDev: 0.15 }, sampling: { intervalIso: 'PT4H' } } as SimpleTrack,
      {
        id: 'bp', type: 'bloodPressure',
        signalModel: {
          kind: 'randomWalk',
          tone: { kind: 'randomWalk', volatility: 2, meanReversion: 0.2 },
          baselineSystolic: 120, baselineDiastolic: 80, systolicSensitivity: 1.5, diastolicSensitivity: 1,
        },
        noise: { stdDev: 1 },
        sampling: { intervalIso: 'PT30M' },
      } as BloodPressureTrack,
    ],
  };
}

function loadInitialScenario(): Scenario {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Scenario;
  } catch {
    // fall through to default
  }
  return defaultScenario();
}

/** Local scenario state + localStorage persistence - deliberately no
 * backend "save" concept yet (MVP). Small enough to be a plain hook
 * rather than a full state-management library. */
export function useScenarioStore() {
  const [scenario, setScenario] = useState<Scenario>(loadInitialScenario);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scenario));
  }, [scenario]);

  const updateScenario = useCallback((patch: Partial<Scenario>) => {
    setScenario((current) => ({ ...current, ...patch }));
  }, []);

  const updateTrack = useCallback((trackId: string, patch: Partial<Track>) => {
    setScenario((current) => ({
      ...current,
      tracks: current.tracks.map((track) => (track.id === trackId ? ({ ...track, ...patch } as Track) : track)),
    }));
  }, []);

  const resetToDefault = useCallback(() => setScenario(defaultScenario()), []);

  return { scenario, setScenario, updateScenario, updateTrack, resetToDefault };
}
