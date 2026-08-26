import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { CHANGE_TYPE_LABELS, LIFECYCLE_STATE_LABELS, type CompositionVersion } from 'core';

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
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export interface CompositionHistoryPanelProps {
  sessionId: string;
  /** Bump this (e.g. session.revision) after a save so the panel refetches -
   * this app has no standing history cache, so "invalidate after save"
   * (§25) is just a re-fetch trigger, matching Epic 2's own pattern. */
  refreshKey?: number | string;
  onOpenVersion: (versionUid: string) => void;
  onCompare: (fromVersionUid: string, toVersionUid: string) => void;
}

export default function CompositionHistoryPanel({ sessionId, refreshKey, onOpenVersion, onCompare }: CompositionHistoryPanelProps) {
  const [versions, setVersions] = useState<CompositionVersion[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pickFrom, setPickFrom] = useState<string>('');
  const [pickTo, setPickTo] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    request<CompositionVersion[]>(`/form-sessions/${encodeURIComponent(sessionId)}/provider/history`)
      .then((result) => { if (!cancelled) setVersions(result); })
      .catch((e: any) => { if (!cancelled) setError(e.message || 'Historie konnte nicht geladen werden.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, refreshKey]);

  if (loading) return <div style={{ padding: '1rem', color: 'var(--text-muted, #64748b)', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><Loader2 size={15} className="lf-spin" /> Lade Historie…</div>;
  // A history load failure must never make the current form unusable (§30) -
  // this panel simply shows its own error state, nothing else on the page
  // is affected.
  if (error) return <div style={{ padding: '1rem', color: 'var(--danger, #ef4444)', fontSize: '0.9rem' }}>{error}</div>;
  if (!versions || versions.length === 0) return <div style={{ padding: '1rem', color: 'var(--text-muted, #64748b)', fontSize: '0.9rem' }}>Keine Historie vorhanden.</div>;

  return (
    <div style={{ fontSize: '0.85rem' }}>
      {versions.map((version, index) => {
        const previous = versions[index + 1];
        return (
          <div key={version.versionUid} style={{ padding: '0.75rem 0', borderBottom: index < versions.length - 1 ? '1px solid var(--border, #e2e8f0)' : 'none' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '0.5rem' }}>
              <strong>v{version.versionNumber ?? '?'}</strong>
              <span style={{ color: 'var(--text-muted, #64748b)', fontSize: '0.8rem' }}>{formatTimestamp(version.committedAt)}</span>
            </div>
            <div style={{ marginTop: '0.15rem' }}>{version.committer?.name || 'Unbekannt'}</div>
            <div style={{ marginTop: '0.3rem', display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              <span className="badge badge-draft">{CHANGE_TYPE_LABELS[version.changeType]}</span>
              <span className="badge badge-draft">
                {LIFECYCLE_STATE_LABELS[version.lifecycleState]}
                {!version.lifecycleConfirmed ? ' (nicht bestätigt)' : ''}
              </span>
            </div>
            {version.changeDescription && <div style={{ marginTop: '0.4rem', color: 'var(--text-muted, #475569)' }}>Grund: {version.changeDescription}</div>}
            <div style={{ marginTop: '0.5rem', display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-secondary" style={{ padding: '0.3rem 0.7rem', fontSize: '0.78rem' }} onClick={() => onOpenVersion(version.versionUid)}>Öffnen</button>
              {previous && (
                <button className="btn btn-secondary" style={{ padding: '0.3rem 0.7rem', fontSize: '0.78rem' }} onClick={() => onCompare(previous.versionUid, version.versionUid)}>
                  Mit vorheriger Version vergleichen
                </button>
              )}
            </div>
          </div>
        );
      })}

      <div style={{ marginTop: '1rem', paddingTop: '0.9rem', borderTop: '1px solid var(--border, #e2e8f0)' }}>
        <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Versionen vergleichen</div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <select className="form-input" style={{ width: 'auto', padding: '0.4rem 0.6rem' }} value={pickFrom} onChange={(event) => setPickFrom(event.target.value)}>
            <option value="">Von…</option>
            {versions.map((version) => <option key={version.versionUid} value={version.versionUid}>v{version.versionNumber ?? '?'}</option>)}
          </select>
          <span style={{ color: 'var(--text-muted, #64748b)' }}>→</span>
          <select className="form-input" style={{ width: 'auto', padding: '0.4rem 0.6rem' }} value={pickTo} onChange={(event) => setPickTo(event.target.value)}>
            <option value="">Mit…</option>
            {versions.map((version) => <option key={version.versionUid} value={version.versionUid}>v{version.versionNumber ?? '?'}</option>)}
          </select>
          <button
            className="btn"
            onClick={() => pickFrom && pickTo && onCompare(pickFrom, pickTo)}
            disabled={!pickFrom || !pickTo}
            style={{ opacity: pickFrom && pickTo ? 1 : 0.5 }}
          >
            Vergleichen
          </button>
        </div>
      </div>
    </div>
  );
}
