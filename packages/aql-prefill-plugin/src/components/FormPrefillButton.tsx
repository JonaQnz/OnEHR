import React from 'react';

export interface FormPrefillButtonProps {
  loading?: boolean;
  disabled?: boolean;
  isCached?: boolean;
  onApplyForm: () => void;
  onRefreshData?: () => void;
}

export function FormPrefillButton({
  loading = false,
  disabled = false,
  isCached = false,
  onApplyForm,
  onRefreshData,
}: FormPrefillButtonProps) {
  return (
    <div style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center' }}>
      <button
        type="button"
        disabled={disabled || loading}
        onClick={onApplyForm}
        style={{
          fontSize: '0.82rem',
          padding: '0.45rem 0.85rem',
          borderRadius: '6px',
          border: 'none',
          background: '#2563eb',
          color: '#ffffff',
          fontWeight: 600,
          cursor: disabled || loading ? 'not-allowed' : 'pointer',
          boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
        }}
      >
        {loading ? 'Patientendaten werden geladen…' : 'Patientendaten aus HIP laden'}
      </button>

      {onRefreshData && (
        <button
          type="button"
          disabled={disabled || loading}
          onClick={onRefreshData}
          title="Erneut vom Server abfragen und Cache ersetzen"
          style={{
            fontSize: '0.78rem',
            padding: '0.45rem 0.7rem',
            borderRadius: '6px',
            border: '1px solid #cbd5e1',
            background: '#ffffff',
            color: '#475569',
            cursor: disabled || loading ? 'not-allowed' : 'pointer',
          }}
        >
          Daten aktualisieren
        </button>
      )}
    </div>
  );
}
