import React from 'react';
import { AqlParameterBinding, AqlPrefillConfiguration } from '../types/aqlPrefill';
import { AqlMappingEditor } from './AqlMappingEditor';
import { AqlTestPanel } from './AqlTestPanel';

export interface AqlPrefillEditorProps {
  config: AqlPrefillConfiguration;
  onChange: (updated: AqlPrefillConfiguration) => void;
  availableFieldIds?: string[];
  availableGroupIds?: string[];
}

export function AqlPrefillEditor({
  config,
  onChange,
  availableFieldIds = [],
  availableGroupIds = [],
}: AqlPrefillEditorProps) {
  const update = (updates: Partial<AqlPrefillConfiguration>) => {
    onChange({ ...config, ...updates });
  };

  const updateQuery = (queryUpdates: Partial<AqlPrefillConfiguration['query']>) => {
    onChange({
      ...config,
      query: { ...(config.query || {}), ...queryUpdates },
    });
  };

  const updateBehavior = (behaviorUpdates: Partial<AqlPrefillConfiguration['behavior']>) => {
    onChange({
      ...config,
      behavior: { ...(config.behavior || {}), ...behaviorUpdates },
    });
  };

  const addParameter = () => {
    const newParam: AqlParameterBinding = {
      queryParameter: '$ehrId',
      source: 'ehrId',
    };
    onChange({
      ...config,
      parameters: [...(config.parameters || []), newParam],
    });
  };

  const updateParameter = (index: number, updates: Partial<AqlParameterBinding>) => {
    const updated = [...(config.parameters || [])];
    updated[index] = { ...updated[index], ...updates };
    onChange({ ...config, parameters: updated });
  };

  const removeParameter = (index: number) => {
    onChange({
      ...config,
      parameters: (config.parameters || []).filter((_, idx) => idx !== index),
    });
  };

  return (
    <div style={{ padding: '0.85rem', border: '1px solid #e2e8f0', borderRadius: '10px', background: '#ffffff', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <h3 style={{ marginTop: 0, color: '#0f172a', fontSize: '1rem', margin: 0 }}>AQL-Vorbelegung</h3>

      {/* Main Settings - Vertical Stack (untereinander) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        <div>
          <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#334155', marginBottom: '0.3rem' }}>
            Name der Abfrage
          </label>
          <input
            type="text"
            value={config.name || ''}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="z. B. Patient Vitalparameter Prefill"
            style={{ width: '100%', padding: '0.45rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.82rem', boxSizing: 'border-box' }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#334155', marginBottom: '0.3rem' }}>
            Abfragemodus
          </label>
          <select
            value={config.queryMode || 'latest'}
            onChange={(e) => update({ queryMode: e.target.value as any })}
            style={{ width: '100%', padding: '0.45rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.82rem', boxSizing: 'border-box' }}
          >
            <option value="latest">Neuester Wert (Latest)</option>
            <option value="earliest">Ältester Wert (Earliest)</option>
            <option value="custom">Eigene AQL-Abfrage (Custom)</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#334155', marginBottom: '0.3rem' }}>
            Ausführung
          </label>
          <select
            value={config.executionMode || 'manual'}
            onChange={(e) => update({ executionMode: e.target.value as any })}
            style={{ width: '100%', padding: '0.45rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.82rem', boxSizing: 'border-box' }}
          >
            <option value="manual">Manuell (über Button)</option>
            <option value="automatic">Automatisch beim Öffnen</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#334155', marginBottom: '0.3rem' }}>
            Zeitstempel-Spalte (optional)
          </label>
          <input
            type="text"
            value={config.query?.timeColumn || ''}
            onChange={(e) => updateQuery({ timeColumn: e.target.value })}
            placeholder="c/context/start_time/value"
            style={{ width: '100%', padding: '0.45rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.82rem', boxSizing: 'border-box' }}
          />
        </div>
      </div>

      <div>
        <label style={{ display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#334155', marginBottom: '0.3rem' }}>
          AQL beziehungsweise Query-Konfiguration
        </label>
        <textarea
          rows={4}
          value={config.query?.aql || ''}
          onChange={(e) => updateQuery({ aql: e.target.value })}
          placeholder="SELECT c/content[openEHR-EHR-OBSERVATION.vital_signs.v1]/data[at0001]/events[at0002]/data[at0003]/items[at0004]/value/magnitude AS weight FROM COMPOSITION c WHERE c/ehr_id/value = $ehrId"
          style={{
            width: '100%',
            padding: '0.5rem',
            borderRadius: '6px',
            border: '1px solid #cbd5e1',
            fontFamily: 'monospace',
            fontSize: '0.8rem',
            resize: 'vertical',
            background: '#fafafa',
            boxSizing: 'border-box',
          }}
        />
      </div>

      {/* Parameter Bindings - Vertical Cards (untereinander) */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 style={{ margin: 0, fontSize: '0.85rem', color: '#1e293b' }}>Parameter</h4>
          <button
            type="button"
            onClick={addParameter}
            style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#ffffff', color: '#2563eb', cursor: 'pointer', fontWeight: 600 }}
          >
            + Parameter hinzufügen
          </button>
        </div>

        {(config.parameters || []).map((param, index) => (
          <div
            key={index}
            style={{
              padding: '0.65rem',
              border: '1px solid #e2e8f0',
              borderRadius: '6px',
              background: '#f8fafc',
              display: 'flex',
              flexDirection: 'column',
              gap: '0.45rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569' }}>Parameter #{index + 1}</span>
              <button
                type="button"
                onClick={() => removeParameter(index)}
                style={{ color: '#dc2626', border: '1px solid #fecaca', background: '#fef2f2', padding: '0.2rem 0.45rem', borderRadius: '4px', cursor: 'pointer', fontSize: '0.75rem' }}
              >
                ✕ entfernen
              </button>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 500, marginBottom: '0.15rem' }}>
                Query Parameter Name
              </label>
              <input
                type="text"
                value={param.queryParameter}
                placeholder="$ehrId"
                onChange={(e) => updateParameter(index, { queryParameter: e.target.value })}
                style={{ width: '100%', padding: '0.4rem', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.8rem', fontFamily: 'monospace', boxSizing: 'border-box' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 500, marginBottom: '0.15rem' }}>
                Datenquelle
              </label>
              <select
                value={param.source}
                onChange={(e) => updateParameter(index, { source: e.target.value as any })}
                style={{ width: '100%', padding: '0.4rem', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.8rem', boxSizing: 'border-box' }}
              >
                <option value="ehrId">ehrId</option>
                <option value="patientId">patientId</option>
                <option value="encounterId">encounterId</option>
                <option value="compositionId">compositionId</option>
                <option value="formField">Formularfeld</option>
                <option value="static">Statischer Wert</option>
              </select>
            </div>

            {param.source === 'formField' && (
              <div>
                <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 500, marginBottom: '0.15rem' }}>
                  Formularfeld wählen
                </label>
                <select
                  value={param.fieldId || ''}
                  onChange={(e) => updateParameter(index, { fieldId: e.target.value })}
                  style={{ width: '100%', padding: '0.4rem', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.8rem', boxSizing: 'border-box' }}
                >
                  <option value="">Feld wählen…</option>
                  {availableFieldIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {param.source === 'static' && (
              <div>
                <label style={{ display: 'block', fontSize: '0.7rem', color: '#64748b', fontWeight: 500, marginBottom: '0.15rem' }}>
                  Statischer Wert
                </label>
                <input
                  type="text"
                  value={String(param.staticValue ?? '')}
                  placeholder="Wert"
                  onChange={(e) => updateParameter(index, { staticValue: e.target.value })}
                  style={{ width: '100%', padding: '0.4rem', borderRadius: '4px', border: '1px solid #cbd5e1', fontSize: '0.8rem', boxSizing: 'border-box' }}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Field Level Configuration */}
      <div style={{ padding: '0.75rem', border: '1px solid #e2e8f0', borderRadius: '6px', background: '#f8fafc' }}>
        <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.82rem', color: '#334155' }}>Feld-spezifisches Verhalten</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', maxHeight: '300px', overflowY: 'auto', paddingRight: '0.5rem' }}>
          {availableFieldIds.length === 0 ? (
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>Keine Formularfelder verfügbar</span>
          ) : (
            availableFieldIds.map(fieldId => {
              const fieldConfig = (config.fieldConfigs || []).find(c => c.fieldId === fieldId) || { fieldId, behavior: 'auto' };
              return (
                <div key={fieldId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.4rem', borderBottom: '1px solid #e2e8f0' }}>
                  <span style={{ fontSize: '0.75rem', color: '#1e293b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '60%' }} title={fieldId}>
                    {fieldId}
                  </span>
                  <select
                    value={fieldConfig.behavior}
                    onChange={(e) => {
                      const newBehavior = e.target.value as any;
                      const existingConfigs = config.fieldConfigs || [];
                      const updatedConfigs = existingConfigs.filter(c => c.fieldId !== fieldId);
                      updatedConfigs.push({ fieldId, behavior: newBehavior });
                      update({ fieldConfigs: updatedConfigs });
                    }}
                    style={{ fontSize: '0.75rem', padding: '0.2rem', borderRadius: '4px', border: '1px solid #cbd5e1' }}
                  >
                    <option value="auto">Auto (Standard)</option>
                    <option value="button">Nur via Button</option>
                    <option value="none">Deaktiviert</option>
                  </select>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Mappings Editor - Hidden by default as fallback */}
      <details style={{ background: '#f8fafc', padding: '0.75rem', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
        <summary style={{ fontSize: '0.82rem', fontWeight: 600, color: '#334155', cursor: 'pointer', outline: 'none' }}>
          Manuelles Fallback-Mapping (Optional)
        </summary>
        <div style={{ marginTop: '0.75rem' }}>
          <p style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '0.5rem', marginTop: 0 }}>
            Nutzen Sie dieses manuelle Mapping nur in Ausnahmefällen. Standardmäßig werden Formularfelder 
            automatisch anhand ihres openEHR-Pfades (aqlPath) aufgelöst und befüllt.
          </p>
          <AqlMappingEditor
            mappings={config.mappings || []}
            onChange={(mappings) => update({ mappings })}
            availableFieldIds={availableFieldIds}
            availableGroupIds={availableGroupIds}
          />
        </div>
      </details>

      {/* Behavior Controls - Vertical Stack (untereinander) */}
      <div style={{ padding: '0.75rem', border: '1px solid #e2e8f0', borderRadius: '6px', background: '#f8fafc' }}>
        <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.82rem', color: '#334155' }}>Verhalten</h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', fontSize: '0.78rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input
              type="checkbox"
              checked={config.behavior?.showSource ?? true}
              onChange={(e) => updateBehavior({ showSource: e.target.checked })}
            />
            Quelle anzeigen
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input
              type="checkbox"
              checked={config.behavior?.showTimestamp ?? true}
              onChange={(e) => updateBehavior({ showTimestamp: e.target.checked })}
            />
            Zeitpunkt anzeigen
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input
              type="checkbox"
              checked={config.behavior?.confirmOverwrite ?? true}
              onChange={(e) => updateBehavior({ confirmOverwrite: e.target.checked })}
            />
            Vor Überschreiben nachfragen (Überschreibschutz)
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input
              type="checkbox"
              checked={config.behavior?.cacheResult ?? true}
              onChange={(e) => updateBehavior({ cacheResult: e.target.checked })}
            />
            Ergebnis in Session cachen
          </label>
        </div>
      </div>

      {/* Test Panel */}
      <AqlTestPanel config={config} />
    </div>
  );
}
