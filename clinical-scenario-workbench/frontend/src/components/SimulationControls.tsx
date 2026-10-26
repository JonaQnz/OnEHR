import { useState } from 'react';
import { playScenario, resetScenarioRun, stepScenario, type ScenarioEvent } from '../api/client';

/** Spec section 31 - Step/Play/Instant/Reset. Every action here calls the
 * exact same backend endpoints (and therefore the exact same
 * scenario/engine.ts functions) an external agent driving this workbench
 * via MCP would call (execute_next_event/advance_scenario/reset_scenario) -
 * no separate "UI-only" scenario logic. */
export function SimulationControls({ scenarioRunId, onAdvanced, onReset }: {
  scenarioRunId: string;
  onAdvanced: (lastEvent: ScenarioEvent | null, finished: boolean) => void;
  onReset: () => void;
}) {
  const [busy, setBusy] = useState<'step' | 'play' | 'instant' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [finished, setFinished] = useState(false);

  const run = async (action: 'step' | 'play' | 'instant' | 'reset') => {
    setBusy(action);
    setError(null);
    try {
      if (action === 'step') {
        const result = await stepScenario(scenarioRunId);
        setFinished(result.finished);
        onAdvanced(result.event, result.finished);
      } else if (action === 'play') {
        const result = await playScenario(scenarioRunId, 1);
        setFinished(result.finished);
        onAdvanced(result.executed[0] ?? null, result.finished);
      } else if (action === 'instant') {
        const result = await playScenario(scenarioRunId);
        setFinished(result.finished);
        onAdvanced(result.executed[result.executed.length - 1] ?? null, result.finished);
      } else {
        await resetScenarioRun(scenarioRunId);
        setFinished(false);
        onReset();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
      <button type="button" className="btn" disabled={busy !== null || finished} onClick={() => run('step')}>
        {busy === 'step' ? '…' : '→ Step'}
      </button>
      <button type="button" className="btn" disabled={busy !== null || finished} onClick={() => run('play')}>
        {busy === 'play' ? '…' : '▶ Play'}
      </button>
      <button type="button" className="btn" disabled={busy !== null || finished} onClick={() => run('instant')}>
        {busy === 'instant' ? '…' : '⏭ Instant'}
      </button>
      <button
        type="button"
        onClick={() => run('reset')}
        disabled={busy !== null}
        style={{ border: '1px solid #cbd5e1', background: 'white', color: '#475569', borderRadius: '6px', padding: '0.5rem 1rem', cursor: 'pointer' }}
      >
        {busy === 'reset' ? '…' : '↺ Reset'}
      </button>
      {finished && <span style={{ color: '#15803d', fontSize: '0.85rem' }}>Szenario abgeschlossen</span>}
      {error && <span style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</span>}
    </div>
  );
}

export default SimulationControls;
