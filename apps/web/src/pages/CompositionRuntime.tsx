import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, FileText, RefreshCw } from 'lucide-react';
import { COMPOSITION_SCRIPTING_EXTENSION_KEY, getCompositionDefinition, normalizeCompositionScript, type CompositionDataBlock, type CompositionDefinition, type FormDefinitionV1 } from 'core';
import { formEmbedUrl, isFormEmbedEvent, launchEmbeddedForm } from '../integration/formLaunch';
import { ClinicalGrid, ClinicalTabs } from '../components/layout/ClinicalLayout';
import { CompositionScriptClient } from '../scripting/runtime/CompositionScriptClient';
import { WidgetDataCard, type WidgetDataState } from '../components/WidgetDataCard';

const API = 'http://localhost:3001/api';
type Mode = 'create' | 'edit' | 'view' | 'prefill';
type FormRecord = { id: string; name: string; canonical_json: FormDefinitionV1 };
type Launch = { url?: string; error?: string; loading?: boolean };
type Child = { blockId: string; sessionId?: string; formId: string; status: string; valid?: boolean; issues?: Array<{ path: string; code: string; message: string }> };
type CompositionSession = { id: string; patientId: string; patientNamespace?: string; ehrId?: string; mode: Mode; status: string; childSessions: Record<string, string>; children: Child[]; progress: { total: number; started: number; ready: number; submitted: number } };
type DataState = WidgetDataState;
type PatientOption = { id: string; patientId: string; patientNamespace?: string; namespace?: string; ehrId?: string | null; firstName?: string; lastName?: string };
async function request<T>(path: string, options: RequestInit = {}): Promise<T> { const response = await fetch(`${API}${path}`, { ...options, credentials: 'include', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`); return body as T; }

export default function CompositionRuntime() {
  const { id } = useParams(); const [searchParams] = useSearchParams();
  const [record, setRecord] = useState<FormRecord | null>(null); const [composition, setComposition] = useState<CompositionDefinition | null>(null); const [session, setSession] = useState<CompositionSession | null>(null);
  const [pageIndex, setPageIndex] = useState(0); const [patientId, setPatientId] = useState(searchParams.get('patientId') || ''); const [namespace, setNamespace] = useState(searchParams.get('patientNamespace') || ''); const [ehrId, setEhrId] = useState(searchParams.get('ehrId') || ''); const [mode, setMode] = useState<Mode>(() => { const requested = searchParams.get('mode'); return requested === 'edit' || requested === 'view' || requested === 'prefill' ? requested : 'create'; });
  const [launches, setLaunches] = useState<Record<string, Launch>>({}); const [data, setData] = useState<Record<string, DataState>>({}); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [checking, setChecking] = useState(false);
  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [iframeHeights, setIframeHeights] = useState<Record<string, number>>({});
  const [hiddenPageIds, setHiddenPageIds] = useState<Set<string>>(() => new Set()); const [hiddenBlockIds, setHiddenBlockIds] = useState<Set<string>>(() => new Set()); const scriptClient = useRef<CompositionScriptClient | null>(null);
  const returnUrl = useMemo(() => {
    const requested = searchParams.get('returnUrl');
    return requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';
  }, [searchParams]);
  useEffect(() => { if (!id) return; void request<FormRecord>(`/forms/${encodeURIComponent(id)}`).then((form) => { const value = getCompositionDefinition(form.canonical_json.extensions); if (!value) throw new Error('Dieses Formular ist keine Composition.'); setRecord(form); setComposition(value); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Composition konnte nicht geladen werden.')); }, [id]);
  useEffect(() => { void request<PatientOption[]>('/patients').then((items) => setPatients(Array.isArray(items) ? items : [])).catch(() => setPatients([])); }, []);
  const page = composition?.pages[pageIndex]; const contextReady = patientId.trim().length > 0 && ehrId.trim().length > 0;
  const reset = () => { setSession(null); setLaunches({}); setData({}); setNotice(''); };
  const refreshSession = async (sessionId = session?.id) => { if (!sessionId) return; const next = await request<CompositionSession>(`/composition-sessions/${encodeURIComponent(sessionId)}`); setSession(next); return next; };
  const ensureSession = async (): Promise<CompositionSession | undefined> => {
    if (!record || !contextReady) return undefined;
    if (session && session.patientId === patientId.trim() && session.mode === mode) return session;
    const forceNew = searchParams.get('forceNew') === 'true';
    const next = await request<CompositionSession>('/composition-sessions', { method: 'POST', body: JSON.stringify({ compositionFormId: record.id, patientId: patientId.trim(), patientNamespace: namespace.trim() || undefined, ehrId: ehrId.trim() || undefined, mode, forceNew }) });
    setSession(next); return next;
  };
  const refreshData = (onlyBlockId?: string, force = false) => {
    if (!record || !composition || !contextReady) return;
    const blocks = composition.pages.flatMap((candidate) => candidate.blocks).filter((block): block is CompositionDataBlock => block.type === 'data' && (!onlyBlockId || block.id === onlyBlockId));
    for (const block of blocks) {
      if (!force && (data[block.id]?.loading || data[block.id]?.rows)) continue;
      setData((current) => ({ ...current, [block.id]: { loading: true } }));
      void request<{ rows: Record<string, unknown>[] }>(`/forms/${encodeURIComponent(record.id)}/composition-data`, { method: 'POST', body: JSON.stringify({ blockId: block.id, patient: { id: patientId.trim(), ...(namespace.trim() ? { namespace: namespace.trim() } : {}) }, ehrId: ehrId.trim() || undefined }) }).then((result) => setData((current) => ({ ...current, [block.id]: { rows: result.rows } }))).catch((reason) => setData((current) => ({ ...current, [block.id]: { error: reason instanceof Error ? reason.message : 'Daten konnten nicht geladen werden.' } })));
    }
  };
  const startPage = async () => {
    if (!page || !contextReady || !record) return;
    try {
      const parent = await ensureSession(); if (!parent) return;
      for (const block of page.blocks) {
        if (block.type !== 'form' || !block.formId || launches[block.id]?.url || launches[block.id]?.loading) continue;
        const childSessionId = parent.childSessions[block.id];
        if (childSessionId) { setLaunches((current) => ({ ...current, [block.id]: { url: formEmbedUrl(`/embed/forms/${encodeURIComponent(block.formId)}?sessionId=${encodeURIComponent(childSessionId)}&launchId=${encodeURIComponent(`${parent.id}:${block.id}`)}`) } })); continue; }
        setLaunches((current) => ({ ...current, [block.id]: { loading: true } }));
        try {
          const blockLoad = block.load || (mode === 'create' ? 'never' : 'provider');
          const blockMode = mode === 'create' && blockLoad === 'provider' ? 'prefill' : mode;
          const launch = await launchEmbeddedForm({ formId: block.formId, patient: { id: patientId.trim(), ...(namespace.trim() ? { namespace: namespace.trim() } : {}) }, mode: blockMode, load: blockLoad, hiddenFieldIds: block.hiddenFieldIds, launchId: `${parent.id}:${block.id}` });
          const attached = await request<CompositionSession>(`/composition-sessions/${encodeURIComponent(parent.id)}/blocks/${encodeURIComponent(block.id)}`, { method: 'PUT', body: JSON.stringify({ childSessionId: launch.session.id }) });
          setSession(attached); setLaunches((current) => ({ ...current, [block.id]: { url: formEmbedUrl(launch.launchUrl) } }));
        } catch (reason) { setLaunches((current) => ({ ...current, [block.id]: { error: reason instanceof Error ? reason.message : 'Formular konnte nicht gestartet werden.' } })); }
      }
      refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Composition-Session konnte nicht gestartet werden.'); }
  };
  useEffect(() => { void startPage(); }, [pageIndex, composition, patientId, namespace, ehrId, mode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!record || !composition || !contextReady) return;
    const script = normalizeCompositionScript(record.canonical_json.extensions?.[COMPOSITION_SCRIPTING_EXTENSION_KEY], composition);
    if (!script.compiled) return;
    setHiddenPageIds(new Set()); setHiddenBlockIds(new Set());
    const status = { currentPage: composition.pages[pageIndex]?.id || composition.pages[0].id, completedBlocks: session?.children.filter((child) => child.status === 'submitted').map((child) => child.blockId) || [], pendingBlocks: session?.children.filter((child) => child.status !== 'submitted').map((child) => child.blockId) || [], state: (session?.status === 'submitted' ? 'submitted' : session?.status === 'completed' ? 'completed' : session ? 'in_progress' : 'draft') as 'draft' | 'in_progress' | 'completed' | 'submitted' };
    const client = new CompositionScriptClient({ compiled: script.compiled, pageIds: composition.pages.map((candidate) => candidate.id), blockIds: composition.pages.flatMap((candidate) => candidate.blocks.map((block) => block.id)), dataBlockIds: composition.pages.flatMap((candidate) => candidate.blocks.filter((block) => block.type === 'data').map((block) => block.id)), status, onPageVisibility: (blockId, visible) => setHiddenPageIds((current) => { const next = new Set(current); visible ? next.delete(blockId) : next.add(blockId); return next; }), onBlockVisibility: (blockId, visible) => setHiddenBlockIds((current) => { const next = new Set(current); visible ? next.delete(blockId) : next.add(blockId); return next; }), onRefreshData: (blockId) => refreshData(blockId, true), onDataLoading: (blockId, loading) => setData((current) => ({ ...current, [blockId]: { ...current[blockId], loading } })), onNavigate: (target) => setPageIndex(composition.pages.findIndex((candidate) => candidate.id === target)), onNext: () => setPageIndex((current) => Math.min(composition.pages.length - 1, current + 1)), onPrevious: () => setPageIndex((current) => Math.max(0, current - 1)), onError: setNotice });
    scriptClient.current = client; return () => { client.destroy(); if (scriptClient.current === client) scriptClient.current = null; };
  }, [record, composition, contextReady, patientId, namespace, ehrId, mode]); // script gets a fresh, scoped patient context
  useEffect(() => { if (!composition || !page) return; scriptClient.current?.updateStatus({ currentPage: page.id, completedBlocks: session?.children.filter((child) => child.status === 'submitted').map((child) => child.blockId) || [], pendingBlocks: session?.children.filter((child) => child.status !== 'submitted').map((child) => child.blockId) || [], state: (session?.status === 'submitted' ? 'submitted' : session?.status === 'completed' ? 'completed' : session ? 'in_progress' : 'draft') }); }, [composition, page, session]);
  useEffect(() => { const onMessage = (event: MessageEvent) => { if (event.origin !== window.location.origin || !isFormEmbedEvent(event.data) || !session) return; if (event.data.event === 'submitted' || event.data.event === 'loaded') void refreshSession(); if (event.data.event === 'error' && event.data.message) setNotice(event.data.message); if (event.data.event === 'resize' && event.data.height && event.data.launchId) setIframeHeights((current) => ({ ...current, [event.data.launchId!.split(':')[1]]: event.data.height! })); }; window.addEventListener('message', onMessage); return () => window.removeEventListener('message', onMessage); }, [session]);
  const validateAll = async () => { if (!session) { await startPage(); return; } setChecking(true); setNotice(''); try { const result = await request<{ session: CompositionSession; valid: boolean }> (`/composition-sessions/${encodeURIComponent(session.id)}/validate`, { method: 'POST' }); setSession(result.session); setNotice(result.valid ? 'Alle gestarteten Formulare sind valide. Nicht abgesendete Formulare können nun einzeln abgeschlossen werden.' : 'Es gibt noch fehlende oder ungültige Formulare. Die Details stehen in der Fortschrittsleiste.'); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Gesamtprüfung fehlgeschlagen.'); } finally { setChecking(false); } };
  if (error && !record) return <div style={{ padding: '2rem', color: '#b91c1c' }}>{error}</div>;
  if (!record || !composition || !page) return <div style={{ padding: '2rem' }}>Composition wird geladen…</div>;
  const complete = session?.progress.total === session?.progress.submitted && (session?.progress.total || 0) > 0;
  return <div style={{ maxWidth: 1280, margin: '0 auto', padding: '1.5rem' }}>
    <Link to={returnUrl} style={{ display: 'inline-flex', gap: '.4rem', alignItems: 'center', color: '#64748b', textDecoration: 'none', marginBottom: '1rem' }}><ArrowLeft size={16} /> Zurück zur Patientenakte</Link>
    <div className="card" style={{ marginBottom: '1rem' }}><h1 style={{ margin: 0 }}>{record.name}</h1><p style={{ color: '#64748b', marginBottom: 0 }}>Mehrere Formulare als ein fortsetzbarer klinischer Vorgang.</p></div>
    <div className="card" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: '.75rem', alignItems: 'end', marginBottom: '1rem' }}><label className="form-label">Patient<select className="form-input" value={patients.find((item) => item.patientId === patientId)?.id || ''} onChange={(event) => { const selected = patients.find((item) => item.id === event.target.value); if (selected) { setPatientId(selected.patientId); setNamespace(selected.patientNamespace || selected.namespace || ''); setEhrId(selected.ehrId || ''); } else { setPatientId(''); setNamespace(''); setEhrId(''); } reset(); }}><option value="">Patient auswählen…</option>{patients.map((item) => <option key={item.id} value={item.id}>{[item.lastName, item.firstName].filter(Boolean).join(', ') || item.patientId} · {item.patientId}</option>)}</select><input className="form-input" style={{ marginTop: '.4rem' }} value={patientId} onChange={(event) => { setPatientId(event.target.value); reset(); }} placeholder="Patient-ID / EHR-ID" /></label><label className="form-label">Namespace<input className="form-input" value={namespace} onChange={(event) => { setNamespace(event.target.value); reset(); }} /></label><label className="form-label">EHR-ID (optional)<input className="form-input" value={ehrId} onChange={(event) => { setEhrId(event.target.value); reset(); }} /></label><label className="form-label">Modus<select className="form-input" value={mode} onChange={(event) => { setMode(event.target.value as Mode); reset(); }}><option value="create">Neu</option><option value="edit">Bearbeiten</option><option value="prefill">Vorausfüllen</option><option value="view">Ansehen</option></select></label><button className="btn" onClick={() => void startPage()} disabled={!contextReady}><RefreshCw size={16} /> Öffnen</button></div>
    {session && <section className="card" style={{ marginBottom: '1rem', borderColor: complete ? '#86efac' : '#bfdbfe' }}><div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}><div><strong>Composition-Vorgang</strong><div style={{ color: '#64748b', fontSize: '.82rem', marginTop: '.2rem' }}>Entwurf wird automatisch über die Unterformular-Sessions fortgesetzt · {session.progress.started}/{session.progress.total} gestartet · {session.progress.ready}/{session.progress.total} geprüft · {session.progress.submitted}/{session.progress.total} abgesendet</div></div><div style={{ display: 'flex', gap: '.5rem' }}><button className="btn btn-secondary" onClick={() => void validateAll()} disabled={checking}><CheckCircle2 size={16} /> {checking ? 'Prüft…' : 'Alle Formulare prüfen'}</button><button className="btn btn-primary" onClick={() => { document.querySelectorAll('iframe').forEach(iframe => iframe.contentWindow?.postMessage({ type: 'EXTERNAL_FORM_SUBMIT' }, '*')); }}><CheckCircle2 size={16} /> Alle Speichern</button></div></div><div style={{ height: 8, background: '#e2e8f0', borderRadius: 99, overflow: 'hidden', margin: '.8rem 0' }}><div style={{ height: '100%', width: `${session.progress.total ? session.progress.submitted / session.progress.total * 100 : 0}%`, background: complete ? '#16a34a' : '#2563eb', transition: 'width .2s' }} /></div>{session.children.filter((child) => child.status !== 'submitted').map((child) => <div key={child.blockId} style={{ color: child.status === 'not_started' ? '#a16207' : child.valid ? '#166534' : '#b91c1c', fontSize: '.8rem' }}>{child.status === 'not_started' ? 'Noch nicht gestartet' : child.valid ? 'Bereit zum Absenden' : 'Prüfung erforderlich'} · {child.formId}</div>)}{complete && <div style={{ color: '#166534', fontWeight: 600, fontSize: '.85rem' }}>Der gesamte Composition-Vorgang ist abgeschlossen.</div>}</section>}
    {notice && <div className="card" style={{ marginBottom: '1rem', color: '#1d4ed8' }}>{notice}</div>}
    <ClinicalTabs tabs={composition.pages.filter((candidate) => !hiddenPageIds.has(candidate.id)).map((candidate) => ({ id: candidate.id, label: candidate.title }))} activeId={page.id} onSelect={(pageId) => setPageIndex(composition.pages.findIndex((candidate) => candidate.id === pageId))} />
    {page.description && <p style={{ color: '#64748b', margin: '0 0 1rem' }}>{page.description}</p>}
    {!contextReady ? <div className="card" style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>Wähle einen Patienten mit EHR-ID. Erst dann werden Formulare und klinische Daten als fortsetzbarer Vorgang geladen.</div> : <ClinicalGrid columns={page.columns || 1}>{page.blocks.filter((block) => !hiddenBlockIds.has(block.id)).map((block) => <div key={block.id} style={{ gridColumn: `span ${block.column || 1}` }}>{block.type === 'form' ? <section className="card" style={{ padding: 0, overflow: 'hidden' }}><div style={{ padding: '.85rem 1rem', display: 'flex', alignItems: 'center', gap: '.5rem', borderBottom: '1px solid #e2e8f0' }}><FileText size={17} color="#2563eb" /><strong>{block.title || 'Formular'}</strong><span style={{ marginLeft: 'auto', color: '#64748b', fontSize: '.78rem' }}>Modus: {mode === 'create' ? 'Neu' : mode === 'edit' ? 'Bearbeiten' : mode === 'prefill' ? 'Vorausfüllen' : 'Ansehen'}</span></div>{launches[block.id]?.loading && <div style={{ padding: '2rem', color: '#64748b' }}>Formular wird vorbereitet…</div>}{launches[block.id]?.error && <div style={{ padding: '1rem', color: '#b91c1c' }}>{launches[block.id].error}</div>}{launches[block.id]?.url && <iframe title={block.title || block.id} src={launches[block.id].url} style={{ border: 0, width: '100%', height: block.displayMode === 'fixed' ? 720 : (iframeHeights[block.id] || 300), display: 'block', background: '#f8fafc', transition: 'height .2s' }} scrolling={block.displayMode === 'fixed' ? 'auto' : 'no'} />}</section> : block.type === 'data' ? <WidgetDataCard block={block} state={data[block.id]} /> : <section className="card"><strong>{block.title}</strong><p style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{block.content}</p></section>}</div>)}</ClinicalGrid>}
  </div>;
}
