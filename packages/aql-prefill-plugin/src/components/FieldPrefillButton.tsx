import React from 'react';
import { PrefillFieldState, PrefillProvenance } from '../types/aqlPrefill';

export type FieldPrefillStatus =
  | 'idle'
  | 'loading'
  | 'applied'
  | 'reload'
  | 'no_value'
  | 'error';

export interface FieldPrefillButtonProps {
  fieldId: string;
  status: FieldPrefillStatus;
  disabled?: boolean;
  fieldState?: PrefillFieldState;
  provenance?: PrefillProvenance;
  onApplyField: (fieldId: string) => void;
  errorMessage?: string;
}

export function FieldPrefillButton({
  fieldId,
  status,
  disabled = false,
  fieldState,
  provenance,
  onApplyField,
  errorMessage,
}: FieldPrefillButtonProps) {
  const getButtonText = (): string => {
    switch (status) {
      case 'loading':
        return 'Wird geladen…';
      case 'applied':
        return 'Übernommen';
      case 'reload':
        return 'Neu laden';
      case 'no_value':
        return 'Kein Wert gefunden';
      case 'error':
        return 'Fehler beim Laden';
      case 'idle':
      default:
        return 'Aus HIP laden';
    }
  };

  const isSuccess = status === 'applied';
  const isError = status === 'error';
  const isNoValue = status === 'no_value';

  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.2rem' }}>
      <button
        type="button"
        disabled={disabled || status === 'loading'}
        onClick={() => onApplyField(fieldId)}
        style={{
          fontSize: '0.75rem',
          padding: '0.3rem 0.6rem',
          borderRadius: '4px',
          border: isError ? '1px solid #fecaca' : isSuccess ? '1px solid #bbf7d0' : '1px solid #cbd5e1',
          background: isError ? '#fef2f2' : isSuccess ? '#f0fdf4' : '#ffffff',
          color: isError ? '#dc2626' : isSuccess ? '#15803d' : '#2563eb',
          fontWeight: 500,
          cursor: disabled || status === 'loading' ? 'not-allowed' : 'pointer',
          transition: 'all 0.15s ease',
        }}
      >
        {getButtonText()}
      </button>

      {/* Provenance badge under field */}
      {fieldState?.source === 'aql-prefill' && provenance && (
        <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '0.15rem' }}>
          <span>Aus HIP übernommen</span>
          {provenance.sourceTimestamp && (
            <span> · Dokumentiert am {new Date(provenance.sourceTimestamp).toLocaleDateString('de-DE')}</span>
          )}
        </div>
      )}

      {/* Error detail tooltip/text */}
      {isError && errorMessage && (
        <span style={{ fontSize: '0.7rem', color: '#dc2626' }}>{errorMessage}</span>
      )}
    </div>
  );
}
