import React from 'react';
import { AqlResultMapping } from '../types/aqlPrefill';

export interface AqlMappingEditorProps {
  mappings: AqlResultMapping[];
  onChange: (mappings: AqlResultMapping[]) => void;
  availableFieldIds?: string[];
  availableGroupIds?: string[];
}

export function AqlMappingEditor({
  mappings,
  onChange,
  availableFieldIds = [],
  availableGroupIds = [],
}: AqlMappingEditorProps) {
  const addMapping = () => {
    const newMapping: AqlResultMapping = {
      id: `mapping_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      resultPath: '',
      target: {
        fieldId: availableFieldIds[0] || '',
      },
    };
    onChange([...mappings, newMapping]);
  };

  const updateMapping = (id: string, updates: Partial<AqlResultMapping>) => {
    onChange(
      mappings.map((item) => {
        if (item.id !== id) return item;
        return {
          ...item,
          ...updates,
          target: { ...item.target, ...(updates.target || {}) },
          metadata: { ...(item.metadata || {}), ...(updates.metadata || {}) },
        };
      })
    );
  };

  const removeMapping = (id: string) => {
    onChange(mappings.filter((item) => item.id !== id));
  };

  return (
    <div style={{ margin: '0.5rem 0', display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 style={{ margin: 0, fontSize: '0.85rem', color: '#1e293b' }}>Ergebnis-Mapping</h4>
        <button
          type="button"
          onClick={addMapping}
          style={{
            padding: '0.3rem 0.55rem',
            fontSize: '0.75rem',
            borderRadius: '6px',
            border: '1px solid #cbd5e1',
            background: '#ffffff',
            color: '#2563eb',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          + Mapping hinzufügen
        </button>
      </div>

      {mappings.length === 0 ? (
        <p style={{ color: '#64748b', fontSize: '0.78rem', fontStyle: 'italic', margin: 0 }}>
          Noch keine Mappings konfiguriert. Klicken Sie auf „+ Mapping hinzufügen“.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {mappings.map((mapping, idx) => (
            <div
              key={mapping.id}
              style={{
                padding: '0.65rem',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                background: '#f8fafc',
                display: 'flex',
                flexDirection: 'column',
                gap: '0.5rem',
              }}
            >
              {/* Header row with index & delete button */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: '#475569' }}>
                  Mapping #{idx + 1}
                </span>
                <button
                  type="button"
                  onClick={() => removeMapping(mapping.id)}
                  style={{
                    padding: '0.2rem 0.45rem',
                    fontSize: '0.75rem',
                    color: '#dc2626',
                    border: '1px solid #fecaca',
                    background: '#fef2f2',
                    borderRadius: '4px',
                    cursor: 'pointer',
                  }}
                  title="Mapping entfernen"
                >
                  ✕ entfernen
                </button>
              </div>

              {/* Field 1: Result Path */}
              <div>
                <label style={{ display: 'block', fontSize: '0.7rem', color: '#475569', fontWeight: 600, marginBottom: '0.15rem' }}>
                  AQL-Ergebnis-Pfad
                </label>
                <input
                  type="text"
                  value={mapping.resultPath}
                  placeholder="z. B. weight oder rows[0].weight"
                  onChange={(e) => updateMapping(mapping.id, { resultPath: e.target.value })}
                  style={{
                    width: '100%',
                    padding: '0.4rem',
                    fontSize: '0.8rem',
                    border: '1px solid #cbd5e1',
                    borderRadius: '4px',
                    fontFamily: 'monospace',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              {/* Field 2: Target Field ID */}
              <div>
                <label style={{ display: 'block', fontSize: '0.7rem', color: '#475569', fontWeight: 600, marginBottom: '0.15rem' }}>
                  Ziel-Formularfeld (fieldId)
                </label>
                {availableFieldIds.length > 0 ? (
                  <select
                    value={mapping.target.fieldId}
                    onChange={(e) => updateMapping(mapping.id, { target: { ...mapping.target, fieldId: e.target.value } })}
                    style={{
                      width: '100%',
                      padding: '0.4rem',
                      fontSize: '0.8rem',
                      border: '1px solid #cbd5e1',
                      borderRadius: '4px',
                      boxSizing: 'border-box',
                    }}
                  >
                    <option value="">Bitte wählen…</option>
                    {availableFieldIds.map((fieldId) => (
                      <option key={fieldId} value={fieldId}>
                        {fieldId}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={mapping.target.fieldId}
                    placeholder="z. B. bodyWeight"
                    onChange={(e) => updateMapping(mapping.id, { target: { ...mapping.target, fieldId: e.target.value } })}
                    style={{
                      width: '100%',
                      padding: '0.4rem',
                      fontSize: '0.8rem',
                      border: '1px solid #cbd5e1',
                      borderRadius: '4px',
                      boxSizing: 'border-box',
                    }}
                  />
                )}
              </div>

              {/* Field 3: Group / Cluster */}
              <div>
                <label style={{ display: 'block', fontSize: '0.7rem', color: '#475569', fontWeight: 600, marginBottom: '0.15rem' }}>
                  Gruppe / Cluster (optional)
                </label>
                {availableGroupIds.length > 0 ? (
                  <select
                    value={mapping.target.groupId || ''}
                    onChange={(e) => updateMapping(mapping.id, { target: { ...mapping.target, groupId: e.target.value || undefined } })}
                    style={{
                      width: '100%',
                      padding: '0.4rem',
                      fontSize: '0.8rem',
                      border: '1px solid #cbd5e1',
                      borderRadius: '4px',
                      boxSizing: 'border-box',
                    }}
                  >
                    <option value="">Keine Gruppe</option>
                    {availableGroupIds.map((groupId) => (
                      <option key={groupId} value={groupId}>
                        {groupId}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={mapping.target.groupId || ''}
                    placeholder="z. B. vitalSigns"
                    onChange={(e) => updateMapping(mapping.id, { target: { ...mapping.target, groupId: e.target.value || undefined } })}
                    style={{
                      width: '100%',
                      padding: '0.4rem',
                      fontSize: '0.8rem',
                      border: '1px solid #cbd5e1',
                      borderRadius: '4px',
                      boxSizing: 'border-box',
                    }}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
