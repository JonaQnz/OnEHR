import { useEffect, useMemo, useState } from 'react';
import { Braces, FileCode2, Plus, Save, Trash2 } from 'lucide-react';
import { registeredFunctionPackages } from '../scripting/runtime/registeredFunctions';

const API = 'http://localhost:3001/api';
type FunctionKind = 'code' | 'aql';

interface StoredCodeFunction { id: string; packageName: string; name: string; description: string; source: string; enabled: boolean; }
interface StoredAqlFunction { id: string; packageName: string; name: string; description: string; query: string; parameters: Record<string, unknown>; autoload: boolean; enabled: boolean; }
interface EditorState { id?: string; kind: FunctionKind; packageName: string; name: string; description: string; source: string; parameters: string; autoload: boolean; enabled: boolean; }

const codeTemplate = (name = 'calculateExample') => `export function ${name}(params) {\n  // params enthält die übergebenen Werte.\n  return params.value;\n}`;
const aqlTemplate = "SELECT c/uid/value FROM EHR e[ehr_id/value = :ehrId] CONTAINS COMPOSITION c LIMIT 1";
const emptyEditor = (kind: FunctionKind = 'code', packageName = 'custom'): EditorState => ({ id: undefined, kind, packageName, name: kind === 'code' ? 'calculateExample' : 'latest', description: '', source: kind === 'code' ? codeTemplate() : aqlTemplate, parameters: '{}', autoload: true, enabled: true });

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

export default function FunctionsAdmin() {
  const [codeFunctions, setCodeFunctions] = useState<StoredCodeFunction[]>([]);
  const [aqlFunctions, setAqlFunctions] = useState<StoredAqlFunction[]>([]);
  const [selected, setSelected] = useState(`package:${registeredFunctionPackages[0]?.id || 'clinical-scores'}`);
  const [editor, setEditor] = useState<EditorState>(emptyEditor());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = async () => {
    try {
      const [code, aql] = await Promise.all([request<{ functions: StoredCodeFunction[] }>('/functions/code'), request<{ functions: StoredAqlFunction[] }>('/functions/aql')]);
      setCodeFunctions(code.functions); setAqlFunctions(aql.functions);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Functions konnten nicht geladen werden.'); }
  };
  useEffect(() => { void load(); }, []);

  const packages = useMemo(() => {
    const custom = new Map<string, FunctionKind[]>();
    const definitions = [
      ...codeFunctions.map((item) => ({ packageName: item.packageName, kind: 'code' as const })),
      ...aqlFunctions.map((item) => ({ packageName: item.packageName, kind: 'aql' as const })),
    ];
    definitions.forEach(({ packageName, kind }) => custom.set(packageName, [...new Set([...(custom.get(packageName) || []), kind])]));
    return { static: registeredFunctionPackages, custom: [...custom.entries()].sort(([a], [b]) => a.localeCompare(b)) };
  }, [codeFunctions, aqlFunctions]);
  const selectedStatic = selected.startsWith('package:') ? registeredFunctionPackages.find((item) => `package:${item.id}` === selected) : undefined;
  const selectedCode = selected.startsWith('code:') ? codeFunctions.find((item) => `code:${item.id}` === selected) : undefined;
  const selectCode = (item: StoredCodeFunction) => { setSelected(`code:${item.id}`); setEditor({ id: item.id, kind: 'code', packageName: item.packageName, name: item.name, description: item.description, source: item.source, parameters: '{}', autoload: true, enabled: item.enabled }); setError(''); setNotice(''); };
  const selectAql = (item: StoredAqlFunction) => { setSelected(`aql:${item.id}`); setEditor({ id: item.id, kind: 'aql', packageName: item.packageName, name: item.name, description: item.description, source: item.query, parameters: JSON.stringify(item.parameters || {}, null, 2), autoload: item.autoload, enabled: item.enabled }); setError(''); setNotice(''); };
  const create = (kind: FunctionKind, packageName = 'custom') => { setSelected('new'); setEditor(emptyEditor(kind, packageName)); setError(''); setNotice(`Neue ${kind === 'code' ? 'Code-Function' : 'AQL-Function'} anlegen.`); };
  const update = <K extends keyof EditorState>(key: K, value: EditorState[K]) => setEditor((current) => ({ ...current, [key]: value }));
  const changeKind = (kind: FunctionKind) => setEditor((current) => ({ ...emptyEditor(kind, current.packageName), id: undefined, description: current.description }));
  const save = async () => {
    try {
      const payload = editor.kind === 'code' ? { packageName: editor.packageName, name: editor.name, description: editor.description, source: editor.source, enabled: editor.enabled } : { packageName: editor.packageName, name: editor.name, description: editor.description, query: editor.source, parameters: JSON.parse(editor.parameters || '{}'), autoload: editor.autoload, enabled: editor.enabled };
      const path = `/functions/${editor.kind}${editor.id ? `/${editor.id}` : ''}`;
      const saved = await request<StoredCodeFunction | StoredAqlFunction>(path, { method: editor.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      await load();
      if (editor.kind === 'code') selectCode(saved as StoredCodeFunction); else selectAql(saved as StoredAqlFunction);
      setNotice(`functions.${saved.packageName}.${saved.name} gespeichert.`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Function konnte nicht gespeichert werden.'); }
  };
  const remove = async () => {
    if (!editor.id) return;
    try { await request<void>(`/functions/${editor.kind}/${editor.id}`, { method: 'DELETE' }); await load(); create(editor.kind, editor.packageName); setNotice('Function gelöscht.'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Function konnte nicht gelöscht werden.'); }
  };

  const code = selectedStatic ? selectedStatic.functions.map(staticFunctionCode).join('\n\n') : selectedCode ? selectedCode.source : editor.source;
  const summary = selectedStatic ? selectedStatic.functions[0] : undefined;
  return <div style={{ padding: '1rem', height: 'calc(100vh - 2rem)', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
    <header style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', minHeight: 36 }}><Braces size={22} color="var(--primary)" /><strong>Functions</strong><span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Code-Pakete und serverseitige AQL-Kontexte.</span></header>
    {error && <div role="alert" style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</div>}{notice && <div style={{ color: '#15803d', fontSize: '0.85rem' }}>{notice}</div>}
    <div className="card" style={{ display: 'grid', gridTemplateColumns: '220px minmax(380px, 1fr) 290px', minHeight: 0, flex: 1, overflow: 'hidden' }}>
      <aside style={{ borderRight: '1px solid var(--border)', overflow: 'auto', padding: '0.6rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '0.2rem 0 0.55rem' }}><strong style={{ fontSize: '0.85rem' }}>Packages</strong><span><button className="btn btn-secondary" type="button" title="Neue Code-Function" onClick={() => create('code')} style={{ padding: '0.3rem', marginRight: 4 }}><Plus size={15} /></button><button className="btn btn-secondary" type="button" title="Neues AQL-Script" onClick={() => create('aql')} style={{ padding: '0.3rem', fontSize: '0.7rem' }}>AQL</button></span></div>
        {packages.static.map((pkg) => <button key={pkg.id} type="button" onClick={() => { setSelected(`package:${pkg.id}`); setError(''); setNotice(''); }} style={{ width: '100%', textAlign: 'left', border: 0, borderRadius: 4, padding: '0.48rem', cursor: 'pointer', background: selected === `package:${pkg.id}` ? 'var(--surface-sunken)' : 'transparent', marginBottom: 4 }}><strong style={{ fontSize: '0.8rem' }}>{pkg.id}</strong><span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.72rem' }}>{pkg.functions.length} Code-Functions · read-only</span></button>)}
        {packages.custom.map(([packageName, kinds]) => <div key={packageName} style={{ margin: '0.45rem 0' }}><button type="button" onClick={() => { const fn = codeFunctions.find((item) => item.packageName === packageName) || aqlFunctions.find((item) => item.packageName === packageName); if (fn && 'source' in fn) selectCode(fn); else if (fn) selectAql(fn); }} style={{ width: '100%', textAlign: 'left', border: 0, borderRadius: 4, padding: '0.42rem', cursor: 'pointer', background: 'transparent' }}><strong style={{ fontSize: '0.8rem' }}>{packageName}</strong><span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.72rem' }}>{kinds.join(' + ')}</span></button>{codeFunctions.filter((item) => item.packageName === packageName).map((item) => <button key={item.id} onClick={() => selectCode(item)} type="button" style={{ width: '100%', textAlign: 'left', border: 0, padding: '0.25rem 0.7rem', background: selected === `code:${item.id}` ? 'var(--surface-sunken)' : 'transparent', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>{item.name}</button>)}{aqlFunctions.filter((item) => item.packageName === packageName).map((item) => <button key={item.id} onClick={() => selectAql(item)} type="button" style={{ width: '100%', textAlign: 'left', border: 0, padding: '0.25rem 0.7rem', background: selected === `aql:${item.id}` ? 'var(--surface-sunken)' : 'transparent', fontFamily: 'monospace', fontSize: '0.75rem', cursor: 'pointer' }}>{item.name} <span style={{ color: 'var(--text-muted)' }}>AQL</span></button>)}</div>)}
      </aside>
      <section style={{ minWidth: 0, overflow: 'auto', padding: '0.9rem' }}>
        {selectedStatic ? <><div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.65rem' }}><FileCode2 size={17} /><strong>{selectedStatic.id}</strong><span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Paketcode · read-only</span></div><textarea readOnly value={code} style={{ width: '100%', minHeight: 500, resize: 'vertical', boxSizing: 'border-box', padding: '0.9rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.82rem', lineHeight: 1.55, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface-sunken)' }} /></> : <>
          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr', gap: '0.55rem', marginBottom: '0.55rem' }}><label>Typ<select className="form-input" value={editor.kind} onChange={(event) => changeKind(event.target.value as FunctionKind)} disabled={Boolean(editor.id)}><option value="code">Code</option><option value="aql">AQL</option></select></label><label>Package<input className="form-input" value={editor.packageName} onChange={(event) => update('packageName', event.target.value)} /></label><label>Name<input className="form-input" value={editor.name} onChange={(event) => update('name', event.target.value)} /></label></div>
          <label>Beschreibung<input className="form-input" value={editor.description} onChange={(event) => update('description', event.target.value)} /></label>
          <label style={{ display: 'block', marginTop: '0.65rem' }}>{editor.kind === 'code' ? 'JavaScript-Modul (exakt exportierte Function)' : 'AQL (nur SELECT)'}<textarea value={code} onChange={(event) => update('source', event.target.value)} spellCheck={false} style={{ width: '100%', minHeight: 330, boxSizing: 'border-box', marginTop: '0.3rem', padding: '0.9rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.82rem', lineHeight: 1.55, border: '1px solid var(--border)', borderRadius: 6 }} /></label>
          {editor.kind === 'aql' && <><label style={{ display: 'block', marginTop: '0.65rem' }}>Parameters (JSON)<textarea value={editor.parameters} onChange={(event) => update('parameters', event.target.value)} spellCheck={false} style={{ width: '100%', minHeight: 80, boxSizing: 'border-box', marginTop: '0.3rem', padding: '0.65rem', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: 6 }} /></label><label><input type="checkbox" checked={editor.autoload} onChange={(event) => update('autoload', event.target.checked)} /> Beim Formularstart als Kontext laden</label></>}
          <div style={{ display: 'flex', gap: '0.7rem', alignItems: 'center', marginTop: '0.75rem' }}><label><input type="checkbox" checked={editor.enabled} onChange={(event) => update('enabled', event.target.checked)} /> Aktiv</label><span style={{ flex: 1 }} /><button className="btn btn-secondary" type="button" disabled={!editor.id} onClick={() => void remove()}><Trash2 size={15} /> Löschen</button><button className="btn" type="button" onClick={() => void save()}><Save size={15} /> Speichern</button></div>
        </>}
      </section>
      <aside style={{ borderLeft: '1px solid var(--border)', overflow: 'auto', padding: '0.9rem', fontSize: '0.83rem' }}><strong>Summary</strong>{selectedStatic && summary ? <><p style={{ color: 'var(--text-muted)' }}>{summary.description}</p><pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: '0.78rem', padding: '0.65rem', background: 'var(--surface-sunken)', borderRadius: 5 }}>{signature(summary.name, summary.parameters, summary.returns)}</pre><p><code>functions.{summary.name}(params)</code></p></> : editor.kind === 'code' ? <><p style={{ color: 'var(--text-muted)' }}>Aktive Code-Functions werden beim Sessionstart in den isolierten Form-Script-Worker geladen.</p><code>functions.{editor.packageName}.{editor.name}(params)</code><p>Erlaubt ist ein JavaScript-Modul mit <code>export function {editor.name}(params)</code>.</p></> : <><p style={{ color: 'var(--text-muted)' }}>Das AQL-Script läuft serverseitig beim Formularstart und füllt keine Felder direkt.</p><code>context.aql['{editor.packageName}.{editor.name}']</code><p>Letzte Composition: <code>context.composition?.flat</code></p></>}</aside>
    </div>
  </div>;
}
