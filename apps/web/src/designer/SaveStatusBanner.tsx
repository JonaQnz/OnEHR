import type { FormSaveStatus } from './formSaveCoordinator';

export interface SaveStatusBannerProps {
  status: FormSaveStatus;
  /** Error text for an ordinary save failure. */
  error?: string | null;
  /** Text for a revision conflict; defaults to a generic hint. */
  conflictMessage?: string | null;
  /** Resend the newest local draft after reloading the server revision. */
  onResend?: () => void;
  /** Retry an ordinary transport/server error. */
  onRetry?: () => void;
  busy?: boolean;
}

/**
 * Visible save state for the designer. A conflict is deliberately not a
 * transient toast: it stays until the user either resends the local draft or
 * reloads, so no local work disappears silently.
 */
export function SaveStatusBanner({
  status,
  error,
  conflictMessage,
  onResend,
  onRetry,
  busy = false,
}: SaveStatusBannerProps) {
  if (status === 'conflict') {
    return (
      <div className="save-status-banner conflict" role="status" aria-live="polite">
        <strong>Konflikt:</strong>{' '}
        {conflictMessage || 'Das Formular wurde in einem anderen Tab geändert. Deine lokalen Änderungen bleiben erhalten.'}
        {onResend && (
          <button type="button" className="btn-workbench secondary save-status-action" onClick={onResend} disabled={busy}>
            {busy ? 'Sendet…' : 'Erneut senden'}
          </button>
        )}
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="save-status-banner error" role="status" aria-live="polite">
        <strong>Speichern fehlgeschlagen:</strong> {error || 'Unbekannter Fehler.'}
        {onRetry && (
          <button type="button" className="btn-workbench secondary save-status-action" onClick={onRetry} disabled={busy}>
            {busy ? 'Versucht…' : 'Erneut versuchen'}
          </button>
        )}
      </div>
    );
  }

  if (status === 'saving' || status === 'pending' || status === 'exclusive') {
    const label = status === 'exclusive'
      ? 'Formular wird durch eine Aktion geändert…'
      : status === 'pending' ? 'Änderungen warten auf Speicherung…' : 'Speichert…';
    return (
      <div className="save-status-banner busy" role="status" aria-live="polite">{label}</div>
    );
  }

  return null;
}
