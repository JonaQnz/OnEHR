import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL } from '../../integration/apiBaseUrl';
import {
  COMPOSITION_SCRIPTING_EXTENSION_KEY,
  getCompositionDefinition,
  normalizeCompositionScript,
  type FormDefinitionV1,
  type FormScriptDiagnostic,
} from 'core';

const API = API_BASE_URL;

interface CompositionScriptEditorProps {
  compositionId: string;
  definition: FormDefinitionV1;
  onClose(): void;
  onSaved(record: { canonical_json: FormDefinitionV1 }): void;
}

interface CompileResult {
  valid: boolean;
  document: { diagnostics: FormScriptDiagnostic[]; generatedTypes: string };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Script-Aktion fehlgeschlagen.';
}

export default function CompositionScriptEditor({ compositionId, definition, onClose, onSaved }: CompositionScriptEditorProps) {
  const composition = useMemo(() => getCompositionDefinition(definition.extensions), [definition.extensions]);
  const document = useMemo(() => composition ? normalizeCompositionScript(definition.extensions?.[COMPOSITION_SCRIPTING_EXTENSION_KEY], composition) : null, [composition, definition.extensions]);
  const [source, setSource] = useState(document?.source || '');
  const [diagnostics, setDiagnostics] = useState<FormScriptDiagnostic[]>(document?.diagnostics || []);
  const [generatedTypes, setGeneratedTypes] = useState(document?.generatedTypes || '');
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showTypes, setShowTypes] = useState(false);
  const [message, setMessage] = useState('');
  const checkSequence = useRef(0);

  useEffect(() => {
    setSource(document?.source || '');
    setDiagnostics(document?.diagnostics || []);
    setGeneratedTypes(document?.generatedTypes || '');
  }, [document]);

  const check = async (candidate = source, quiet = false): Promise<boolean> => {
    const sequence = ++checkSequence.current;
    if (!quiet) setChecking(true);
    try {
      const response = await fetch(`${API}/forms/${encodeURIComponent(compositionId)}/composition-script/check`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: candidate }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body.error || `Prüfung fehlgeschlagen (${response.status})`));
      if (sequence !== checkSequence.current) return false;
      const result = body as CompileResult;
      setDiagnostics(result.document.diagnostics);
      setGeneratedTypes(result.document.generatedTypes);
      if (!quiet) setMessage(result.valid ? 'TypeScript-Prüfung erfolgreich.' : 'Das Script enthält Fehler.');
      return result.valid;
    } catch (error) {
      if (!quiet && sequence === checkSequence.current) setMessage(errorMessage(error));
      return false;
    } finally {
      if (!quiet && sequence === checkSequence.current) setChecking(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { void check(source, true); }, 650);
    return () => window.clearTimeout(timer);
  }, [source]);

  const save = async () => {
    setSaving(true); setMessage('');
    try {
      if (!(await check(source))) return;
      const response = await fetch(`${API}/forms/${encodeURIComponent(compositionId)}`, {
        method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...definition, extensions: { ...definition.extensions, [COMPOSITION_SCRIPTING_EXTENSION_KEY]: { ...(document || {}), source } } }),
      });
      const record = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(record.error || 'Speichern fehlgeschlagen.'));
      onSaved(record as { canonical_json: FormDefinitionV1 });
      setMessage('Composition-Script gespeichert.');
    } catch (error) { setMessage(errorMessage(error)); }
    finally { setSaving(false); }
  };

  if (!composition || !document) return <div style={{ padding: '2rem' }}>Composition-Script ist nicht verfügbar.</div>;
  return <section style={{ padding: '1.5rem', maxWidth: 1320, margin: '0 auto' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
      <div><h2 style={{ margin: 0, fontSize: '1.2rem' }}>Composition Script</h2><p style={{ margin: '.25rem 0 0', color: '#64748b', fontSize: '.85rem' }}>Steuert nur Seiten, Blöcke, Datenkarten und Navigation – keine Unterformular-Felder.</p></div>
      <div style={{ display: 'flex', gap: '.55rem' }}><button className="btn btn-secondary" onClick={onClose}>Zurück zum Designer</button><button className="btn btn-secondary" onClick={() => void check()} disabled={checking}>{checking ? 'Prüft…' : 'Prüfen'}</button><button className="btn" onClick={() => void save()} disabled={saving}>{saving ? 'Speichert…' : 'Speichern'}</button></div>
    </div>
    {message && <div style={{ padding: '.65rem .8rem', borderRadius: 7, background: diagnostics.some((item) => item.severity === 'error') ? '#fef2f2' : '#eff6ff', color: diagnostics.some((item) => item.severity === 'error') ? '#b91c1c' : '#1e3a8a', marginBottom: '1rem', fontSize: '.85rem' }}>{message}</div>}
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 330px', gap: '1rem' }}>
      <textarea aria-label="Composition Script" value={source} onChange={(event) => setSource(event.target.value)} spellCheck={false} style={{ minHeight: '590px', resize: 'vertical', border: '1px solid #cbd5e1', borderRadius: 9, padding: '1rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '.84rem', lineHeight: 1.55, background: '#0f172a', color: '#e2e8f0', outline: 'none' }} />
      <aside style={{ display: 'grid', alignContent: 'start', gap: '1rem' }}>
        <div style={{ background: '#fff', border: '1px solid #dbe3ef', borderRadius: 9, padding: '.9rem' }}><strong style={{ fontSize: '.85rem' }}>Diagnosen</strong>{diagnostics.length === 0 ? <p style={{ color: '#64748b', fontSize: '.82rem' }}>Keine Fehler erkannt.</p> : <div style={{ display: 'grid', gap: '.55rem', marginTop: '.7rem' }}>{diagnostics.map((item, index) => <div key={`${item.code}-${index}`} style={{ fontSize: '.8rem', color: item.severity === 'error' ? '#b91c1c' : '#92400e' }}><strong>{item.line ? `Zeile ${item.line}: ` : ''}</strong>{item.message}</div>)}</div>}</div>
        <div style={{ background: '#fff', border: '1px solid #dbe3ef', borderRadius: 9, padding: '.9rem' }}><button onClick={() => setShowTypes((current) => !current)} style={{ border: 0, padding: 0, background: 'transparent', color: '#1d4ed8', fontWeight: 700, cursor: 'pointer' }}>{showTypes ? 'Typen ausblenden' : 'Verfügbare API anzeigen'}</button>{showTypes && <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '.8rem 0 0', fontSize: '.7rem', color: '#334155' }}>{generatedTypes}</pre>}</div>
      </aside>
    </div>
  </section>;
}
