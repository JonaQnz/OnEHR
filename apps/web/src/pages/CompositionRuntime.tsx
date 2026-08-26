import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, FileText, LayoutGrid, Rows3, RefreshCw } from 'lucide-react';
import { COMPOSITION_SCRIPTING_EXTENSION_KEY, getCompositionDefinition, normalizeCompositionScript, type CompositionBlock, type CompositionDataBlock, type CompositionDefinition, type CompositionPage, type FormDefinitionV1 } from 'core';
import { formEmbedUrl, isFormEmbedEvent, launchEmbeddedForm } from '../integration/formLaunch';
import { ClinicalGrid, ClinicalStack, ClinicalTabs } from '../components/layout/ClinicalLayout';
import { CompositionScriptClient } from '../scripting/runtime/CompositionScriptClient';
import { WidgetDataCard, type WidgetDataState } from '../components/WidgetDataCard';

const API = 'http://localhost:3001/api';
type Mode = 'create' | 'edit' | 'view' | 'prefill';
type ViewMode = 'tabs' | 'stacked';
type FormRecord = { id: string; name: string; canonical_json: FormDefinitionV1 };
type Launch = { url?: string; error?: string; loading?: boolean };
type Child = { blockId: string; sessionId?: string; formId: string; status: string; valid?: boolean; issues?: Array<{ path: string; code: string; message: string }> };
type CompositionSession = { id: string; patientId: string; patientNamespace?: string; ehrId?: string; mode: Mode; status: string; childSessions: Record<string, string>; children: Child[]; progress: { total: number; started: number; ready: number; submitted: number } };
type DataState = WidgetDataState;
type PatientOption = { id: string; patientId: string; patientNamespace?: string; namespace?: string; ehrId?: string | null; firstName?: string; lastName?: string };
type SaveOutcome = { status: 'pending' | 'ok' | 'error'; message?: string };
async function request<T>(path: string, options: RequestInit = {}): Promise<T> { const response = await fetch(`${API}${path}`, { ...options, credentials: 'include', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || body.message || `Request failed (${response.status})`); return body as T; }

const CHILD_STATUS_COLORS: Record<string, { background: string; color: string; border: string; label: string }> = {
  not_started: { background: '#f8fafc', color: 'var(--text-muted)', border: 'var(--border)', label: 'Nicht gestartet' },
  in_progress: { background: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe', label: 'In Bearbeitung' },
  ready: { background: '#fefce8', color: '#854d0e', border: '#fde68a', label: 'Bereit' },
  submitted: { background: 'var(--success-light)', color: '#15803d', border: '#bbf7d0', label: 'Abgesendet' },
  failed: { background: 'var(--danger-light)', color: '#b91c1c', border: '#fecaca', label: 'Fehlgeschlagen' },
};
function childBadge(status?: string) {
  const info = CHILD_STATUS_COLORS[status || 'not_started'] || CHILD_STATUS_COLORS.not_started;
  return <span style={{ display: 'inline-flex', alignItems: 'center', padding: '.15rem .5rem', borderRadius: 999, border: `1px solid ${info.border}`, background: info.background, color: info.color, fontSize: '.72rem', fontWeight: 600, whiteSpace: 'nowrap' }}>{info.label}</span>;
}

export default function CompositionRuntime() {
  const { id } = useParams(); const [searchParams] = useSearchParams(); const navigate = useNavigate();
  const [record, setRecord] = useState<FormRecord | null>(null); const [composition, setComposition] = useState<CompositionDefinition | null>(null); const [session, setSession] = useState<CompositionSession | null>(null);
  const [pageIndex, setPageIndex] = useState(0); const [patientId, setPatientId] = useState(searchParams.get('patientId') || ''); const [namespace, setNamespace] = useState(searchParams.get('patientNamespace') || ''); const [ehrId, setEhrId] = useState(searchParams.get('ehrId') || ''); const [mode, setMode] = useState<Mode>(() => { const requested = searchParams.get('mode'); return requested === 'edit' || requested === 'view' || requested === 'prefill' ? requested : 'create'; });
  const [launches, setLaunches] = useState<Record<string, Launch>>({}); const [data, setData] = useState<Record<string, DataState>>({}); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [checking, setChecking] = useState(false);
  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [iframeHeights, setIframeHeights] = useState<Record<string, number>>({});
  const [hiddenPageIds, setHiddenPageIds] = useState<Set<string>>(() => new Set()); const [hiddenBlockIds, setHiddenBlockIds] = useState<Set<string>>(() => new Set()); const scriptClient = useRef<CompositionScriptClient | null>(null);
  const [viewMode, setViewModeState] = useState<ViewMode>('tabs');
  const [saveOutcomes, setSaveOutcomes] = useState<Record<string, SaveOutcome>>({});
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});
  const returnUrl = useMemo(() => {
    const requested = searchParams.get('returnUrl');
    return requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';
  }, [searchParams]);
  // Aggregated across every embedded child form's own 'dirty' embed event -
  // an iframe's own beforeunload guard only ever protects that iframe's own
  // document, never this page's route change, so the aggregate lives here.
  const [dirtyBlocks, setDirtyBlocks] = useState<Set<string>>(() => new Set());
  const anyDirty = dirtyBlocks.size > 0;
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);
  const guardedNavigate = (go: () => void) => { if (!anyDirty) { go(); return; } setPendingNav(() => go); };
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!anyDirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [anyDirty]);
  useEffect(() => { if (!id) return; void request<FormRecord>(`/forms/${encodeURIComponent(id)}`).then((form) => { const value = getCompositionDefinition(form.canonical_json.extensions); if (!value) throw new Error('Dieses Formular ist keine Composition.'); setRecord(form); setComposition(value); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : 'Composition konnte nicht geladen werden.')); }, [id]);
  useEffect(() => { void request<PatientOption[]>('/patients').then((items) => setPatients(Array.isArray(items) ? items : [])).catch(() => setPatients([])); }, []);
  // Author default from the Composition itself, overridden by whatever this
  // browser last chose for this specific Composition - a display preference,
  // not clinical data, so localStorage (not the session) is the right home.
  useEffect(() => {
    if (!id || !composition) return;
    const stored = localStorage.getItem(`compositionViewMode:${id}`);
    setViewModeState(stored === 'stacked' || stored === 'tabs' ? stored : (composition.viewMode || 'tabs'));
  }, [id, composition]);
  const setViewMode = (next: ViewMode) => { setViewModeState(next); if (id) localStorage.setItem(`compositionViewMode:${id}`, next); };

  const page = composition?.pages[pageIndex]; const contextReady = patientId.trim().length > 0 && ehrId.trim().length > 0;
  const reset = () => { setSession(null); setLaunches({}); setData({}); setNotice(''); setSaveOutcomes({}); iframeRefs.current = {}; };
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
  // Launches every form block in the given set that isn't already started.
  // Tabs mode calls this with just the active page's blocks; stacked mode
  // calls it with every (non-hidden) page's blocks, since everything is
  // visible - and already-started blocks are skipped, so switching between
  // modes never re-launches or loses an in-progress iframe.
  const startBlocks = async (blocks: CompositionBlock[]) => {
    if (!contextReady || !record) return;
    try {
      const parent = await ensureSession(); if (!parent) return;
      for (const block of blocks) {
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
  const startPage = () => (page ? startBlocks(page.blocks) : Promise.resolve());
  const startVisible = () => startBlocks(viewMode === 'stacked' ? (composition?.pages || []).filter((candidate) => !hiddenPageIds.has(candidate.id)).flatMap((candidate) => candidate.blocks) : (page?.blocks || []));
  useEffect(() => { void startVisible(); }, [pageIndex, composition, patientId, namespace, ehrId, mode, viewMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!record || !composition || !contextReady) return;
    const script = normalizeCompositionScript(record.canonical_json.extensions?.[COMPOSITION_SCRIPTING_EXTENSION_KEY], composition);
    if (!script.compiled) return;
    setHiddenPageIds(new Set()); setHiddenBlockIds(new Set());
    const status = { currentPage: composition.pages[pageIndex]?.id || composition.pages[0].id, completedBlocks: session?.children.filter((child) => child.status === 'submitted').map((child) => child.blockId) || [], pendingBlocks: session?.children.filter((child) => child.status !== 'submitted').map((child) => child.blockId) || [], state: (session?.status === 'submitted' ? 'submitted' : session ? 'in_progress' : 'draft') as 'draft' | 'in_progress' | 'completed' | 'submitted' };
    const client = new CompositionScriptClient({ compiled: script.compiled, pageIds: composition.pages.map((candidate) => candidate.id), blockIds: composition.pages.flatMap((candidate) => candidate.blocks.map((block) => block.id)), dataBlockIds: composition.pages.flatMap((candidate) => candidate.blocks.filter((block) => block.type === 'data').map((block) => block.id)), status, onPageVisibility: (blockId, visible) => setHiddenPageIds((current) => { const next = new Set(current); visible ? next.delete(blockId) : next.add(blockId); return next; }), onBlockVisibility: (blockId, visible) => setHiddenBlockIds((current) => { const next = new Set(current); visible ? next.delete(blockId) : next.add(blockId); return next; }), onRefreshData: (blockId) => refreshData(blockId, true), onDataLoading: (blockId, loading) => setData((current) => ({ ...current, [blockId]: { ...current[blockId], loading } })), onNavigate: (target) => setPageIndex(composition.pages.findIndex((candidate) => candidate.id === target)), onNext: () => setPageIndex((current) => Math.min(composition.pages.length - 1, current + 1)), onPrevious: () => setPageIndex((current) => Math.max(0, current - 1)), onError: setNotice });
    scriptClient.current = client; return () => { client.destroy(); if (scriptClient.current === client) scriptClient.current = null; };
  }, [record, composition, contextReady, patientId, namespace, ehrId, mode]); // script gets a fresh, scoped patient context
  useEffect(() => { if (!composition || !page) return; scriptClient.current?.updateStatus({ currentPage: page.id, completedBlocks: session?.children.filter((child) => child.status === 'submitted').map((child) => child.blockId) || [], pendingBlocks: session?.children.filter((child) => child.status !== 'submitted').map((child) => child.blockId) || [], state: (session?.status === 'submitted' ? 'submitted' : session ? 'in_progress' : 'draft') }); }, [composition, page, session]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !isFormEmbedEvent(event.data) || !session) return;
      const blockId = event.data.launchId?.split(':')[1];
      if (event.data.event === 'submitted') {
        void refreshSession();
        if (blockId) setSaveOutcomes((current) => ({ ...current, [blockId]: { status: 'ok' } }));
        if (blockId) setDirtyBlocks((current) => { if (!current.has(blockId)) return current; const next = new Set(current); next.delete(blockId); return next; });
      }
      if (event.data.event === 'dirty' && blockId) {
        setDirtyBlocks((current) => {
          const has = current.has(blockId);
          if (event.data.dirty === has) return current;
          const next = new Set(current);
          event.data.dirty ? next.add(blockId) : next.delete(blockId);
          return next;
        });
      }
      if (event.data.event === 'loaded') void refreshSession();
      if (event.data.event === 'error' && event.data.message) {
        setNotice(event.data.message);
        // A failed child must not leave the progress panel stale - refresh
        // even though it's not a success, so the per-child status reflects
        // reality instead of whatever it was before the attempt.
        void refreshSession();
        if (blockId) setSaveOutcomes((current) => ({ ...current, [blockId]: { status: 'error', message: event.data.message } }));
      }
      if (event.data.event === 'resize' && event.data.height && blockId) setIframeHeights((current) => ({ ...current, [blockId]: event.data.height! }));
    };
    window.addEventListener('message', onMessage); return () => window.removeEventListener('message', onMessage);
  }, [session]);
  const validateAll = async () => { if (!session) { await startPage(); return; } setChecking(true); setNotice(''); try { const result = await request<{ session: CompositionSession; valid: boolean }> (`/composition-sessions/${encodeURIComponent(session.id)}/validate`, { method: 'POST' }); setSession(result.session); setNotice(result.valid ? 'Alle gestarteten Formulare sind valide. Nicht abgesendete Formulare können nun einzeln abgeschlossen werden.' : 'Es gibt noch fehlende oder ungültige Formulare. Die Details stehen in der Fortschrittsleiste.'); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Gesamtprüfung fehlgeschlagen.'); } finally { setChecking(false); } };
  // Replaces the old fire-and-forget broadcast (postMessage to every iframe
  // on the page, target '*', no acknowledgement) with a scoped, awaited-via-
  // embed-events send: only the composition's own mounted, not-yet-submitted
  // child iframes, addressed by real origin, tracked to a real per-block
  // result (see the onMessage handler above) instead of a passive guess.
  const saveAll = () => {
    if (!session) return;
    const targets = session.children.filter((child) => child.status !== 'submitted' && iframeRefs.current[child.blockId] && launches[child.blockId]?.url);
    if (targets.length === 0) return;
    setSaveOutcomes((current) => { const next = { ...current }; targets.forEach((child) => { next[child.blockId] = { status: 'pending' }; }); return next; });
    targets.forEach((child) => { iframeRefs.current[child.blockId]?.contentWindow?.postMessage({ type: 'EXTERNAL_FORM_SUBMIT' }, window.location.origin); });
  };
  const saveSummary = useMemo(() => {
    const entries = Object.values(saveOutcomes);
    if (entries.length === 0) return null;
    return { ok: entries.filter((entry) => entry.status === 'ok').length, err: entries.filter((entry) => entry.status === 'error').length, pending: entries.filter((entry) => entry.status === 'pending').length, total: entries.length };
  }, [saveOutcomes]);
  if (error && !record) return <div style={{ padding: '2rem', color: 'var(--danger)' }}>{error}</div>;
  if (!record || !composition || !page) return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Composition wird geladen…</div>;
  const complete = session?.progress.total === session?.progress.submitted && (session?.progress.total || 0) > 0;

  const renderBlock = (block: CompositionBlock) => (
    <div key={block.id} style={{ gridColumn: `span ${block.column || 1}` }}>
      {block.type === 'form' ? (
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '.85rem 1rem', display: 'flex', alignItems: 'center', gap: '.5rem', borderBottom: '1px solid var(--border)' }}>
            <FileText size={17} color="var(--primary)" />
            <strong>{block.title || 'Formular'}</strong>
            {childBadge(session?.children.find((child) => child.blockId === block.id)?.status)}
            <span style={{ marginLeft: 'auto', color: 'var(--text-muted)', fontSize: '.78rem' }}>Modus: {mode === 'create' ? 'Neu' : mode === 'edit' ? 'Bearbeiten' : mode === 'prefill' ? 'Vorausfüllen' : 'Ansehen'}</span>
          </div>
          {launches[block.id]?.loading && <div style={{ padding: '2rem', color: 'var(--text-muted)', textAlign: 'center' }}>Formular wird vorbereitet…</div>}
          {launches[block.id]?.error && <div style={{ padding: '1rem', color: 'var(--danger)' }}>{launches[block.id].error}</div>}
          {launches[block.id]?.url && <iframe ref={(node) => { iframeRefs.current[block.id] = node; }} title={block.title || block.id} src={launches[block.id].url} style={{ border: 0, width: '100%', height: block.displayMode === 'fixed' ? 720 : (iframeHeights[block.id] || 300), display: 'block', background: 'var(--bg-body)', transition: 'height .2s' }} scrolling={block.displayMode === 'fixed' ? 'auto' : 'no'} />}
        </section>
      ) : block.type === 'data' ? (
        <WidgetDataCard block={block} state={data[block.id]} />
      ) : (
        <section className="card"><strong>{block.title}</strong><p style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{block.content}</p></section>
      )}
    </div>
  );
  const renderPageGrid = (target: CompositionPage) => <ClinicalGrid columns={target.columns || 1}>{target.blocks.filter((block) => !hiddenBlockIds.has(block.id)).map(renderBlock)}</ClinicalGrid>;

  return <div style={{ maxWidth: 1280, margin: '0 auto', padding: '1.5rem' }}>
    <a href={returnUrl} onClick={(event) => { event.preventDefault(); guardedNavigate(() => navigate(returnUrl)); }} style={{ display: 'inline-flex', gap: '.4rem', alignItems: 'center', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '1rem', cursor: 'pointer' }}><ArrowLeft size={16} /> Zurück zur Patientenakte</a>
    <div className="card" style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
      <div><h1 style={{ margin: 0 }}>{record.name}</h1><p style={{ color: 'var(--text-muted)', marginBottom: 0 }}>Mehrere Formulare als ein fortsetzbarer klinischer Vorgang.</p></div>
      <div role="group" aria-label="Ansicht" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
        <button type="button" onClick={() => setViewMode('tabs')} title="Eine Seite nach der anderen, per Tab" style={{ display: 'flex', alignItems: 'center', gap: '.4rem', padding: '.5rem .8rem', border: 0, cursor: 'pointer', background: viewMode === 'tabs' ? 'var(--primary-light)' : 'var(--bg-card)', color: viewMode === 'tabs' ? 'var(--primary)' : 'var(--text-muted)', fontWeight: 600, fontSize: '.82rem' }}><LayoutGrid size={15} /> Tabs</button>
        <button type="button" onClick={() => setViewMode('stacked')} title="Alle Seiten untereinander" style={{ display: 'flex', alignItems: 'center', gap: '.4rem', padding: '.5rem .8rem', border: 0, borderLeft: '1px solid var(--border)', cursor: 'pointer', background: viewMode === 'stacked' ? 'var(--primary-light)' : 'var(--bg-card)', color: viewMode === 'stacked' ? 'var(--primary)' : 'var(--text-muted)', fontWeight: 600, fontSize: '.82rem' }}><Rows3 size={15} /> Gestapelt</button>
      </div>
    </div>
    <div className="card" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: '.75rem', alignItems: 'end', marginBottom: '1rem' }}><label className="form-label">Patient<select className="form-input" value={patients.find((item) => item.patientId === patientId)?.id || ''} onChange={(event) => { const selected = patients.find((item) => item.id === event.target.value); if (selected) { setPatientId(selected.patientId); setNamespace(selected.patientNamespace || selected.namespace || ''); setEhrId(selected.ehrId || ''); } else { setPatientId(''); setNamespace(''); setEhrId(''); } reset(); }}><option value="">Patient auswählen…</option>{patients.map((item) => <option key={item.id} value={item.id}>{[item.lastName, item.firstName].filter(Boolean).join(', ') || item.patientId} · {item.patientId}</option>)}</select><input className="form-input" style={{ marginTop: '.4rem' }} value={patientId} onChange={(event) => { setPatientId(event.target.value); reset(); }} placeholder="Patient-ID / EHR-ID" /></label><label className="form-label">Namespace<input className="form-input" value={namespace} onChange={(event) => { setNamespace(event.target.value); reset(); }} /></label><label className="form-label">EHR-ID (optional)<input className="form-input" value={ehrId} onChange={(event) => { setEhrId(event.target.value); reset(); }} /></label><label className="form-label">Modus<select className="form-input" value={mode} onChange={(event) => { setMode(event.target.value as Mode); reset(); }}><option value="create">Neu</option><option value="edit">Bearbeiten</option><option value="prefill">Vorausfüllen</option><option value="view">Ansehen</option></select></label><button className="btn" onClick={() => void startVisible()} disabled={!contextReady}><RefreshCw size={16} /> Öffnen</button></div>
    {session && <section className="card" style={{ marginBottom: '1rem', borderColor: complete ? 'var(--success)' : 'var(--primary-light)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <strong>Composition-Vorgang</strong>
          <div style={{ color: 'var(--text-muted)', fontSize: '.82rem', marginTop: '.2rem' }}>Entwurf wird automatisch über die Unterformular-Sessions fortgesetzt · {session.progress.started}/{session.progress.total} gestartet · {session.progress.ready}/{session.progress.total} geprüft · {session.progress.submitted}/{session.progress.total} abgesendet</div>
          {saveSummary && <div style={{ color: saveSummary.err ? 'var(--danger)' : saveSummary.pending ? 'var(--text-muted)' : '#15803d', fontSize: '.82rem', marginTop: '.3rem', fontWeight: 600 }}>{saveSummary.pending ? `Speichere… ${saveSummary.ok + saveSummary.err}/${saveSummary.total} fertig` : `${saveSummary.ok}/${saveSummary.total} gespeichert${saveSummary.err ? `, ${saveSummary.err} fehlgeschlagen` : ''}`}</div>}
        </div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <button className="btn btn-secondary" onClick={() => void validateAll()} disabled={checking}><CheckCircle2 size={16} /> {checking ? 'Prüft…' : 'Alle Formulare prüfen'}</button>
          <button className="btn btn-primary" onClick={saveAll}><CheckCircle2 size={16} /> Alle Speichern</button>
        </div>
      </div>
      <div style={{ height: 8, background: 'var(--border)', borderRadius: 99, overflow: 'hidden', margin: '.8rem 0' }}><div style={{ height: '100%', width: `${session.progress.total ? session.progress.submitted / session.progress.total * 100 : 0}%`, background: complete ? 'var(--success)' : 'var(--primary)', transition: 'width .2s' }} /></div>
      {session.children.filter((child) => child.status !== 'submitted').map((child) => <div key={child.blockId} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.8rem', padding: '.15rem 0' }}>{childBadge(child.status)}<span style={{ color: 'var(--text-muted)' }}>{child.formId}</span>{saveOutcomes[child.blockId]?.status === 'error' && <span style={{ color: 'var(--danger)' }}>· {saveOutcomes[child.blockId].message}</span>}</div>)}
      {complete && <div style={{ color: '#166534', fontWeight: 600, fontSize: '.85rem' }}>Der gesamte Composition-Vorgang ist abgeschlossen.</div>}
    </section>}
    {notice && <div className="card" style={{ marginBottom: '1rem', color: 'var(--primary)' }}>{notice}</div>}
    {!contextReady ? (
      <div className="card" style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>Wähle einen Patienten mit EHR-ID. Erst dann werden Formulare und klinische Daten als fortsetzbarer Vorgang geladen.</div>
    ) : viewMode === 'stacked' ? (
      <ClinicalStack sections={composition.pages.filter((candidate) => !hiddenPageIds.has(candidate.id)).map((candidate) => ({ id: candidate.id, title: candidate.title, description: candidate.description, content: renderPageGrid(candidate) }))} />
    ) : (
      <>
        <ClinicalTabs tabs={composition.pages.filter((candidate) => !hiddenPageIds.has(candidate.id)).map((candidate) => ({ id: candidate.id, label: candidate.title }))} activeId={page.id} onSelect={(pageId) => setPageIndex(composition.pages.findIndex((candidate) => candidate.id === pageId))} />
        {page.description && <p style={{ color: 'var(--text-muted)', margin: '0 0 1rem' }}>{page.description}</p>}
        {renderPageGrid(page)}
      </>
    )}
    {pendingNav && (
      <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
        <div style={{ background: 'var(--bg-card)', borderRadius: 10, padding: '1.5rem', maxWidth: 420, boxShadow: '0 10px 25px -5px rgba(0,0,0,0.2)' }}>
          <h3 style={{ marginTop: 0 }}>Ungespeicherte Änderungen</h3>
          <p style={{ color: 'var(--text-muted)' }}>Ein oder mehrere Formulare in diesem Vorgang haben nicht gespeicherte Änderungen. Der letzte automatisch gespeicherte Entwurf bleibt in jedem Fall erhalten. Wie möchten Sie fortfahren?</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', marginTop: '1rem' }}>
            <button className="btn btn-secondary" onClick={() => setPendingNav(null)}>Weiter bearbeiten</button>
            <button className="btn btn-primary" onClick={() => { saveAll(); setPendingNav(null); }}>Alle finalisieren und verlassen</button>
            <button className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => { const go = pendingNav; setPendingNav(null); go?.(); }}>Ohne Finalisieren verlassen</button>
          </div>
        </div>
      </div>
    )}
  </div>;
}
