import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Braces, Database, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import type { CompositionDataBlock } from 'core';
import { WidgetDataCard, type WidgetDataState } from '../components/WidgetDataCard';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const API = 'http://localhost:3001/api';
type Display = 'line' | 'area' | 'bar' | 'metric' | 'table' | 'text';
type Aql = { id: string; packageName: string; name: string; description: string; query: string; enabled: boolean };
type Range = { min?: number; max?: number; criticalLow?: number; criticalHigh?: number };
type Widget = { id: string; name: string; description: string; aqlFunctionId: string; enabled: boolean; configuration: { display: Display; valueColumn?: string; labelColumn?: string; timeColumn?: string; limit?: number; referenceRange?: Range; packageName?: string } };
type WidgetPackage = { id: string; label: string; available: boolean; widgets: Array<{ id: string; title: string; available: boolean; aqlFunction?: { packageName: string; name: string }; aqlFunctionId?: string; columns: { value: string; label?: string; time?: string }; chart: { type: string } }> };
type Editable = Widget | Omit<Widget, 'id'>;
type PatientOption = { id: string; patientId: string; patientNamespace?: string; namespace?: string; ehrId?: string | null; firstName?: string; lastName?: string };
const empty = (): Omit<Widget, 'id'> => ({ name: 'Neues klinisches Widget', description: '', aqlFunctionId: '', enabled: true, configuration: { display: 'line', limit: 100 } });
/** Maps a widget's display config to the shape WidgetDataCard (built for
 * Composition data blocks) actually expects - same conversion
 * CompositionBuilder.tsx already does when dropping a widget onto a page. */
function toPreviewBlock(editor: Editable): CompositionDataBlock {
  const display = editor.configuration.display === 'metric' ? 'metric' : editor.configuration.display === 'text' ? 'text' : editor.configuration.display === 'table' ? 'list' : 'trend';
  return {
    id: 'preview', type: 'data', title: editor.name || 'Vorschau',
    ...('id' in editor ? { widgetId: editor.id } : {}),
    display,
    ...(['line', 'area', 'bar'].includes(editor.configuration.display) ? { chartType: editor.configuration.display as 'line' | 'area' | 'bar' } : {}),
    valueColumn: editor.configuration.valueColumn, labelColumn: editor.configuration.labelColumn, timeColumn: editor.configuration.timeColumn,
    referenceRange: editor.configuration.referenceRange, limit: editor.configuration.limit,
  };
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, credentials: 'include', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`);
  return body as T;
}
function aliases(query?: string): string[] { return query ? [...new Set(Array.from(query.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\b/gi), (match) => match[1]))] : []; }

export default function WidgetsAdmin() {
  useDocumentTitle('Widgets');
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [aql, setAql] = useState<Aql[]>([]);
  const [originalAql, setOriginalAql] = useState<Aql[]>([]);
  const [packages, setPackages] = useState<WidgetPackage[]>([]);
  const [draftPackages, setDraftPackages] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem('watehr_draft_packages') || '[]'); } catch { return []; } });
  const [isCreatingPackage, setIsCreatingPackage] = useState(false);
  const [newPackageName, setNewPackageName] = useState('');
  const [editor, setEditor] = useState<Editable>(empty());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [previewPatients, setPreviewPatients] = useState<PatientOption[]>([]);
  const [previewPatientId, setPreviewPatientId] = useState('');
  const [previewNamespace, setPreviewNamespace] = useState('');
  const [previewEhrId, setPreviewEhrId] = useState('');
  const [previewData, setPreviewData] = useState<WidgetDataState>({});

  const sanitizeName = (str: string, prefix: string) => {
    let sanitized = (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!sanitized || !/^[a-z]/.test(sanitized)) sanitized = `${prefix}-${sanitized || 'widget'}`;
    return sanitized;
  };
  
  useEffect(() => {
    localStorage.setItem('watehr_draft_packages', JSON.stringify(draftPackages));
  }, [draftPackages]);

  const load = async () => {
    try {
      const [widgetResult, aqlResult, packageResult] = await Promise.all([
        request<{ widgets: Widget[] }>('/widgets'), request<{ functions: Aql[] }>('/functions/aql'), request<{ packages: WidgetPackage[] }>('/plugins/widget-packages'),
      ]);
      setWidgets(widgetResult.widgets); 
      const activeAqls = aqlResult.functions.filter((item) => item.enabled);
      setAql(activeAqls); 
      setOriginalAql(JSON.parse(JSON.stringify(activeAqls))); // Deep copy for comparison
      setPackages(packageResult.packages);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Widgets konnten nicht geladen werden.'); }
  };
  useEffect(() => { void load(); }, []);
  // Preview context: pull the registered patients plus the operator's
  // configured "always test against this patient" EHR-ID (Settings ->
  // EHRbase connection -> Default EHR-ID), then default the picker to
  // whichever patient actually has that EHR-ID - so a widget author sees
  // real data immediately without hunting for the right patient first.
  useEffect(() => {
    void (async () => {
      try {
        const [patients, defaults] = await Promise.all([
          request<PatientOption[]>('/patients'),
          request<{ defaultEhrId: string }>('/config/preview-defaults'),
        ]);
        setPreviewPatients(Array.isArray(patients) ? patients : []);
        const defaultEhrId = defaults.defaultEhrId?.trim();
        const matched = defaultEhrId ? patients.find((item) => item.ehrId === defaultEhrId) : undefined;
        if (matched) {
          setPreviewPatientId(matched.patientId); setPreviewNamespace(matched.patientNamespace || matched.namespace || ''); setPreviewEhrId(matched.ehrId || '');
        } else if (defaultEhrId) {
          setPreviewEhrId(defaultEhrId);
        }
      } catch { /* Preview context is a convenience, not required to use the rest of the page. */ }
    })();
  }, []);
  const runPreview = async (widgetId: string) => {
    if (!previewPatientId.trim()) { setPreviewData({ error: 'Bitte einen Patienten wählen oder eine Patient-ID eingeben.' }); return; }
    setPreviewData({ loading: true });
    try {
      const result = await request<{ rows: Record<string, unknown>[] }>(`/widgets/${encodeURIComponent(widgetId)}/query`, {
        method: 'POST',
        body: JSON.stringify({ patientId: previewPatientId.trim(), ...(previewNamespace.trim() ? { patientNamespace: previewNamespace.trim() } : {}), ...(previewEhrId.trim() ? { ehrId: previewEhrId.trim() } : {}) }),
      });
      setPreviewData({ rows: result.rows });
    } catch (reason) { setPreviewData({ error: reason instanceof Error ? reason.message : 'Vorschau fehlgeschlagen.' }); }
  };
  const selectedAql = useMemo(() => aql.find((item) => item.id === editor.aqlFunctionId), [aql, editor.aqlFunctionId]);
  const columns = useMemo(() => aliases(selectedAql?.query), [selectedAql?.query]);
  const patch = (next: Partial<Widget>) => setEditor((current) => ({ ...current, ...next }));
  const config = (next: Partial<Widget['configuration']>) => setEditor((current) => ({ ...current, configuration: { ...current.configuration, ...next } }));
  const setRange = (key: keyof Range, raw: string) => {
    const next = { ...(editor.configuration.referenceRange || {}) };
    if (!raw.trim()) delete next[key]; else next[key] = Number(raw);
    config({ referenceRange: Object.keys(next).length ? next : undefined });
  };
  const save = async () => {
    try {
      const widgetId = 'id' in editor ? editor.id : undefined;
      const oAql = selectedAql ? originalAql.find(a => a.id === selectedAql.id) : undefined;
      if (selectedAql && (!oAql || selectedAql.query !== oAql.query || selectedAql.description !== oAql.description)) {
        const safePkg = sanitizeName(selectedAql.packageName, 'pkg');
        const safeName = sanitizeName(selectedAql.name, 'w');
        const payload = { ...selectedAql, packageName: safePkg, name: safeName };
        await request(`/functions/aql/${selectedAql.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      }
      const saved = await request<Widget>(`/widgets${widgetId ? `/${widgetId}` : ''}`, { method: widgetId ? 'PUT' : 'POST', body: JSON.stringify(editor) });
      await load(); setEditor(saved); setNotice('Widget und AQL gespeichert. Die Mapping-Spalten wurden gegen die AQL-Aliase geprüft.'); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Speichern fehlgeschlagen.'); }
  };
  const remove = async () => {
    if (!('id' in editor)) return;
    try { await request(`/widgets/${editor.id}`, { method: 'DELETE' }); await load(); setEditor(empty()); setPreviewData({}); setNotice('Widget gelöscht.'); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Löschen fehlgeschlagen.'); }
  };
  const selectColumn = (value: string | undefined, set: (next: string | undefined) => void, label: string) => <label className="form-label">{label}<select className="form-input" value={value || ''} onChange={(event) => set(event.target.value || undefined)}><option value="">Nicht verwendet</option>{columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label>;

  return <div style={{ padding: '1rem', minHeight: 'calc(100vh - 2rem)', boxSizing: 'border-box' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: '.65rem', marginBottom: '.8rem' }}><BarChart3 color="var(--primary)" /><div><strong>Klinische Widgets</strong><div style={{ color: 'var(--text-muted)', fontSize: '.82rem' }}>Technischer Editor für AQL, Ergebnis-Aliase, Datenmapping und Referenzbereiche.</div></div></header>
    {error && <div className="card" role="alert" style={{ color: '#b91c1c', marginBottom: '.75rem' }}>{error}</div>}
    {notice && <div className="card" style={{ color: '#15803d', marginBottom: '.75rem' }}>{notice}</div>}
    <div className="card" style={{ display: 'grid', gridTemplateColumns: '245px minmax(440px, 1fr) 315px', minHeight: 'calc(100vh - 145px)', padding: 0 }}>
      <aside style={{ padding: '.85rem', borderRight: '1px solid var(--border)', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.8rem' }}>
          <div style={{ fontSize: '.72rem', fontWeight: 800, letterSpacing: '.08em', color: 'var(--text-muted)' }}>EIGENE PAKETE</div>
          <button className="btn btn-secondary" style={{ padding: '.2rem .5rem', fontSize: '.75rem' }} onClick={() => setIsCreatingPackage(true)}><Plus size={12} /> Neues Package</button>
        </div>
        {isCreatingPackage && (
          <div style={{ padding: '.55rem', borderRadius: 6, background: '#f1f5f9', marginBottom: '.45rem' }}>
            <input autoFocus className="form-input" style={{ width: '100%', marginBottom: '.35rem', fontSize: '.8rem' }} placeholder="Paketname..." value={newPackageName} onChange={e => setNewPackageName(e.target.value)} onKeyDown={e => {
              if (e.key === 'Enter' && newPackageName.trim()) {
                setDraftPackages(prev => Array.from(new Set([...prev, newPackageName.trim()])));
                setNewPackageName(''); setIsCreatingPackage(false);
              } else if (e.key === 'Escape') setIsCreatingPackage(false);
            }} />
            <div style={{ display: 'flex', gap: '.35rem' }}>
              <button className="btn btn-secondary" style={{ flex: 1, padding: '.2rem', fontSize: '.75rem' }} onClick={() => {
                if (newPackageName.trim()) { setDraftPackages(prev => Array.from(new Set([...prev, newPackageName.trim()]))); setNewPackageName(''); setIsCreatingPackage(false); }
              }}>Speichern</button>
              <button className="btn btn-secondary" style={{ padding: '.2rem', fontSize: '.75rem' }} onClick={() => setIsCreatingPackage(false)}>Abbrechen</button>
            </div>
          </div>
        )}
        {(() => {
          const customPackages = Array.from(new Set([...draftPackages, ...widgets.map(w => w.configuration.packageName).filter(Boolean)])) as string[];
          if (customPackages.length === 0) customPackages.push('Konfigurierte Widgets');
          
          return customPackages.map(pkg => (
            <div key={pkg} style={{ padding: '.55rem', borderRadius: 6, background: '#f1f5f9', marginBottom: '.45rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '.35rem' }}>
                <strong style={{ fontSize: '.84rem', color: '#334155' }}>{pkg}</strong>
                <button className="btn btn-secondary" style={{ padding: '.1rem .3rem' }} title="Widget hinzufügen" onClick={() => { setEditor({ ...empty(), configuration: { ...empty().configuration, packageName: pkg } }); setError(''); setPreviewData({}); }}><Plus size={14} /></button>
              </div>
              {widgets.filter(w => (w.configuration.packageName || 'Konfigurierte Widgets') === pkg).length === 0 && <small style={{ color: 'var(--text-muted)' }}>Leer</small>}
              {widgets.filter(w => (w.configuration.packageName || 'Konfigurierte Widgets') === pkg).map(widget => (
                <button key={widget.id} onClick={() => { setEditor(widget); setError(''); setPreviewData({}); }} style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, borderRadius: 4, background: 'transparent', padding: '.35rem', cursor: 'pointer', outline: 'none' }}>
                  <div style={{ fontSize: '.82rem', fontWeight: 500 }}>{widget.name}</div>
                  <small style={{ color: 'var(--text-muted)' }}>{widget.configuration.display} · {widget.enabled ? 'aktiv' : 'inaktiv'}</small>
                </button>
              ))}
            </div>
          ));
        })()}
        
        <div style={{ fontSize: '.72rem', fontWeight: 800, letterSpacing: '.08em', color: 'var(--text-muted)', margin: '1.15rem 0 .45rem' }}>PLUGIN-PAKETE</div>
        {packages.filter(p => !p.id.startsWith('watehr:custom-widgets')).length === 0 && <small style={{ color: 'var(--text-muted)' }}>Keine Plugin-Pakete geladen.</small>}
        {packages.filter(p => !p.id.startsWith('watehr:custom-widgets')).map((widgetPackage) => <div key={widgetPackage.id} style={{ padding: '.55rem', borderRadius: 6, background: '#f8fafc', marginBottom: '.45rem' }}><strong style={{ fontSize: '.84rem' }}>{widgetPackage.label}</strong>{widgetPackage.widgets.map((widget) => { const linkedAql = widget.aqlFunctionId ? aql.find((item) => item.id === widget.aqlFunctionId) : undefined; const reference = widget.aqlFunction ? `${widget.aqlFunction.packageName}.${widget.aqlFunction.name}` : linkedAql ? `${linkedAql.packageName}.${linkedAql.name}` : 'gespeicherte AQL'; return <small key={widget.id} style={{ display: 'block', color: widget.available ? '#475569' : '#b45309', marginTop: '.22rem' }}>{widget.title} · {reference}</small>; })}</div>)}
      </aside>
      <main style={{ padding: '1.15rem', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '.8rem', marginBottom: '.8rem' }}><div><strong>{'id' in editor ? 'Widget bearbeiten' : 'Neues Widget'}</strong><small style={{ display: 'block', color: 'var(--text-muted)' }}>Ein Widget referenziert eine einzige, schreibgeschützte AQL-Funktion.</small></div><label style={{ fontSize: '.82rem' }}><input type="checkbox" checked={editor.enabled} onChange={(event) => patch({ enabled: event.target.checked })} /> Aktiv</label></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.7rem' }}><label className="form-label">Name<input className="form-input" value={editor.name} onChange={(event) => patch({ name: event.target.value })} /></label><label className="form-label">Beschreibung<input className="form-input" value={editor.description} onChange={(event) => patch({ description: event.target.value })} /></label></div>
        <label className="form-label">AQL-Funktion
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
            <select className="form-input" style={{ flex: 1 }} value={editor.aqlFunctionId} onChange={(event) => patch({ aqlFunctionId: event.target.value, configuration: { ...editor.configuration, valueColumn: undefined, labelColumn: undefined, timeColumn: undefined } })}><option value="">AQL auswählen…</option>{aql.map((item) => <option key={item.id} value={item.id}>{item.packageName}.{item.name}</option>)}</select>
            <button className="btn btn-secondary" onClick={async () => {
              try {
                const safePkg = sanitizeName(editor.configuration.packageName || 'custom', 'pkg');
                const safeName = sanitizeName(editor.name || `widget-${Date.now()}`, 'w') + '-' + Date.now().toString().slice(-4);
                const savedAql = await request<Aql>('/functions/aql', { method: 'POST', body: JSON.stringify({ packageName: safePkg, name: safeName, description: 'Eigene AQL für Widget', query: 'SELECT e/ehr_id/value AS ehr_id FROM EHR e LIMIT 10', enabled: true }) });
                setAql((current) => [...current, savedAql]);
                patch({ aqlFunctionId: savedAql.id, configuration: { ...editor.configuration, valueColumn: undefined, labelColumn: undefined, timeColumn: undefined } });
              } catch (reason) { setError(reason instanceof Error ? reason.message : 'AQL Erstellung fehlgeschlagen.'); }
            }}><Plus size={15} /> Eigene AQL</button>
          </div>
        </label>
        {selectedAql && <section style={{ border: '1px solid #dbe3ef', borderRadius: 8, background: '#0f172a', color: '#e2e8f0', padding: '.75rem', margin: '.9rem 0' }}><div style={{ display: 'flex', gap: '.4rem', alignItems: 'center', color: '#bfdbfe', fontSize: '.8rem', marginBottom: '.45rem' }}><Braces size={15} /> {selectedAql.packageName}.{selectedAql.name}</div><textarea style={{ width: '100%', margin: 0, whiteSpace: 'pre-wrap', fontSize: '.75rem', minHeight: 160, background: 'transparent', color: 'inherit', border: 0, padding: 0, outline: 'none', resize: 'vertical' }} value={selectedAql.query} onChange={(e) => setAql((current) => current.map((item) => item.id === selectedAql.id ? { ...item, query: e.target.value } : item))} /></section>}
        <section style={{ padding: '.85rem', border: '1px solid #dbe3ef', borderRadius: 8, marginBottom: '.85rem' }}><strong><Database size={15} style={{ verticalAlign: 'text-bottom', marginRight: '.35rem' }} />Benannte AQL-Ergebnisfelder</strong><p style={{ color: 'var(--text-muted)', fontSize: '.8rem', margin: '.35rem 0 .65rem' }}>Nur Aliase aus <code>AS name</code> können gemappt werden. Das verhindert positionsabhängige Charts.</p>{columns.length ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.35rem' }}>{columns.map((column) => <code key={column} style={{ padding: '.2rem .42rem', borderRadius: 4, background: '#eff6ff', color: '#1d4ed8' }}>{column}</code>)}</div> : <small style={{ color: '#b45309' }}>Diese AQL enthält keine erkennbaren <code>AS</code>-Aliase. Ergänze erst konkrete Ergebnisnamen im AQL-Editor.</small>}</section>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.7rem' }}><label className="form-label">Darstellung<select className="form-input" value={editor.configuration.display} onChange={(event) => config({ display: event.target.value as Display })}><option value="line">Linie</option><option value="area">Fläche</option><option value="bar">Balken</option><option value="metric">Kennzahl</option><option value="table">Tabelle</option><option value="text">Text</option></select></label><label className="form-label">Max. Zeilen<input className="form-input" type="number" min="1" max="1000" value={editor.configuration.limit || 100} onChange={(event) => config({ limit: Number(event.target.value) || 100 })} /></label></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '.7rem' }}>{selectColumn(editor.configuration.valueColumn, (valueColumn) => config({ valueColumn }), 'Wertspalte')}{selectColumn(editor.configuration.labelColumn, (labelColumn) => config({ labelColumn }), 'Beschriftung')}{selectColumn(editor.configuration.timeColumn, (timeColumn) => config({ timeColumn }), 'Zeitspalte')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '.65rem' }}><label className="form-label">Referenz min.<input className="form-input" type="number" value={editor.configuration.referenceRange?.min ?? ''} onChange={(event) => setRange('min', event.target.value)} /></label><label className="form-label">Referenz max.<input className="form-input" type="number" value={editor.configuration.referenceRange?.max ?? ''} onChange={(event) => setRange('max', event.target.value)} /></label><label className="form-label">Kritisch tief<input className="form-input" type="number" value={editor.configuration.referenceRange?.criticalLow ?? ''} onChange={(event) => setRange('criticalLow', event.target.value)} /></label><label className="form-label">Kritisch hoch<input className="form-input" type="number" value={editor.configuration.referenceRange?.criticalHigh ?? ''} onChange={(event) => setRange('criticalHigh', event.target.value)} /></label></div>
        <div style={{ display: 'flex', gap: '.6rem', marginTop: '1rem' }}><button className="btn btn-secondary" disabled={!('id' in editor)} onClick={() => void remove()}><Trash2 size={15} /> Löschen</button><button className="btn" onClick={() => void save()}><Save size={15} /> Speichern</button></div>
      </main>
      <aside style={{ padding: '1rem', borderLeft: '1px solid var(--border)', overflow: 'auto' }}><div style={{ fontSize: '.72rem', fontWeight: 800, letterSpacing: '.08em', color: 'var(--text-muted)', marginBottom: '.65rem' }}>WIDGET-SUMMARY</div><strong>{editor.name || 'Unbenannt'}</strong><p style={{ color: 'var(--text-muted)', fontSize: '.84rem', lineHeight: 1.45 }}>{editor.description || 'Keine Beschreibung.'}</p><dl style={{ margin: 0, display: 'grid', gap: '.6rem', fontSize: '.82rem' }}><div><dt style={{ color: 'var(--text-muted)' }}>AQL</dt><dd style={{ margin: '.15rem 0 0' }}>{selectedAql ? `${selectedAql.packageName}.${selectedAql.name}` : 'nicht gewählt'}</dd></div><div><dt style={{ color: 'var(--text-muted)' }}>Mapping</dt><dd style={{ margin: '.15rem 0 0' }}>Wert: <code>{editor.configuration.valueColumn || '—'}</code><br />Zeit: <code>{editor.configuration.timeColumn || '—'}</code><br />Label: <code>{editor.configuration.labelColumn || '—'}</code></dd></div><div><dt style={{ color: 'var(--text-muted)' }}>Runtime</dt><dd style={{ margin: '.15rem 0 0' }}>Patient und EHR-ID sind verpflichtend. Die AQL läuft ausschließlich serverseitig.</dd></div></dl></aside>
    </div>
    <div className="card" style={{ marginTop: '1rem', padding: '1.15rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem', marginBottom: '.8rem' }}><BarChart3 size={17} color="var(--primary)" /><strong>Vorschau</strong><span style={{ color: 'var(--text-muted)', fontSize: '.8rem' }}>Führt die AQL live gegen einen echten Patienten aus.</span></div>
      {!('id' in editor) ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '.85rem' }}>Speichere das Widget zuerst, um eine Vorschau mit echten Daten zu sehen.</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '.6rem', alignItems: 'end', marginBottom: '.9rem' }}>
            <label className="form-label">Test-Patient
              <select className="form-input" value={previewPatients.find((item) => item.patientId === previewPatientId)?.id || ''} onChange={(event) => {
                const selected = previewPatients.find((item) => item.id === event.target.value);
                if (selected) { setPreviewPatientId(selected.patientId); setPreviewNamespace(selected.patientNamespace || selected.namespace || ''); setPreviewEhrId(selected.ehrId || ''); }
              }}>
                <option value="">Patient wählen…</option>
                {previewPatients.map((item) => <option key={item.id} value={item.id}>{[item.lastName, item.firstName].filter(Boolean).join(', ') || item.patientId} · {item.patientId}</option>)}
              </select>
              <input className="form-input" style={{ marginTop: '.35rem' }} value={previewPatientId} onChange={(event) => setPreviewPatientId(event.target.value)} placeholder="oder Patient-ID manuell" />
            </label>
            <label className="form-label">Namespace<input className="form-input" value={previewNamespace} onChange={(event) => setPreviewNamespace(event.target.value)} /></label>
            <label className="form-label">EHR-ID (Override)<input className="form-input" value={previewEhrId} onChange={(event) => setPreviewEhrId(event.target.value)} placeholder="nur falls kein lokaler Patient" /></label>
            <button className="btn" onClick={() => void runPreview(editor.id)} disabled={previewData.loading}><RefreshCw size={15} /> {previewData.loading ? 'Lädt…' : 'Vorschau laden'}</button>
          </div>
          {(previewData.rows || previewData.error || previewData.loading) && <WidgetDataCard block={toPreviewBlock(editor)} state={previewData} />}
        </>
      )}
    </div>
  </div>;
}
