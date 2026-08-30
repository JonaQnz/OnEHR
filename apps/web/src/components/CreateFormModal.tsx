import { useEffect, useMemo, useState } from 'react';
import { FileText, LayoutPanelTop, Search, X } from 'lucide-react';

const API = 'http://localhost:3001/api';

type LocalTemplate = { id: string; template_id: string; alias?: string; version?: string };
type RemoteTemplate = { template_id: string; concept?: string; version?: string };
type TemplateOption = { key: string; templateId: string; label: string; version?: string; source: 'local' | 'remote'; localId?: string };

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, credentials: 'include', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `Anfrage fehlgeschlagen (${response.status}).`);
  return body as T;
}

/**
 * The single entry point for creating a Form Section or Form. Replaces the
 * old two-step flow (a native window.prompt() for a name, then - once
 * inside the builder - a separate forced full-page "select a template"
 * screen for Form Sections with no sourceTemplates) with one screen: name,
 * type, and template all chosen together before anything is written to the
 * database. A blank/no-template pick still lands on that same forced
 * template screen inside FormBuilder as a fallback - it's left untouched.
 */
export function CreateFormModal({ kind: initialKind, onClose, onCreated }: {
  kind: 'form' | 'composition';
  onClose: () => void;
  onCreated: (form: any) => void;
}) {
  const [kind, setKind] = useState(initialKind);
  const [name, setName] = useState('');
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [localTemplates, setLocalTemplates] = useState<LocalTemplate[]>([]);
  const [remoteTemplates, setRemoteTemplates] = useState<RemoteTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [local, remote] = await Promise.all([
          request<LocalTemplate[]>('/templates'),
          request<RemoteTemplate[]>('/templates/remote'),
        ]);
        if (!active) return;
        setLocalTemplates(Array.isArray(local) ? local : []);
        setRemoteTemplates(Array.isArray(remote) ? remote : []);
      } catch (reason) {
        if (active) setTemplatesError(reason instanceof Error ? reason.message : 'Vorlagen konnten nicht geladen werden.');
      } finally {
        if (active) setTemplatesLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !creating) onClose(); };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [creating, onClose]);

  // Already-imported templates take priority over their remote counterpart
  // (same template_id) so picking one never spawns a duplicate `Template`
  // row - importing an already-imported template_id again is not deduped
  // server-side, so the dedup has to happen here.
  const templateOptions = useMemo<TemplateOption[]>(() => {
    const localIds = new Set(localTemplates.map((t) => t.template_id));
    const fromLocal = localTemplates.map((t): TemplateOption => ({
      key: `local:${t.id}`, templateId: t.template_id, label: t.alias || t.template_id, version: t.version, source: 'local', localId: t.id,
    }));
    const fromRemote = remoteTemplates
      .filter((t) => !localIds.has(t.template_id))
      .map((t): TemplateOption => ({
        key: `remote:${t.template_id}`, templateId: t.template_id, label: t.concept || t.template_id, version: t.version, source: 'remote',
      }));
    return [...fromLocal, ...fromRemote].sort((a, b) => a.label.localeCompare(b.label));
  }, [localTemplates, remoteTemplates]);

  const filteredOptions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return templateOptions;
    return templateOptions.filter((option) => option.label.toLowerCase().includes(needle) || option.templateId.toLowerCase().includes(needle));
  }, [templateOptions, query]);

  const selectedOption = templateOptions.find((option) => option.key === selectedKey) || null;
  const canSubmit = name.trim().length > 0 && !creating;

  const handleSubmit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) { setError('Bitte einen Namen eingeben.'); return; }
    setCreating(true);
    setError('');
    try {
      if (kind === 'composition') {
        const data = await request<{ form: any }>('/forms', { method: 'POST', body: JSON.stringify({ name: trimmedName, kind: 'composition' }) });
        onCreated(data.form);
        return;
      }
      let localTemplateId: string | undefined = selectedOption?.source === 'local' ? selectedOption.localId : undefined;
      if (selectedOption?.source === 'remote') {
        const imported = await request<{ template: { id: string } }>(`/templates/remote/${encodeURIComponent(selectedOption.templateId)}/import`, { method: 'POST' });
        localTemplateId = imported.template.id;
      }
      const data = localTemplateId
        ? await request<{ form: any }>('/forms/generate-from-template', { method: 'POST', body: JSON.stringify({ templateId: localTemplateId, formName: trimmedName }) })
        : await request<{ form: any }>('/forms', { method: 'POST', body: JSON.stringify({ name: trimmedName, kind: 'form' }) });
      onCreated(data.form);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Formular konnte nicht erstellt werden.');
      setCreating(false);
    }
  };

  return (
    <div
      role="presentation"
      style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1.5rem' }}
      onMouseDown={(event) => { if (event.target === event.currentTarget && !creating) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="create-form-modal-title" style={{ background: 'var(--bg-card)', borderRadius: '14px', boxShadow: 'var(--shadow-lg)', width: '100%', maxWidth: '640px', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '1.5rem 1.5rem 1rem' }}>
          <div>
            <h2 id="create-form-modal-title" style={{ margin: '0 0 0.35rem 0', fontSize: '1.4rem', fontWeight: 700 }}>Neu erstellen</h2>
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: '0.9rem' }}>Name, Typ und Vorlage in einem Schritt - der Entwurf wird erst beim Klick auf "Erstellen" angelegt.</p>
          </div>
          <button type="button" aria-label="Schließen" className="btn btn-secondary btn-icon" onClick={onClose} disabled={creating}>
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '0 1.5rem', overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem' }}>
            <button
              type="button"
              onClick={() => setKind('form')}
              className={`btn ${kind === 'form' ? '' : 'btn-secondary'}`}
              style={{ flex: 1 }}
            >
              <FileText size={16} /> Formular
            </button>
            <button
              type="button"
              onClick={() => setKind('composition')}
              className={`btn ${kind === 'composition' ? '' : 'btn-secondary'}`}
              style={{ flex: 1 }}
            >
              <LayoutPanelTop size={16} /> Form
            </button>
          </div>

          <label className="form-label" htmlFor="create-form-name">Name</label>
          <input
            id="create-form-name"
            className="form-input"
            style={{ marginBottom: '1.25rem' }}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && canSubmit) void handleSubmit(); }}
            placeholder={kind === 'composition' ? 'z. B. Klinische Übersicht - Kardiologie' : 'z. B. Anordnung - Physiotherapie'}
            autoFocus
          />

          {kind === 'form' && (
            <>
              <label className="form-label">Vorlage (openEHR-Template)</label>
              <div style={{ position: 'relative', marginBottom: '0.75rem' }}>
                <Search size={16} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  className="form-input"
                  style={{ paddingLeft: '2.25rem' }}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Vorlagen durchsuchen…"
                />
              </div>

              <div style={{ border: '1px solid var(--border)', borderRadius: '10px', maxHeight: '280px', overflowY: 'auto', marginBottom: '1.25rem' }}>
                <button
                  type="button"
                  onClick={() => setSelectedKey(null)}
                  style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.85rem 1rem', border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', background: selectedKey === null ? 'var(--primary-light)' : 'transparent' }}
                >
                  <div style={{ width: 16, height: 16, borderRadius: '50%', border: `2px solid ${selectedKey === null ? 'var(--primary)' : 'var(--border)'}`, background: selectedKey === null ? 'var(--primary)' : 'transparent', flexShrink: 0 }} />
                  <div>
                    <strong style={{ fontSize: '0.92rem' }}>Ohne Vorlage - leer starten</strong>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Vorlage später im Formular-Editor auswählen.</div>
                  </div>
                </button>

                {templatesLoading ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>Vorlagen werden geladen…</div>
                ) : templatesError ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--danger-hover)', fontSize: '0.9rem' }}>{templatesError}</div>
                ) : filteredOptions.length === 0 ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>Keine Vorlagen gefunden.</div>
                ) : (
                  filteredOptions.map((option, index) => {
                    const selected = selectedKey === option.key;
                    return (
                      <button
                        type="button"
                        key={option.key}
                        onClick={() => setSelectedKey(option.key)}
                        style={{ width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.85rem 1rem', border: 'none', borderBottom: index === filteredOptions.length - 1 ? 'none' : '1px solid var(--border)', cursor: 'pointer', background: selected ? 'var(--primary-light)' : 'transparent' }}
                      >
                        <div style={{ width: 16, height: 16, borderRadius: '50%', border: `2px solid ${selected ? 'var(--primary)' : 'var(--border)'}`, background: selected ? 'var(--primary)' : 'transparent', flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <strong style={{ fontSize: '0.92rem' }}>{option.label}</strong>
                            {option.source === 'local' ? (
                              <span className="badge badge-published" style={{ fontSize: '0.65rem' }}>importiert</span>
                            ) : (
                              <span className="badge badge-draft" style={{ fontSize: '0.65rem' }}>von EHRbase</span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{option.templateId}</div>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </>
          )}

          {error && (
            <div style={{ marginBottom: '1.25rem', padding: '0.75rem 1rem', borderRadius: '8px', background: 'var(--danger-light)', color: 'var(--danger-hover)', fontSize: '0.88rem' }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', padding: '1rem 1.5rem 1.5rem' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={creating}>Abbrechen</button>
          <button type="button" className="btn" onClick={() => void handleSubmit()} disabled={!canSubmit} style={!canSubmit ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}>
            {creating ? 'Wird erstellt…' : kind === 'composition' ? 'Form erstellen' : 'Formular erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
}
