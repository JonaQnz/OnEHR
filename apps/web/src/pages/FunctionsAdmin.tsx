import { useEffect, useMemo, useState } from 'react';
import { Braces, Database, FileCode2, Plus, Save } from 'lucide-react';
import { registeredFunctionPackages } from '../scripting/runtime/registeredFunctions';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const API = 'http://localhost:3001/api';

interface StoredCodeFunction { id: string; packageName: string; name: string; description: string; source: string; enabled: boolean; }
interface StoredAqlFunction { id: string; packageName: string; name: string; description: string; query: string; ehrbaseVersion?: string; parameters: Record<string, unknown>; autoload: boolean; enabled: boolean; }
interface CodeEditorState { id?: string; packageName: string; name: string; description: string; source: string; enabled: boolean; }
interface AqlEditorState { id?: string; packageName: string; name: string; description: string; query: string; parameters: string; autoload: boolean; enabled: boolean; }

const codeTemplate = (name = 'calculateExample') => `export function ${name}(params) {\n  // params enthält die übergebenen Werte.\n  return params.value;\n}`;
const aqlTemplate = "SELECT c/uid/value FROM EHR e[ehr_id/value = :ehrId] CONTAINS COMPOSITION c LIMIT 1";
const emptyCodeEditor = (packageName = 'custom'): CodeEditorState => ({ id: undefined, packageName, name: 'calculateExample', description: '', source: codeTemplate(), enabled: true });
const emptyAqlEditor = (packageName = 'custom'): AqlEditorState => ({ id: undefined, packageName, name: 'latest', description: '', query: aqlTemplate, parameters: '{}', autoload: true, enabled: true });

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, credentials: 'include', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

function staticFunctionCode(func: { name: string; execute: (...args: any[]) => any }): string {
  const name = func.name.split('.').pop() || 'functionName';
  return `export const ${name} = ${func.execute.toString()};`;
}
function signature(name: string, parameters: Record<string, string>, returns: string): string {
  return `export function ${name.split('.').pop()}(params: {\n${Object.entries(parameters).map(([key, type]) => `  ${key}: ${type};`).join('\n')}\n}): ${returns};`;
}

/**
 * Two genuinely different things used to live in one merged list here:
 * Code Functions (JS/TS run in the form-script worker - Forms owns these
 * outright, they only ever live in Forms' own database) and AQL
 * Functions/"Queries" (which now bind to queries actually defined on
 * EHRbase's own Query Service - Forms is a client of those, not their
 * owner). Splitting them into separate tabs makes that distinction visible
 * instead of implying both are equally "ours" to freely edit/delete.
 */
export default function FunctionsAdmin() {
  useDocumentTitle('Functions');
  const [tab, setTab] = useState<'code' | 'aql'>('code');
  const [codeFunctions, setCodeFunctions] = useState<StoredCodeFunction[]>([]);
  const [aqlFunctions, setAqlFunctions] = useState<StoredAqlFunction[]>([]);
  const [loadingAql, setLoadingAql] = useState(false);
  const [selectedStaticId, setSelectedStaticId] = useState(registeredFunctionPackages[0]?.id);
  const [codeSelectedId, setCodeSelectedId] = useState<string | undefined>(undefined);
  const [aqlSelectedId, setAqlSelectedId] = useState<string | undefined>(undefined);
  const [showingStatic, setShowingStatic] = useState(true);
  const [codeEditor, setCodeEditor] = useState<CodeEditorState>(emptyCodeEditor());
  const [aqlEditor, setAqlEditor] = useState<AqlEditorState>(emptyAqlEditor());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try { setCodeFunctions((await request<{ functions: StoredCodeFunction[] }>('/functions/code')).functions); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Code-Functions konnten nicht geladen werden.'); }
  };
  const loadAql = async () => {
    setLoadingAql(true);
    try { setAqlFunctions((await request<{ functions: StoredAqlFunction[] }>('/functions/aql')).functions); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Queries konnten nicht von EHRbase geladen werden.'); }
    finally { setLoadingAql(false); }
  };
  useEffect(() => { void load(); void loadAql(); }, []);

  const codePackages = useMemo(() => {
    const custom = new Map<string, StoredCodeFunction[]>();
    codeFunctions.forEach((item) => custom.set(item.packageName, [...(custom.get(item.packageName) || []), item]));
    return [...custom.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [codeFunctions]);
  const aqlPackages = useMemo(() => {
    const byPackage = new Map<string, StoredAqlFunction[]>();
    aqlFunctions.forEach((item) => byPackage.set(item.packageName, [...(byPackage.get(item.packageName) || []), item]));
    return [...byPackage.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [aqlFunctions]);

  const selectedStatic = showingStatic ? registeredFunctionPackages.find((item) => item.id === selectedStaticId) : undefined;
  const selectedCode = codeFunctions.find((item) => item.id === codeSelectedId);
  const selectedAql = aqlFunctions.find((item) => item.id === aqlSelectedId);

  const pickStatic = (id: string) => { setShowingStatic(true); setSelectedStaticId(id); setError(''); setNotice(''); };
  const pickCode = (item: StoredCodeFunction) => { setShowingStatic(false); setCodeSelectedId(item.id); setCodeEditor({ id: item.id, packageName: item.packageName, name: item.name, description: item.description, source: item.source, enabled: item.enabled }); setError(''); setNotice(''); };
  const pickAql = (item: StoredAqlFunction) => { setAqlSelectedId(item.id); setAqlEditor({ id: item.id, packageName: item.packageName, name: item.name, description: item.description, query: item.query, parameters: JSON.stringify(item.parameters || {}, null, 2), autoload: item.autoload, enabled: item.enabled }); setError(''); setNotice(''); };
  const newCode = () => { setShowingStatic(false); setCodeSelectedId(undefined); setCodeEditor(emptyCodeEditor()); setError(''); setNotice('Neue Code-Function anlegen.'); };
  const newAql = () => { setAqlSelectedId(undefined); setAqlEditor(emptyAqlEditor()); setError(''); setNotice('Neue Query anlegen - wird auf EHRbase als Stored Query gespeichert.'); };

  const saveCode = async () => {
    try {
      const path = `/functions/code${codeEditor.id ? `/${codeEditor.id}` : ''}`;
      const saved = await request<StoredCodeFunction>(path, { method: codeEditor.id ? 'PUT' : 'POST', body: JSON.stringify({ packageName: codeEditor.packageName, name: codeEditor.name, description: codeEditor.description, source: codeEditor.source, enabled: codeEditor.enabled }) });
      await load();
      pickCode(saved);
      setNotice(`functions.${saved.packageName}.${saved.name} gespeichert.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Code-Function konnte nicht gespeichert werden.'); }
  };
  const deleteCode = async () => {
    if (!codeEditor.id) return;
    try { await request<void>(`/functions/code/${codeEditor.id}`, { method: 'DELETE' }); await load(); newCode(); setNotice('Code-Function gelöscht.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Code-Function konnte nicht gelöscht werden.'); }
  };

  const saveAql = async () => {
    try {
      let parameters: unknown;
      try { parameters = JSON.parse(aqlEditor.parameters || '{}'); } catch { throw new Error('Parameters müssen gültiges JSON sein.'); }
      const path = `/functions/aql${aqlEditor.id ? `/${aqlEditor.id}` : ''}`;
      const saved = await request<StoredAqlFunction>(path, { method: aqlEditor.id ? 'PUT' : 'POST', body: JSON.stringify({ packageName: aqlEditor.packageName, name: aqlEditor.name, description: aqlEditor.description, query: aqlEditor.query, parameters, autoload: aqlEditor.autoload, enabled: aqlEditor.enabled }) });
      await loadAql();
      pickAql(saved);
      setNotice(`${saved.packageName}::${saved.name} auf EHRbase gespeichert - Version ${saved.ehrbaseVersion}.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Query konnte nicht gespeichert werden.'); }
  };

  const code = selectedStatic ? selectedStatic.functions.map(staticFunctionCode).join('\n\n') : selectedCode ? selectedCode.source : codeEditor.source;
  const summary = selectedStatic ? selectedStatic.functions[0] : undefined;

  return <div style={{ padding: '1rem', height: 'calc(100vh - 2rem)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', minHeight: 36 }}>
      <Braces size={22} color="var(--primary)" /><strong>Functions &amp; Queries</strong>
      <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Code-Pakete für Formulare, und AQL-Queries, die auf EHRbase gespeichert sind.</span>
    </header>
    <div style={{ display: 'flex', gap: '0.5rem' }}>
      <button type="button" className={`btn ${tab === 'code' ? '' : 'btn-secondary'}`} onClick={() => setTab('code')}><FileCode2 size={15} /> Functions</button>
      <button type="button" className={`btn ${tab === 'aql' ? '' : 'btn-secondary'}`} onClick={() => setTab('aql')}><Database size={15} /> Queries</button>
    </div>
    {error && <div role="alert" style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</div>}{notice && <div style={{ color: '#15803d', fontSize: '0.85rem' }}>{notice}</div>}

    {tab === 'code' ? (
      <div className="card" style={{ display: 'grid', gridTemplateColumns: '220px minmax(380px, 1fr) 290px', minHeight: 0, flex: 1, overflow: 'hidden' }}>
        <aside style={{ borderRight: '1px solid var(--border)', overflow: 'auto', padding: '0.6rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0.2rem 0 0.55rem' }}><strong style={{ fontSize: '0.85rem' }}>Packages</strong><button className="btn btn-secondary" type="button" title="Neue Code-Function" onClick={newCode} style={{ padding: '0.3rem' }}><Plus size={15} /></button></div>
          {registeredFunctionPackages.map((pkg) => <button key={pkg.id} type="button" onClick={() => pickStatic(pkg.id)} style={{ width: '100%', textAlign: 'left', border: 0, borderRadius: 4, padding: '0.48rem', cursor: 'pointer', background: showingStatic && selectedStaticId === pkg.id ? 'var(--surface-sunken)' : 'transparent', marginBottom: 4 }}><strong style={{ fontSize: '0.8rem' }}>{pkg.id}</strong><span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.72rem' }}>{pkg.functions.length} Code-Functions · read-only</span></button>)}
          {codePackages.map(([packageName, items]) => <div key={packageName} style={{ margin: '0.45rem 0' }}>
            <div style={{ padding: '0.42rem', fontSize: '0.8rem', fontWeight: 600 }}>{packageName}</div>
            {items.map((item) => <button key={item.id} onClick={() => pickCode(item)} type="button" style={{ width: '100%', textAlign: 'left', border: 0, padding: '0.25rem 0.7rem', background: !showingStatic && codeSelectedId === item.id ? 'var(--surface-sunken)' : 'transparent', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>{item.name}</button>)}
          </div>)}
        </aside>
        <section style={{ minWidth: 0, overflow: 'auto', padding: '0.9rem' }}>
          {selectedStatic ? <>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.65rem' }}><FileCode2 size={17} /><strong>{selectedStatic.id}</strong><span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Paketcode · read-only</span></div>
            <textarea readOnly value={code} style={{ width: '100%', minHeight: 500, resize: 'vertical', boxSizing: 'border-box', padding: '0.9rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.82rem', lineHeight: 1.55, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-sunken)' }} />
          </> : <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.55rem', marginBottom: '0.55rem' }}><label>Package<input className="form-input" value={codeEditor.packageName} onChange={(event) => setCodeEditor((current) => ({ ...current, packageName: event.target.value }))} /></label><label>Name<input className="form-input" value={codeEditor.name} onChange={(event) => setCodeEditor((current) => ({ ...current, name: event.target.value }))} /></label></div>
            <label>Beschreibung<input className="form-input" value={codeEditor.description} onChange={(event) => setCodeEditor((current) => ({ ...current, description: event.target.value }))} /></label>
            <label style={{ display: 'block', marginTop: '0.65rem' }}>JavaScript-Modul (exakt exportierte Function)<textarea value={codeEditor.source} onChange={(event) => setCodeEditor((current) => ({ ...current, source: event.target.value }))} spellCheck={false} style={{ width: '100%', minHeight: 330, boxSizing: 'border-box', marginTop: '0.3rem', padding: '0.9rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.82rem', lineHeight: 1.55, border: '1px solid var(--border)', borderRadius: 6 }} /></label>
            <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', marginTop: '0.75rem' }}><label><input type="checkbox" checked={codeEditor.enabled} onChange={(event) => setCodeEditor((current) => ({ ...current, enabled: event.target.checked }))} /> Aktiv</label><span style={{ flex: 1 }} /><button className="btn btn-secondary" type="button" disabled={!codeEditor.id} onClick={() => void deleteCode()}>Löschen</button><button className="btn" type="button" onClick={() => void saveCode()}><Save size={15} /> Speichern</button></div>
          </>}
        </section>
        <aside style={{ borderLeft: '1px solid var(--border)', overflow: 'auto', padding: '0.9rem', fontSize: '0.83rem' }}>
          <strong>Summary</strong>
          {selectedStatic && summary ? <><p style={{ color: 'var(--text-muted)' }}>{summary.description}</p><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', padding: '0.65rem', background: 'var(--surface-sunken)', borderRadius: 5 }}>{signature(summary.name, summary.parameters, summary.returns)}</pre><p><code>functions.{summary.name}(params)</code></p></>
            : <><p style={{ color: 'var(--text-muted)' }}>Aktive Code-Functions werden beim Sessionstart in den isolierten Form-Script-Worker geladen.</p><code>functions.{codeEditor.packageName}.{codeEditor.name}(params)</code><p>Erlaubt ist ein JavaScript-Modul mit <code>export function {codeEditor.name}(params)</code>.</p></>}
        </aside>
      </div>
    ) : (
      <div className="card" style={{ display: 'grid', gridTemplateColumns: '220px minmax(380px, 1fr) 290px', minHeight: 0, flex: 1, overflow: 'hidden' }}>
        <aside style={{ borderRight: '1px solid var(--border)', overflow: 'auto', padding: '0.6rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0.2rem 0 0.55rem' }}><strong style={{ fontSize: '0.85rem' }}>{loadingAql ? 'Lädt von EHRbase…' : 'Auf EHRbase gespeichert'}</strong><button className="btn btn-secondary" type="button" title="Neue Query" onClick={newAql} style={{ padding: '0.3rem' }}><Plus size={15} /></button></div>
          {aqlPackages.map(([packageName, items]) => <div key={packageName} style={{ margin: '0.45rem 0' }}>
            <div style={{ padding: '0.42rem', fontSize: '0.8rem', fontWeight: 600 }}>{packageName}</div>
            {items.map((item) => <button key={item.id} onClick={() => pickAql(item)} type="button" style={{ width: '100%', textAlign: 'left', border: 0, padding: '0.25rem 0.7rem', background: aqlSelectedId === item.id ? 'var(--surface-sunken)' : 'transparent', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer', opacity: item.enabled ? 1 : 0.55 }}>{item.name} <span style={{ color: 'var(--text-muted)' }}>v{item.ehrbaseVersion}</span></button>)}
          </div>)}
        </aside>
        <section style={{ minWidth: 0, overflow: 'auto', padding: '0.9rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.55rem', marginBottom: '0.55rem' }}>
            <label>Package<input className="form-input" value={aqlEditor.packageName} onChange={(event) => setAqlEditor((current) => ({ ...current, packageName: event.target.value }))} disabled={Boolean(aqlEditor.id)} /></label>
            <label>Name<input className="form-input" value={aqlEditor.name} onChange={(event) => setAqlEditor((current) => ({ ...current, name: event.target.value }))} disabled={Boolean(aqlEditor.id)} /></label>
          </div>
          {aqlEditor.id && <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 0.55rem' }}>Package/Name sind nach dem Anlegen fest - EHRbase-Queries sind pro Name permanent, ein Rename würde nur eine zweite, unabhängige Query anlegen.</p>}
          <label>Beschreibung<input className="form-input" value={aqlEditor.description} onChange={(event) => setAqlEditor((current) => ({ ...current, description: event.target.value }))} /></label>
          <label style={{ display: 'block', marginTop: '0.65rem' }}>AQL (nur SELECT, Parameter als <code>:name</code>)<textarea value={aqlEditor.query} onChange={(event) => setAqlEditor((current) => ({ ...current, query: event.target.value }))} spellCheck={false} style={{ width: '100%', minHeight: 280, boxSizing: 'border-box', marginTop: '0.3rem', padding: '0.9rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.82rem', lineHeight: 1.55, border: '1px solid var(--border)', borderRadius: 6 }} /></label>
          <label style={{ display: 'block', marginTop: '0.65rem' }}>Parameters (JSON)<textarea value={aqlEditor.parameters} onChange={(event) => setAqlEditor((current) => ({ ...current, parameters: event.target.value }))} spellCheck={false} style={{ width: '100%', minHeight: 80, boxSizing: 'border-box', marginTop: '0.3rem', padding: '0.65rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: 6 }} /></label>
          <label><input type="checkbox" checked={aqlEditor.autoload} onChange={(event) => setAqlEditor((current) => ({ ...current, autoload: event.target.checked }))} /> Beim Formularstart als Kontext laden</label>
          <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', marginTop: '0.75rem' }}>
            <label><input type="checkbox" checked={aqlEditor.enabled} onChange={(event) => setAqlEditor((current) => ({ ...current, enabled: event.target.checked }))} /> Aktiv (verfügbar für neue Widget-Bindungen)</label>
            <span style={{ flex: 1 }} />
            <button className="btn" type="button" onClick={() => void saveAql()}><Save size={15} /> {aqlEditor.id ? 'Neue Version speichern' : 'Auf EHRbase anlegen'}</button>
          </div>
        </section>
        <aside style={{ borderLeft: '1px solid var(--border)', overflow: 'auto', padding: '0.9rem', fontSize: '0.83rem' }}>
          <strong>Über Queries</strong>
          <p style={{ color: 'var(--text-muted)' }}>Diese Liste kommt direkt von EHRbase (<code>/definition/query</code>) - nicht aus Forms' eigener Datenbank. Jede hier gespeicherte Query landet als echte, versionierte Stored Query auf EHRbase; Widgets führen sie serverseitig mit <code>$parameter</code>-Bindung aus.</p>
          <p style={{ color: 'var(--text-muted)' }}>Der openEHR Query Service kennt kein Löschen: Speichern legt eine neue Version an, die alte bleibt für immer abrufbar. "Aktiv" deaktivieren nimmt die Query nur aus neuen Widget-Bindungen und dem Autoload - sie bleibt auf EHRbase erhalten.</p>
          {selectedAql?.ehrbaseVersion && <p>Aktuelle Version: <code>{selectedAql.ehrbaseVersion}</code></p>}
          <code>context.aql['{aqlEditor.packageName}.{aqlEditor.name}']</code>
        </aside>
      </div>
    )}
  </div>;
}
