import { useEffect, useState } from 'react';
import type { SemanticDiff, SemanticDiffEntry } from 'core';
import { API_BASE_URL } from '../integration/apiBaseUrl';

const API = API_BASE_URL;

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

function renderValue(value: unknown): string {
  if (value === undefined || value === null) return '—';
  if (typeof value === 'object' && 'magnitude' in (value as any)) {
    const { magnitude, unit } = value as { magnitude?: unknown; unit?: unknown };
    return unit ? `${magnitude} ${unit}` : String(magnitude);
  }
  if (Array.isArray(value)) return value.map(String).join(', ');
  return String(value);
}

function EntryRow({ entry }: { entry: SemanticDiffEntry }) {
  return (
    <div style={{ padding: '0.6rem 0', borderBottom: '1px solid var(--border, #f1f5f9)' }}>
      <div style={{ fontWeight: 600 }}>{entry.label || entry.path}</div>
      {entry.change === 'added' && <div style={{ color: 'var(--success-hover, #15803d)' }}>+ {renderValue(entry.newValue)}</div>}
      {entry.change === 'removed' && <div style={{ color: 'var(--danger-hover, #dc2626)' }}>− {renderValue(entry.oldValue)}</div>}
      {entry.change === 'changed' && (
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', color: 'var(--text-main, #334155)' }}>
          <span>{renderValue(entry.oldValue)}</span>
          <span style={{ color: 'var(--text-muted, #94a3b8)' }}>→</span>
          <span>{renderValue(entry.newValue)}</span>
        </div>
      )}
      <div style={{ marginTop: '0.2rem', fontSize: '0.7rem', color: 'var(--text-muted, #94a3b8)', fontFamily: 'monospace' }}>
        {entry.path}{entry.archetypeNodeId ? ` · ${entry.archetypeNodeId}` : ''}{entry.rmType ? ` · ${entry.rmType}` : ''}
      </div>
    </div>
  );
}

export interface CompositionDiffViewProps {
  sessionId: string;
  fromVersionUid: string;
  toVersionUid: string;
  onClose: () => void;
}

export default function CompositionDiffView({ sessionId, fromVersionUid, toVersionUid, onClose }: CompositionDiffViewProps) {
  const [diff, setDiff] = useState<SemanticDiff | null>(null);
  const [fromVersion, setFromVersion] = useState<number | undefined>();
  const [toVersion, setToVersion] = useState<number | undefined>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    request<{ from: { version: { versionNumber?: number } }; to: { version: { versionNumber?: number } }; diff: SemanticDiff }>(
      `/form-sessions/${encodeURIComponent(sessionId)}/provider/history/compare`,
      { method: 'POST', body: JSON.stringify({ fromVersionUid, toVersionUid }) },
    )
      .then((result) => {
        if (cancelled) return;
        setDiff(result.diff);
        setFromVersion(result.from.version.versionNumber);
        setToVersion(result.to.version.versionNumber);
      })
      .catch((e: any) => { if (!cancelled) setError(e.message || 'Vergleich konnte nicht erzeugt werden.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, fromVersionUid, toVersionUid]);

  const total = diff ? diff.added.length + diff.removed.length + diff.changed.length : 0;

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '2rem' }}>
      <div className="card" style={{ margin: 0, padding: 0, maxWidth: '640px', width: '100%', maxHeight: '85vh', overflow: 'auto', boxShadow: 'var(--shadow-lg, 0 10px 25px -5px rgba(0,0,0,0.2))' }}>
        <div style={{ padding: '1rem 1.5rem', borderBottom: '1px solid var(--border, #e2e8f0)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'sticky', top: 0, background: 'var(--bg-card, #fff)' }}>
          <strong>Version {fromVersion ?? '?'} → Version {toVersion ?? '?'}</strong>
          <button className="btn btn-secondary" onClick={onClose}>Schließen</button>
        </div>
        <div style={{ padding: '1.5rem' }}>
          {loading && <div style={{ color: 'var(--text-muted, #64748b)' }}>Erzeuge Vergleich…</div>}
          {error && <div style={{ color: 'var(--danger, #ef4444)' }}>{error}</div>}
          {diff && (
            total === 0 ? (
              <div style={{ color: 'var(--text-muted, #64748b)' }}>Keine fachlichen Änderungen zwischen diesen Versionen.</div>
            ) : (
              <>
                <div style={{ marginBottom: '1rem', color: 'var(--text-muted, #475569)', fontSize: '0.85rem' }}>
                  {total} Änderung{total === 1 ? '' : 'en'} · {diff.changed.length} geändert · {diff.added.length} hinzugefügt · {diff.removed.length} entfernt
                </div>
                {diff.changed.length > 0 && (
                  <div style={{ marginBottom: '1rem' }}>
                    <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Geändert</div>
                    {diff.changed.map((entry, index) => <EntryRow key={`c-${index}`} entry={entry} />)}
                  </div>
                )}
                {diff.added.length > 0 && (
                  <div style={{ marginBottom: '1rem' }}>
                    <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Hinzugefügt</div>
                    {diff.added.map((entry, index) => <EntryRow key={`a-${index}`} entry={entry} />)}
                  </div>
                )}
                {diff.removed.length > 0 && (
                  <div>
                    <div style={{ fontWeight: 700, marginBottom: '0.25rem' }}>Entfernt</div>
                    {diff.removed.map((entry, index) => <EntryRow key={`r-${index}`} entry={entry} />)}
                  </div>
                )}
              </>
            )
          )}
        </div>
      </div>
    </div>
  );
}
