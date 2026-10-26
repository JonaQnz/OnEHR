import { useState } from 'react';
import { PRESET_LIBRARY, applyPreset } from '../../../shared/presets';
import type { Scenario } from '../../../shared/types';

interface Props {
  scenario: Scenario;
  onApply: (scenario: Scenario) => void;
}

/** Loads a ready-made track+event bundle on top of the scenario's own
 * start time/duration/seed (see shared/presets.ts's applyPreset) -
 * replaces tracks/events, keeps everything else about the scenario as-is.
 * The <select> itself always resets to the placeholder after applying
 * (deliberately - once applied, the scenario is just an ordinary editable
 * scenario, and further hand-edits would make a "still selected" dropdown
 * lie about what's actually loaded), so a separate transient confirmation
 * message is what actually tells the user the click did something -
 * confirmed live this was genuinely confusing without it. */
export function PresetPicker({ scenario, onApply }: Props) {
  const [appliedLabel, setAppliedLabel] = useState<string | null>(null);

  return (
    <div>
      <label>
        Preset laden
        <select
          value=""
          onChange={(e) => {
            const preset = PRESET_LIBRARY.find((p) => p.id === e.target.value);
            if (!preset) return;
            onApply(applyPreset(scenario, preset));
            setAppliedLabel(preset.label);
          }}
          style={{ width: '100%' }}
        >
          <option value="">Preset wählen…</option>
          {PRESET_LIBRARY.map((preset) => (
            <option key={preset.id} value={preset.id} title={preset.description}>{preset.label}</option>
          ))}
        </select>
      </label>
      {appliedLabel && <p style={{ fontSize: '0.8rem', color: '#2fa84f', margin: '0.35rem 0 0' }}>✓ Preset geladen: {appliedLabel}</p>}
      <ul style={{ fontSize: '0.78rem', color: '#666', margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
        {PRESET_LIBRARY.map((preset) => (
          <li key={preset.id}><strong>{preset.label}:</strong> {preset.description}</li>
        ))}
      </ul>
    </div>
  );
}
