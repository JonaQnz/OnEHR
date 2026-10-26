import type { Scenario } from '../../../shared/types';

interface Props {
  scenario: Scenario;
  onChange: (patch: Partial<Scenario>) => void;
}

/** Start time, duration, default sampling interval, seed - the scenario's
 * shared timeline (see engine/timeline.ts's master grid every track's own
 * sampling snaps onto). */
export function ScenarioPanel({ scenario, onChange }: Props) {
  return (
    <fieldset style={{ display: 'grid', gap: '0.6rem', border: '1px solid #ccc', borderRadius: 8, padding: '1rem' }}>
      <legend>Szenario</legend>
      <label>
        Name
        <input type="text" value={scenario.name ?? ''} onChange={(e) => onChange({ name: e.target.value })} style={{ width: '100%' }} />
      </label>
      <label>
        Startzeitpunkt
        <input
          type="datetime-local"
          value={scenario.startTime.slice(0, 16)}
          onChange={(e) => onChange({ startTime: `${e.target.value}:00.000Z` })}
          style={{ width: '100%' }}
        />
      </label>
      <label>
        Dauer (ISO-8601, z.B. PT24H)
        <input type="text" value={scenario.durationIso} onChange={(e) => onChange({ durationIso: e.target.value })} style={{ width: '100%' }} />
      </label>
      <label>
        Standard-Erfassungsintervall (ISO-8601, z.B. PT15M)
        <input
          type="text"
          value={scenario.defaultSamplingInterval}
          onChange={(e) => onChange({ defaultSamplingInterval: e.target.value })}
          style={{ width: '100%' }}
        />
      </label>
      <label>
        Zufalls-Seed
        <input
          type="number"
          value={scenario.seed ?? 1}
          onChange={(e) => onChange({ seed: Number(e.target.value) })}
          style={{ width: '100%' }}
        />
      </label>
    </fieldset>
  );
}
