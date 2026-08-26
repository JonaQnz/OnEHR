import { useEffect, useState } from 'react';
import { CHANGE_TYPE_LABELS, LIFECYCLE_STATE_LABELS, type CompositionVersion, type FormDefinitionV1, type RuntimeValues } from 'core';
import FormRuntime from './FormRuntime';

const API = 'http://localhost:3001/api';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: 'include',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function formatTimestamp(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('de-DE');
}

export interface HistoricalVersionViewProps {
  sessionId: string;
  versionUid: string;
  definition: FormDefinitionV1;
  patientId: string;
  ehrId?: string;
  onClose: () => void;
}

/**
 * Renders exactly one historical version, read-only, with NO FormSession
 * created or touched (§9/10) - FormRuntime is used directly with
 * mode='view' + readOnly=true (both already exist for the current-version
 * case), fed by this version's own mapped values. There is nothing here a
 * user could "save" - no draftReference/providerReference exists to ever
 * accidentally overwrite.
 */
export default function HistoricalVersionView({ sessionId, versionUid, definition, patientId, ehrId, onClose }: HistoricalVersionViewProps) {
  const [detail, setDetail] = useState<{ version: CompositionVersion; values: RuntimeValues } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    request<{ version: CompositionVersion; values: RuntimeValues }>(`/form-sessions/${encodeURIComponent(sessionId)}/provider/history/${encodeURIComponent(versionUid)}`)
      .then((result) => { if (!cancelled) setDetail(result); })
      .catch((e: any) => { if (!cancelled) setError(e.message || 'Version konnte nicht geladen werden.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, versionUid]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '2rem' }}>
      <div className="card" style={{ margin: 0, padding: 0, maxWidth: '820px', width: '100%', maxHeight: '90vh', overflow: 'auto', boxShadow: 'var(--shadow-lg, 0 10px 25px -5px rgba(0,0,0,0.2))' }}>
        <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--border, #e2e8f0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: 'var(--bg-card, #fff)' }}>
          <div>
            <strong>Historische Version</strong>
            <div style={{ fontSize: '0.8rem', color: 'var(--warning, #b45309)' }}>Diese Version ist schreibgeschützt.</div>
          </div>
          <button className="btn btn-secondary" onClick={onClose}>Schließen</button>
        </div>
        <div style={{ padding: '1.5rem' }}>
          {loading && <div style={{ color: 'var(--text-muted, #64748b)' }}>Lade Version…</div>}
          {error && <div style={{ color: 'var(--danger, #ef4444)' }}>{error}</div>}
          {detail && (
            <>
              {/* Audit Detail View (§23) - version metadata, distinct from the
                  clinical content rendered below. */}
              <div style={{ marginBottom: '1.5rem', background: 'var(--bg-sidebar, #f8fafc)', border: '1px solid var(--border, #e2e8f0)', borderRadius: '8px', padding: '0.9rem 1.1rem', fontSize: '0.85rem', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.3rem 1rem' }}>
                <span>Version UID</span><span style={{ overflowWrap: 'anywhere' }}>{detail.version.versionUid}</span>
                <span>Committed</span><span>{formatTimestamp(detail.version.committedAt)}</span>
                <span>Committer</span><span>{detail.version.committer?.name || '—'}</span>
                <span>Composer</span><span>{detail.version.composer?.name || '—'}</span>
                <span>Change Type</span><span>{CHANGE_TYPE_LABELS[detail.version.changeType]}</span>
                <span>Lifecycle</span><span>{LIFECYCLE_STATE_LABELS[detail.version.lifecycleState]}{!detail.version.lifecycleConfirmed ? ' (nicht bestätigt)' : ''}</span>
                {detail.version.changeDescription && <><span>Description</span><span>{detail.version.changeDescription}</span></>}
                {detail.version.contributionUid && <><span>Contribution</span><span style={{ overflowWrap: 'anywhere' }}>{detail.version.contributionUid}</span></>}
                {detail.version.precedingVersionUid && <><span>Preceding Version</span><span style={{ overflowWrap: 'anywhere' }}>{detail.version.precedingVersionUid}</span></>}
              </div>
              <FormRuntime
                definition={definition}
                initialValues={detail.values}
                patientId={patientId}
                ehrId={ehrId}
                readOnly
                showSubmit={false}
                mode="view"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
