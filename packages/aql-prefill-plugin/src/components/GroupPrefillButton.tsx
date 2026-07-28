import React from 'react';

export interface GroupPrefillButtonProps {
  groupId: string;
  groupLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  onApplyGroup: (groupId: string) => void;
}

export function GroupPrefillButton({
  groupId,
  groupLabel,
  loading = false,
  disabled = false,
  onApplyGroup,
}: GroupPrefillButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      onClick={() => onApplyGroup(groupId)}
      style={{
        fontSize: '0.78rem',
        padding: '0.35rem 0.7rem',
        borderRadius: '6px',
        border: '1px solid #93c5fd',
        background: '#eff6ff',
        color: '#1d4ed8',
        fontWeight: 600,
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.35rem',
      }}
    >
      {loading ? 'Gruppe wird geladen…' : `${groupLabel ? groupLabel + ' aus HIP laden' : 'Gruppe aus HIP laden'}`}
    </button>
  );
}
