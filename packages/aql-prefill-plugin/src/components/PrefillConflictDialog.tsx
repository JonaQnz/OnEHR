import React, { useState } from 'react';

export interface ConflictItem {
  fieldId: string;
  fieldLabel?: string;
  currentValue: unknown;
  prefillValue: unknown;
}

export interface PrefillConflictDialogProps {
  conflicts: ConflictItem[];
  isOpen: boolean;
  onKeepManual: () => void;
  onOverwriteAll: () => void;
  onCancel: () => void;
  onSelectIndividual?: (selectedFieldIds: string[]) => void;
}

function formatVal(val: unknown): string {
  if (val === undefined || val === null) return '(leer)';
  if (typeof val === 'object') {
    const rec = val as Record<string, unknown>;
    if (rec.magnitude !== undefined) return `${rec.magnitude} ${rec.unit || ''}`.trim();
    return JSON.stringify(val);
  }
  return String(val);
}

export function PrefillConflictDialog({
  conflicts,
  isOpen,
  onKeepManual,
  onOverwriteAll,
  onCancel,
  onSelectIndividual,
}: PrefillConflictDialogProps) {
  const [selectedForOverwrite, setSelectedForOverwrite] = useState<Set<string>>(
    () => new Set(conflicts.map((c) => c.fieldId))
  );

  if (!isOpen || conflicts.length === 0) return null;

  const toggleField = (fieldId: string) => {
    const next = new Set(selectedForOverwrite);
    if (next.has(fieldId)) {
      next.delete(fieldId);
    } else {
      next.add(fieldId);
    }
    setSelectedForOverwrite(next);
  };

  const handleApplyIndividual = () => {
    onSelectIndividual?.(Array.from(selectedForOverwrite));
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: '#ffffff',
          borderRadius: '12px',
          padding: '1.5rem',
          maxWidth: '540px',
          width: '100%',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)',
        }}
      >
        <h3 style={{ margin: '0 0 0.5rem 0', color: '#0f172a', fontSize: '1.1rem' }}>
          Konflikt beim Vorbelegen
        </h3>
        <p style={{ margin: '0 0 1rem 0', color: '#475569', fontSize: '0.85rem' }}>
          Folgende Felder enthalten bereits manuelle Eingaben. Bitte wählen Sie, wie diese behandelt werden sollen:
        </p>

        <div style={{ maxHeight: '240px', overflowY: 'auto', marginBottom: '1.25rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {conflicts.map((item) => (
            <div
              key={item.fieldId}
              style={{
                padding: '0.75rem',
                border: '1px solid #e2e8f0',
                borderRadius: '8px',
                background: '#f8fafc',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.35rem' }}>
                <strong style={{ fontSize: '0.85rem', color: '#1e293b' }}>
                  {item.fieldLabel || item.fieldId}
                </strong>
                {onSelectIndividual && (
                  <label style={{ fontSize: '0.75rem', color: '#2563eb', display: 'flex', alignItems: 'center', gap: '0.3rem', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedForOverwrite.has(item.fieldId)}
                      onChange={() => toggleField(item.fieldId)}
                    />
                    Überschreiben
                  </label>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', fontSize: '0.8rem' }}>
                <div style={{ color: '#dc2626' }}>
                  <strong>Aktuell:</strong> {formatVal(item.currentValue)}
                </div>
                <div style={{ color: '#16a34a' }}>
                  <strong>HIP:</strong> {formatVal(item.prefillValue)}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={onCancel}
            style={{
              padding: '0.5rem 0.85rem',
              fontSize: '0.82rem',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              background: '#ffffff',
              color: '#475569',
              cursor: 'pointer',
            }}
          >
            Abbrechen
          </button>

          <button
            type="button"
            onClick={onKeepManual}
            style={{
              padding: '0.5rem 0.85rem',
              fontSize: '0.82rem',
              borderRadius: '6px',
              border: '1px solid #cbd5e1',
              background: '#ffffff',
              color: '#1e293b',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Manuelle Werte behalten
          </button>

          {onSelectIndividual && (
            <button
              type="button"
              onClick={handleApplyIndividual}
              style={{
                padding: '0.5rem 0.85rem',
                fontSize: '0.82rem',
                borderRadius: '6px',
                border: '1px solid #93c5fd',
                background: '#eff6ff',
                color: '#1d4ed8',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Auswahl übernehmen
            </button>
          )}

          <button
            type="button"
            onClick={onOverwriteAll}
            style={{
              padding: '0.5rem 0.85rem',
              fontSize: '0.82rem',
              borderRadius: '6px',
              border: 'none',
              background: '#dc2626',
              color: '#ffffff',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Werte aus HIP übernehmen
          </button>
        </div>
      </div>
    </div>
  );
}
