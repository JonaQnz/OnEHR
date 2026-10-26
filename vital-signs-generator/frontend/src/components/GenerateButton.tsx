import { useState } from 'react';
import type { Scenario } from '../../../shared/types';
import { getGenerationProgress, startGeneration, type GenerationProgress } from '../api/generatorClient';

interface Props {
  scenario: Scenario;
}

const POLL_INTERVAL_MS = 1000;

/** Patient/EHR target + trigger for a real generation run against the
 * Forms API, with polling progress (see backend/src/routes/scenarios.ts's
 * job store - a full run is one HTTP round trip per timepoint, easily
 * many seconds for a real scenario, so this is not a synchronous call). */
export function GenerateButton({ scenario }: Props) {
  const [patientId, setPatientId] = useState('');
  const [ehrId, setEhrId] = useState('');
  const [progress, setProgress] = useState<GenerationProgress | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleGenerate() {
    if (!patientId || !ehrId) {
      setError('patientId und ehrId werden benötigt (siehe Patientenliste oder MCP create_patient).');
      return;
    }
    setError(null);
    setStatus('running');
    try {
      const { jobId } = await startGeneration(scenario, { patientId, ehrId });
      const poll = async () => {
        const { status: jobStatus, progress: jobProgress } = await getGenerationProgress(jobId);
        setProgress(jobProgress);
        if (jobStatus === 'done') {
          setStatus('done');
          return;
        }
        setTimeout(poll, POLL_INTERVAL_MS);
      };
      await poll();
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const failedCount = progress?.results.filter((r) => r.status === 'error').length ?? 0;

  return (
    <fieldset style={{ display: 'grid', gap: '0.6rem', border: '1px solid #ccc', borderRadius: 8, padding: '1rem' }}>
      <legend>Generieren</legend>
      <label>
        Patient-ID
        <input type="text" value={patientId} onChange={(e) => setPatientId(e.target.value)} style={{ width: '100%' }} />
      </label>
      <label>
        EHR-ID
        <input type="text" value={ehrId} onChange={(e) => setEhrId(e.target.value)} style={{ width: '100%' }} />
      </label>
      <button type="button" onClick={handleGenerate} disabled={status === 'running'} style={{ padding: '0.5rem 1rem' }}>
        {status === 'running' ? 'Generiere…' : 'Vitaldaten generieren'}
      </button>
      {error && <p style={{ color: '#c0392b' }}>{error}</p>}
      {progress && (
        <p>
          {progress.completed} / {progress.total} Zeitpunkte verarbeitet
          {failedCount > 0 ? ` (${failedCount} fehlgeschlagen)` : ''}
          {status === 'done' ? ' — fertig.' : ''}
        </p>
      )}
    </fieldset>
  );
}
