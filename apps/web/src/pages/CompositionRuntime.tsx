import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useNavigate, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, CheckCircle2, FileText, LayoutGrid, Loader2, Maximize2, Minimize2, Plus, Rows3, RefreshCw, Save, X } from 'lucide-react';
import { COMPOSITION_SCRIPTING_EXTENSION_KEY, getCompositionDefinition, normalizeCompositionScript, summarizeRuntimeValues, type CompositionBlock, type CompositionDataBlock, type CompositionDefinition, type CompositionPage, type FormDefinitionV1, type RuntimeValues } from 'core';
import { formEmbedUrl, isFormEmbedEvent, launchEmbeddedForm } from '../integration/formLaunch';
import { ClinicalGrid, ClinicalStack, ClinicalTabs } from '../components/layout/ClinicalLayout';
import { CompositionScriptClient } from '../scripting/runtime/CompositionScriptClient';
import { WidgetDataCard, type WidgetDataState } from '../components/WidgetDataCard';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../App';
import { compositionDataCacheKey, loadCachedBlockData, mergeCachedRows, saveCachedBlockData } from '../integration/compositionDataCache';
import { API_BASE_URL } from '../integration/apiBaseUrl';

const API = API_BASE_URL;
type Mode = 'create' | 'edit' | 'view' | 'prefill';
type ViewMode = 'tabs' | 'stacked';
type FormRecord = { id: string; name: string; canonical_json: FormDefinitionV1 };
type Launch = { url?: string; error?: string; loading?: boolean };
type Child = { blockId: string; sessionId?: string; formId: string; status: string; valid?: boolean; issues?: Array<{ path: string; code: string; message: string }>; manualAdd?: boolean; instanceIndex?: number };
type CompositionSession = { id: string; patientId: string; patientNamespace?: string; ehrId?: string; mode: Mode; status: string; childSessions: Record<string, string>; childSessionGroups: Record<string, string[]>; children: Child[]; progress: { total: number; started: number; ready: number; submitted: number } };
type DataState = WidgetDataState;
type PatientOption = { id: string; patientId: string; patientNamespace?: string; namespace?: string; ehrId?: string | null; firstName?: string; lastName?: string };
type SaveOutcome = { status: 'pending' | 'ok' | 'error'; message?: string };
// Epic 4: one grouped save across the composition's child forms, via a real
// openEHR CONTRIBUTION - see clinicalTransactionService.ts. Deliberately
// never called "Contribution" in this UI (that term stays for developer/
// audit surfaces per the spec); this is just "Alle Änderungen speichern".
type ClinicalTransactionOp = { id: string; formSessionId: string; blockId?: string; type: string; status: string; resultVersionUid?: string; errorMessage?: string };
// atomic: true = landed as one real Contribution; false = the non-atomic
// sequential fallback ran instead (Composition requireAtomicCommit: false);
// absent while still committing. status 'partial' means the fallback ran
// and some, but not all, operations succeeded - never treated as success.
type ClinicalTransaction = { id: string; status: string; contributionUid?: string; atomic?: boolean; operations: ClinicalTransactionOp[]; errorCode?: string; errorMessage?: string };
class RequestError extends Error { messages?: Array<{ severity?: string; path?: string; message: string }>; }
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...options, credentials: 'include', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new RequestError(body.error || body.message || `Request failed (${response.status})`);
    if (Array.isArray(body.messages)) err.messages = body.messages;
    throw err;
  }
  return body as T;
}

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

// Optional overrides for every bit of context this component would
// otherwise read from its own route (`useParams`) or query string
// (`useSearchParams`) - set when it's mounted directly as embedded content
// inside another page (e.g. the Klinisches-Cockpit tab in PatientDetail)
// instead of being routed to on its own. Passing these bypasses
// useParams()/useSearchParams() entirely for the fields they cover, which
// matters because an embedding host's own route/query string (e.g.
// PatientDetail's `/patients/:id`) is not this component's - reading them
// directly would pick up the host's `id` param, not a composition form id.
interface CompositionRuntimeProps {
  formId?: string;
  initialPatientId?: string;
  initialNamespace?: string;
  initialEhrId?: string;
  initialMode?: Mode;
  embedded?: boolean;
}

export default function CompositionRuntime(props: CompositionRuntimeProps = {}) {
  const { id: routeId } = useParams(); const [searchParams] = useSearchParams(); const navigate = useNavigate();
  const id = props.formId ?? routeId;
  // Only used to scope the client-side composition-data cache per user (see
  // compositionDataCache.ts) - a shared browser profile used by more than
  // one clinician must never surface one user's cached clinical data to
  // another.
  const auth = useAuth();
  const [record, setRecord] = useState<FormRecord | null>(null); const [composition, setComposition] = useState<CompositionDefinition | null>(null); const [session, setSession] = useState<CompositionSession | null>(null);
  useDocumentTitle(record?.name || 'Form-Vorgang', { skip: props.embedded });
  const [pageIndex, setPageIndex] = useState(0); const [patientId, setPatientId] = useState(props.initialPatientId ?? searchParams.get('patientId') ?? ''); const [namespace, setNamespace] = useState(props.initialNamespace ?? searchParams.get('patientNamespace') ?? ''); const [ehrId, setEhrId] = useState(props.initialEhrId ?? searchParams.get('ehrId') ?? ''); const [mode, setMode] = useState<Mode>(() => { if (props.initialMode) return props.initialMode; const requested = searchParams.get('mode'); return requested === 'edit' || requested === 'view' || requested === 'prefill' ? requested : 'create'; });
  const [launches, setLaunches] = useState<Record<string, Launch>>({}); const [data, setData] = useState<Record<string, DataState>>({}); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [checking, setChecking] = useState(false);
  const [patients, setPatients] = useState<PatientOption[]>([]);
  const [iframeHeights, setIframeHeights] = useState<Record<string, number>>({});
  const [hiddenPageIds, setHiddenPageIds] = useState<Set<string>>(() => new Set()); const [hiddenBlockIds, setHiddenBlockIds] = useState<Set<string>>(() => new Set()); const scriptClient = useRef<CompositionScriptClient | null>(null);
  const [viewMode, setViewModeState] = useState<ViewMode>('tabs');
  const [saveOutcomes, setSaveOutcomes] = useState<Record<string, SaveOutcome>>({});
  // Patient/EHR context handed in via the URL (the real "live" launch case,
  // same signal LiveForm.tsx already treats as pre-supplied) hides the
  // manual patient-picker entirely - captured once at mount, not
  // re-evaluated as the user later edits patientId/ehrId by hand below.
  const [suppliedContext] = useState(() => Boolean((props.initialPatientId ?? searchParams.get('patientId'))?.trim() && (props.initialEhrId ?? searchParams.get('ehrId'))?.trim()));
  const [transaction, setTransaction] = useState<ClinicalTransaction | null>(null);
  const [committing, setCommitting] = useState(false);
  const [transactionError, setTransactionError] = useState('');
  // A stable id for this save attempt - reused across retries of the SAME
  // attempt so a duplicate click/timeout-retry can never produce a second
  // Contribution (prepareClinicalTransaction is idempotent on this id), but
  // regenerated once a save actually succeeds or the session itself resets,
  // so a genuinely new save is never mistaken for a retry of an old one.
  const transactionClientId = useRef<string>(crypto.randomUUID());
  const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});
  const returnUrl = useMemo(() => {
    const requested = searchParams.get('returnUrl');
    return requested && requested.startsWith('/') && !requested.startsWith('//') ? requested : '/';
  }, [searchParams]);
  // Set when this runtime is embedded inline as a tab of PatientDetail
  // (rather than visited as its own page) - drops the page-level chrome
  // ("Zurück zur Patientenakte", outer padding/max-width) that would
  // otherwise be redundant nested inside a host page that already has its
  // own back navigation and layout.
  const embedded = props.embedded ?? searchParams.get('embedded') === '1';
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

  // Compact/full toggle per Form Section block - "hin und her switchen"
  // between the full embedded iframe and a dense one-line read summary, so
  // a page with several instances of the same Form Section (e.g. Haupt- +
  // mehrere Nebendiagnosen) doesn't force scrolling through every field of
  // every one just to see which is which. A per-browser display
  // preference, like viewMode - not clinical data, so localStorage (keyed
  // per Composition) is the right home, not the session.
  const [compactBlocks, setCompactBlocksState] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!id) return;
    try { setCompactBlocksState(new Set(JSON.parse(localStorage.getItem(`compositionCompactBlocks:${id}`) || '[]'))); } catch { setCompactBlocksState(new Set()); }
  }, [id]);
  const toggleCompact = (blockId: string) => {
    setCompactBlocksState((current) => {
      const next = new Set(current);
      next.has(blockId) ? next.delete(blockId) : next.add(blockId);
      if (id) localStorage.setItem(`compositionCompactBlocks:${id}`, JSON.stringify(Array.from(next)));
      return next;
    });
  };
  // The compact summary needs two things the parent frame doesn't normally
  // have: the child Form Section's own definition (for field labels/
  // summaryFieldIds) and the child session's current values (the iframe
  // owns those, not this page) - both fetched lazily, only for blocks
  // actually switched to compact, and refreshed whenever the composition
  // session changes (a save/load/submit in the iframe) so the summary never
  // shows stale values.
  const [childForms, setChildForms] = useState<Record<string, FormRecord>>({});
  const [childValues, setChildValues] = useState<Record<string, RuntimeValues>>({});
  useEffect(() => {
    if (!session || !composition || compactBlocks.size === 0) return;
    const formBlocks = composition.pages.flatMap((candidate) => candidate.blocks).filter((block): block is Extract<CompositionBlock, { type: 'form' }> => block.type === 'form');
    compactBlocks.forEach((blockId) => {
      const block = formBlocks.find((candidate) => candidate.id === blockId);
      const childSessionId = session.childSessions[blockId];
      if (!block || !childSessionId) return;
      if (!childForms[block.formId]) void request<FormRecord>(`/forms/${encodeURIComponent(block.formId)}`).then((record) => setChildForms((current) => ({ ...current, [block.formId]: record }))).catch(() => {});
      void request<{ values: RuntimeValues }>(`/form-sessions/${encodeURIComponent(childSessionId)}`).then((record) => setChildValues((current) => ({ ...current, [blockId]: record.values || {} }))).catch(() => {});
    });
  }, [compactBlocks, session, composition]); // eslint-disable-line react-hooks/exhaustive-deps

  const page = composition?.pages[pageIndex]; const contextReady = patientId.trim().length > 0 && ehrId.trim().length > 0;
  const reset = () => { setSession(null); setLaunches({}); setData({}); setNotice(''); setSaveOutcomes({}); setTransaction(null); setTransactionError(''); transactionClientId.current = crypto.randomUUID(); iframeRefs.current = {}; };
  const refreshSession = async (sessionId = session?.id) => { if (!sessionId) return; const next = await request<CompositionSession>(`/composition-sessions/${encodeURIComponent(sessionId)}`); setSession(next); return next; };
  const ensureSession = async (): Promise<CompositionSession | undefined> => {
    if (!record || !contextReady) return undefined;
    if (session && session.patientId === patientId.trim() && session.mode === mode) return session;
    const forceNew = searchParams.get('forceNew') === 'true';
    const next = await request<CompositionSession>('/composition-sessions', { method: 'POST', body: JSON.stringify({ compositionFormId: record.id, patientId: patientId.trim(), patientNamespace: namespace.trim() || undefined, ehrId: ehrId.trim() || undefined, mode, forceNew }) });
    setSession(next); return next;
  };
  // `force` (an explicit "Aktualisieren"-style refresh, e.g. the
  // Medikationssicherheit page's onPageVisibility-triggered data.refresh())
  // bypasses the cache entirely rather than just sending it along as
  // `since` - a corrected value sharing its original entry's timeColumn
  // would otherwise never surface until the cache's own 24h safety-net
  // expiry, since the incremental path can only ever learn about rows
  // strictly newer than what it already has, never revisions of rows it
  // already cached. Every other load (mount, page switch, script-driven
  // non-forced refresh) takes the fast incremental path.
  const refreshData = (onlyBlockId?: string, force = false) => {
    if (!record || !composition || !contextReady) return;
    const blocks = composition.pages.flatMap((candidate) => candidate.blocks).filter((block): block is CompositionDataBlock => block.type === 'data' && (!onlyBlockId || block.id === onlyBlockId));
    for (const block of blocks) {
      if (!force && (data[block.id]?.loading || data[block.id]?.rows)) continue;
      const cacheKey = compositionDataCacheKey({ userId: auth.user?.id || 'anonymous', formId: record.id, blockId: block.id, patientId: patientId.trim(), ehrId: ehrId.trim() || undefined });
      const cached = force ? undefined : loadCachedBlockData(cacheKey);
      setData((current) => ({ ...current, [block.id]: cached ? { rows: cached.rows } : { loading: true } }));
      void request<{ rows: Record<string, unknown>[]; cachedThrough?: number }>(`/forms/${encodeURIComponent(record.id)}/composition-data`, { method: 'POST', body: JSON.stringify({ blockId: block.id, patient: { id: patientId.trim(), ...(namespace.trim() ? { namespace: namespace.trim() } : {}) }, ehrId: ehrId.trim() || undefined, ...(cached?.cachedThrough !== undefined ? { since: cached.cachedThrough } : {}) }) })
        .then((result) => {
          const rows = cached ? mergeCachedRows(cached.rows, result.rows) : result.rows;
          const cachedThrough = result.cachedThrough ?? cached?.cachedThrough;
          saveCachedBlockData(cacheKey, { rows, cachedThrough });
          setData((current) => ({ ...current, [block.id]: { rows } }));
        })
        .catch((reason) => setData((current) => ({ ...current, [block.id]: { error: reason instanceof Error ? reason.message : 'Daten konnten nicht geladen werden.', rows: cached?.rows } })));
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
      // Each block's launch+attach is independent of every other block's -
      // they each target their own slot on the same parent composition
      // session, and the backend already handles concurrent attaches
      // safely (optimistic concurrency with a retry-once on conflict, see
      // attachCompositionChild). Launching them in parallel instead of one
      // at a time turns a page's load time from N sequential round-trips
      // into roughly one - this used to be the dominant cost on
      // Compositions with several blocks per page (e.g. Polytrauma -
      // Intensivstation's 5-block "Organfunktion & Labor" tab).
      await Promise.all(blocks.map(async (block) => {
        if (block.type !== 'form' || !block.formId) return;
        if (block.manualAdd) {
          // manualAdd blocks are never auto-created - only the "+" button
          // (addManualInstance) attaches a new instance. On (re)load,
          // resume-mount every instance that already exists so a page
          // revisit doesn't lose previously added Diagnose/Befund entries.
          (parent.childSessionGroups[block.id] || []).forEach((instanceSessionId) => {
            const key = `${block.id}:${instanceSessionId}`;
            if (launches[key]?.url || launches[key]?.loading) return;
            const resumeQuery = new URLSearchParams({ sessionId: instanceSessionId, launchId: `${parent.id}:${block.id}:${instanceSessionId}` });
            if (block.hiddenFieldIds?.length) resumeQuery.set('hiddenFieldIds', block.hiddenFieldIds.join(','));
            if (block.fieldLabelOverrides && Object.keys(block.fieldLabelOverrides).length > 0) resumeQuery.set('fieldLabelOverrides', JSON.stringify(block.fieldLabelOverrides));
            setLaunches((current) => ({ ...current, [key]: { url: formEmbedUrl(`/embed/forms/${encodeURIComponent(block.formId)}?${resumeQuery.toString()}`) } }));
          });
          return;
        }
        if (launches[block.id]?.url || launches[block.id]?.loading) return;
        const childSessionId = parent.childSessions[block.id];
        if (childSessionId) {
          // Resuming an already-attached block bypasses launchEmbeddedForm
          // (no new session to create) - but the host-level per-instance
          // overrides below still have to reach the iframe by hand here,
          // exactly like the fresh-launch branch below does via
          // formLaunchService, or a resumed block would silently render
          // with its bare Form Section defaults on every page reload.
          const resumeQuery = new URLSearchParams({ sessionId: childSessionId, launchId: `${parent.id}:${block.id}` });
          if (block.hiddenFieldIds?.length) resumeQuery.set('hiddenFieldIds', block.hiddenFieldIds.join(','));
          if (block.fieldLabelOverrides && Object.keys(block.fieldLabelOverrides).length > 0) resumeQuery.set('fieldLabelOverrides', JSON.stringify(block.fieldLabelOverrides));
          setLaunches((current) => ({ ...current, [block.id]: { url: formEmbedUrl(`/embed/forms/${encodeURIComponent(block.formId)}?${resumeQuery.toString()}`) } }));
          return;
        }
        setLaunches((current) => ({ ...current, [block.id]: { loading: true } }));
        try {
          const blockLoad = block.load || (mode === 'create' ? 'never' : 'provider');
          const blockMode = mode === 'create' && blockLoad === 'provider' ? 'prefill' : mode;
          // compositionContext proves to the server this Form Section
          // launch is a legitimate block of an already-started Composition
          // session, not a standalone launch - Form Sections can't be
          // launched on their own for a patient (see formSessionService's
          // assertFormSectionLaunchAllowed).
          const launch = await launchEmbeddedForm({ formId: block.formId, patient: { id: patientId.trim(), ...(namespace.trim() ? { namespace: namespace.trim() } : {}) }, mode: blockMode, load: blockLoad, hiddenFieldIds: block.hiddenFieldIds, fieldLabelOverrides: block.fieldLabelOverrides, launchId: `${parent.id}:${block.id}`, compositionContext: { compositionSessionId: parent.id, blockId: block.id } });
          // Not applying this call's own returned session snapshot here:
          // when several blocks attach concurrently, whichever PUT resolves
          // last on the client doesn't necessarily reflect every other
          // block's attachment yet (each response is a snapshot as of its
          // own server-side commit) - setSession(attached) here would risk
          // clobbering a sibling block's just-attached state with a stale
          // one. A single refreshSession() after all blocks have settled
          // (below) is the correct, race-free source of truth.
          await request<CompositionSession>(`/composition-sessions/${encodeURIComponent(parent.id)}/blocks/${encodeURIComponent(block.id)}`, { method: 'PUT', body: JSON.stringify({ childSessionId: launch.session.id }) });
          setLaunches((current) => ({ ...current, [block.id]: { url: formEmbedUrl(launch.launchUrl) } }));
        } catch (reason) { setLaunches((current) => ({ ...current, [block.id]: { error: reason instanceof Error ? reason.message : 'Formular konnte nicht gestartet werden.' } })); }
      }));
      await refreshSession(parent.id);
      refreshData();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Form-Vorgang konnte nicht gestartet werden.'); }
  };
  const startPage = () => (page ? startBlocks(page.blocks) : Promise.resolve());
  const startVisible = () => startBlocks(viewMode === 'stacked' ? (composition?.pages || []).filter((candidate) => !hiddenPageIds.has(candidate.id)).flatMap((candidate) => candidate.blocks) : (page?.blocks || []));
  // "+ <Titel> hinzufügen" - creates one more independent instance of a
  // manualAdd block. Mirrors startBlocks' own fresh-launch branch (same
  // launchEmbeddedForm call) but attaches via POST .../instances, which
  // appends rather than overwrites, so previously added instances are
  // never disturbed.
  const [addingInstance, setAddingInstance] = useState<Record<string, boolean>>({});
  const addManualInstance = async (block: Extract<CompositionBlock, { type: 'form' }>) => {
    if (!contextReady || !record || addingInstance[block.id]) return;
    setAddingInstance((current) => ({ ...current, [block.id]: true }));
    try {
      const parent = await ensureSession(); if (!parent) return;
      const blockLoad = block.load || (mode === 'create' ? 'never' : 'provider');
      const blockMode = mode === 'create' && blockLoad === 'provider' ? 'prefill' : mode;
      const launch = await launchEmbeddedForm({ formId: block.formId, patient: { id: patientId.trim(), ...(namespace.trim() ? { namespace: namespace.trim() } : {}) }, mode: blockMode, load: blockLoad, hiddenFieldIds: block.hiddenFieldIds, fieldLabelOverrides: block.fieldLabelOverrides, launchId: `${parent.id}:${block.id}:${crypto.randomUUID()}`, compositionContext: { compositionSessionId: parent.id, blockId: block.id } });
      await request<CompositionSession>(`/composition-sessions/${encodeURIComponent(parent.id)}/blocks/${encodeURIComponent(block.id)}/instances`, { method: 'POST', body: JSON.stringify({ childSessionId: launch.session.id }) });
      setLaunches((current) => ({ ...current, [`${block.id}:${launch.session.id}`]: { url: formEmbedUrl(launch.launchUrl) } }));
      await refreshSession(parent.id);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Ein weiterer Eintrag konnte nicht hinzugefügt werden.');
    } finally {
      setAddingInstance((current) => ({ ...current, [block.id]: false }));
    }
  };
  const [removingInstance, setRemovingInstance] = useState<Record<string, boolean>>({});
  const removeManualInstance = async (blockId: string, childSessionId: string) => {
    if (!session || removingInstance[childSessionId]) return;
    setRemovingInstance((current) => ({ ...current, [childSessionId]: true }));
    try {
      await request<CompositionSession>(`/composition-sessions/${encodeURIComponent(session.id)}/blocks/${encodeURIComponent(blockId)}/instances/${encodeURIComponent(childSessionId)}`, { method: 'DELETE' });
      setLaunches((current) => { const next = { ...current }; delete next[`${blockId}:${childSessionId}`]; return next; });
      await refreshSession();
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : 'Eintrag konnte nicht entfernt werden.');
    } finally {
      setRemovingInstance((current) => ({ ...current, [childSessionId]: false }));
    }
  };
  useEffect(() => { void startVisible(); }, [pageIndex, composition, patientId, namespace, ehrId, mode, viewMode]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!record || !composition || !contextReady) return;
    const script = normalizeCompositionScript(record.canonical_json.extensions?.[COMPOSITION_SCRIPTING_EXTENSION_KEY], composition);
    if (!script.compiled) return;
    setHiddenPageIds(new Set()); setHiddenBlockIds(new Set());
    const status = { currentPage: composition.pages[pageIndex]?.id || composition.pages[0].id, completedBlocks: session?.children.filter((child) => child.status === 'submitted').map((child) => child.blockId) || [], pendingBlocks: session?.children.filter((child) => child.status !== 'submitted').map((child) => child.blockId) || [], state: (session?.status === 'submitted' ? 'submitted' : session ? 'in_progress' : 'draft') as 'draft' | 'in_progress' | 'completed' | 'submitted' };
    const client = new CompositionScriptClient({ compiled: script.compiled, pageIds: composition.pages.map((candidate) => candidate.id), blockIds: composition.pages.flatMap((candidate) => candidate.blocks.map((block) => block.id)), dataBlockIds: composition.pages.flatMap((candidate) => candidate.blocks.filter((block) => block.type === 'data').map((block) => block.id)), status, onPageVisibility: (blockId, visible) => setHiddenPageIds((current) => { const next = new Set(current); visible ? next.delete(blockId) : next.add(blockId); return next; }), onBlockVisibility: (blockId, visible) => setHiddenBlockIds((current) => { const next = new Set(current); visible ? next.delete(blockId) : next.add(blockId); return next; }), onRefreshData: (blockId) => refreshData(blockId, true), onDataLoading: (blockId, loading) => setData((current) => ({ ...current, [blockId]: { ...current[blockId], loading } })), onNavigate: (target) => setPageIndex(composition.pages.findIndex((candidate) => candidate.id === target)), onNext: () => setPageIndex((current) => Math.min(composition.pages.length - 1, current + 1)), onPrevious: () => setPageIndex((current) => Math.max(0, current - 1)), onError: setNotice,
      // forms.field(blockId, fieldName).setValue(value) - a trusted,
      // explicit escape hatch (e.g. "Vorbefund übernehmen" from a
      // data.onPick handler). Posted straight into that block's own form
      // iframe, same-origin, mirroring the existing EXTERNAL_FORM_SUBMIT
      // ad-hoc message convention rather than the versioned iframe->host
      // FormEmbedEvent protocol (this direction is host->iframe).
      onSetFormField: (blockId, fieldName, value) => { iframeRefs.current[blockId]?.contentWindow?.postMessage({ type: 'COMPOSITION_SET_FIELD', fieldName, value }, window.location.origin); } });
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
  // Epic 4: replaces the old fire-and-forget broadcast (postMessage telling
  // every child iframe to independently submit itself - exactly the
  // per-form-saves-independently pattern the grouped save is meant to
  // replace) with one real openEHR CONTRIBUTION covering every child form
  // together. prepare re-validates server-side (never trusts stale local
  // status) and reports exactly which child form is the problem if not
  // everything is ready yet; commit actually saves. Each child form is
  // still independently usable on its own (its own autosave/submit inside
  // the iframe is untouched) - this is only the composition-level action.
  const commitTransaction = async (): Promise<boolean> => {
    if (!session) return false;
    setTransactionError(''); setCommitting(true);
    try {
      const prepared = await request<ClinicalTransaction>(`/composition-sessions/${encodeURIComponent(session.id)}/transaction`, { method: 'POST', body: JSON.stringify({ description: record?.name, clientRequestId: transactionClientId.current }) });
      setTransaction(prepared);
      const committed = await request<ClinicalTransaction>(`/composition-sessions/transaction/${encodeURIComponent(prepared.id)}/commit`, { method: 'POST' });
      setTransaction(committed);
      await refreshSession();
      if (committed.status === 'committed') {
        // This attempt genuinely succeeded - a future save is a new
        // attempt, not a retry of this one.
        transactionClientId.current = crypto.randomUUID();
        setNotice(`${committed.operations.length} Dokumente wurden gemeinsam gespeichert.${committed.atomic === false ? ' (nacheinander, nicht als eine gemeinsame Contribution)' : ''}`);
        return true;
      }
      // 'partial' (non-atomic fallback: some operations failed) or 'failed'
      // - never reported as success. Keep the same clientRequestId so a
      // retry re-prepares fresh operations for whatever didn't succeed
      // (prepareClinicalTransaction clears a partial/failed transaction
      // under the same id rather than reusing it untouched).
      const committedCount = committed.operations.filter((op) => op.status === 'committed').length;
      setTransactionError(committed.status === 'partial'
        ? `Nur ${committedCount}/${committed.operations.length} Dokumente konnten gespeichert werden - Details unten. Erneut speichern versucht die restlichen.`
        : (committed.errorMessage || 'Keines der Dokumente konnte gespeichert werden.'));
      return false;
    } catch (reason) {
      const err = reason instanceof RequestError ? reason : undefined;
      setTransactionError(err?.messages?.length ? err.messages.map((item) => item.message).join(' · ') : (reason instanceof Error ? reason.message : 'Speichern fehlgeschlagen.'));
      return false;
    } finally {
      setCommitting(false);
    }
  };
  const transactionSummary = useMemo(() => {
    if (!transaction) return null;
    const committed = transaction.operations.filter((op) => op.status === 'committed').length;
    const failed = transaction.operations.filter((op) => op.status === 'failed' || op.status === 'conflict').length;
    return { total: transaction.operations.length, committed, failed, done: transaction.status === 'committed' };
  }, [transaction]);
  if (error && !record) return <div style={{ padding: '2rem', color: 'var(--danger)' }}>{error}</div>;
  if (!record || !composition || !page) return <div style={{ padding: '2rem', color: 'var(--text-muted)' }}>Form wird geladen…</div>;
  const complete = session?.progress.total === session?.progress.submitted && (session?.progress.total || 0) > 0;

  const renderBlock = (block: CompositionBlock) => {
    const isCompact = block.type === 'form' && compactBlocks.has(block.id);
    const compactForm = block.type === 'form' ? childForms[block.formId] : undefined;
    const compactValues = block.type === 'form' ? childValues[block.id] : undefined;
    const compactSummary = compactForm && compactValues
      ? summarizeRuntimeValues(compactForm.canonical_json, compactValues, compactForm.canonical_json.settings?.reuse?.summaryFieldIds)
      : '';
    if (block.type === 'form' && block.manualAdd) {
      const instances = session?.children.filter((child) => child.blockId === block.id && child.sessionId) || [];
      const outstandingRequired = block.requireAtLeastOne && instances.length === 0;
      return (
        <div key={block.id} style={{ gridColumn: `span ${block.column || 1}` }}>
          <section className="card" style={{ padding: '.85rem 1rem', display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
              <FileText size={17} color="var(--primary)" />
              <strong>{block.title || 'Formular'}</strong>
              <span style={{ color: 'var(--text-muted)', fontSize: '.78rem' }}>{instances.length === 0 ? 'Noch kein Eintrag' : `${instances.length} Eintrag${instances.length === 1 ? '' : 'e'}`}{outstandingRequired && <span style={{ color: 'var(--danger)', marginLeft: '.4rem' }}>· mindestens 1 erforderlich</span>}</span>
            </div>
            {instances.map((child, index) => {
              const key = `${block.id}:${child.sessionId}`;
              const removable = child.status !== 'submitted';
              return (
                <div key={child.sessionId} className="card" style={{ padding: 0, overflow: 'hidden', borderColor: 'var(--border)' }}>
                  <div style={{ padding: '.6rem .85rem', display: 'flex', alignItems: 'center', gap: '.5rem', borderBottom: '1px solid var(--border)' }}>
                    <strong style={{ fontSize: '.85rem' }}>{block.title || 'Eintrag'} #{child.instanceIndex ?? index + 1}</strong>
                    {childBadge(child.status)}
                    <button type="button" title={removable ? 'Eintrag entfernen' : 'Bereits abgesendete Einträge können nicht entfernt werden'} disabled={!removable || removingInstance[child.sessionId!]} onClick={() => void removeManualInstance(block.id, child.sessionId!)} style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: removable ? 'var(--danger)' : 'var(--text-muted)', cursor: removable ? 'pointer' : 'not-allowed', padding: '.3rem', opacity: removable ? 1 : .5 }}>
                      <X size={14} />
                    </button>
                  </div>
                  {launches[key]?.loading && <div style={{ padding: '2rem', color: 'var(--text-muted)', textAlign: 'center' }}>Formular wird vorbereitet…</div>}
                  {launches[key]?.error && <div style={{ padding: '1rem', color: 'var(--danger)' }}>{launches[key].error}</div>}
                  {launches[key]?.url && <iframe ref={(node) => { iframeRefs.current[key] = node; }} title={`${block.title || block.id} #${index + 1}`} src={launches[key].url} style={{ border: 0, width: '100%', height: iframeHeights[key] || 300, display: 'block', background: 'var(--bg-body)', transition: 'height .2s' }} scrolling="no" />}
                </div>
              );
            })}
            <button type="button" className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} disabled={addingInstance[block.id]} onClick={() => void addManualInstance(block)}>
              {addingInstance[block.id] ? <Loader2 size={15} className="lf-spin" /> : <Plus size={15} />} {block.title || 'Eintrag'} hinzufügen
            </button>
          </section>
        </div>
      );
    }
    return (
    <div key={block.id} style={{ gridColumn: `span ${block.column || 1}` }}>
      {block.type === 'form' ? (
        <section className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '.85rem 1rem', display: 'flex', alignItems: 'center', gap: '.5rem', borderBottom: '1px solid var(--border)' }}>
            <FileText size={17} color="var(--primary)" />
            <strong>{block.title || 'Formular'}</strong>
            {childBadge(session?.children.find((child) => child.blockId === block.id)?.status)}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '.6rem' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: '.78rem' }}>Modus: {mode === 'create' ? 'Neu' : mode === 'edit' ? 'Bearbeiten' : mode === 'prefill' ? 'Vorausfüllen' : 'Ansehen'}</span>
              <button type="button" onClick={() => toggleCompact(block.id)} title={isCompact ? 'Vollständig anzeigen' : 'Kompakt anzeigen'} style={{ display: 'flex', alignItems: 'center', border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: '.3rem' }}>
                {isCompact ? <Maximize2 size={14} /> : <Minimize2 size={14} />}
              </button>
            </div>
          </div>
          {isCompact && (
            <div style={{ padding: '1rem 1.1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
              <span style={{ color: compactSummary ? 'var(--text-body, inherit)' : 'var(--text-muted)', fontSize: '.95rem', lineHeight: 1.5 }}>{compactSummary || (compactForm ? 'Noch keine Angaben.' : 'Lädt…')}</span>
              <button type="button" className="btn btn-secondary" style={{ flexShrink: 0, fontSize: '.8rem', padding: '.4rem .8rem' }} onClick={() => toggleCompact(block.id)}>Bearbeiten</button>
            </div>
          )}
          {/* Kept mounted (only visually hidden) rather than unmounted while
              compact - the iframe's own unsaved edits would otherwise be
              lost the instant someone toggles to compact mid-edit. */}
          <div style={{ display: isCompact ? 'none' : 'block' }}>
            {launches[block.id]?.loading && <div style={{ padding: '2rem', color: 'var(--text-muted)', textAlign: 'center' }}>Formular wird vorbereitet…</div>}
            {launches[block.id]?.error && <div style={{ padding: '1rem', color: 'var(--danger)' }}>{launches[block.id].error}</div>}
            {launches[block.id]?.url && <iframe ref={(node) => { iframeRefs.current[block.id] = node; }} title={block.title || block.id} src={launches[block.id].url} style={{ border: 0, width: '100%', height: block.displayMode === 'fixed' ? 720 : (iframeHeights[block.id] || 300), display: 'block', background: 'var(--bg-body)', transition: 'height .2s' }} scrolling={block.displayMode === 'fixed' ? 'auto' : 'no'} />}
          </div>
        </section>
      ) : block.type === 'data' ? (
        <WidgetDataCard block={block} state={data[block.id]} onPick={(row) => scriptClient.current?.pickData(block.id, row)} />
      ) : (
        <section className="card"><strong>{block.title}</strong><p style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{block.content}</p></section>
      )}
    </div>
    );
  };
  const renderPageGrid = (target: CompositionPage) => <ClinicalGrid columns={target.columns || 1}>{target.blocks.filter((block) => !hiddenBlockIds.has(block.id)).map(renderBlock)}</ClinicalGrid>;

  return <div style={{ maxWidth: embedded ? '100%' : 1280, margin: '0 auto', padding: embedded ? 0 : '1.5rem' }}>
    {!embedded && <a href={returnUrl} onClick={(event) => { event.preventDefault(); guardedNavigate(() => navigate(returnUrl)); }} style={{ display: 'inline-flex', gap: '.4rem', alignItems: 'center', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '1rem', cursor: 'pointer' }}><ArrowLeft size={16} /> Zurück zur Patientenakte</a>}
    <div className="card" style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
      <div><h1 style={{ margin: 0 }}>{record.name}</h1><p style={{ color: 'var(--text-muted)', marginBottom: 0 }}>Mehrere Formulare als ein fortsetzbarer klinischer Vorgang.</p></div>
      <div role="group" aria-label="Ansicht" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
        <button type="button" onClick={() => setViewMode('tabs')} title="Eine Seite nach der anderen, per Tab" style={{ display: 'flex', alignItems: 'center', gap: '.4rem', padding: '.5rem .8rem', border: 0, cursor: 'pointer', background: viewMode === 'tabs' ? 'var(--primary-light)' : 'var(--bg-card)', color: viewMode === 'tabs' ? 'var(--primary)' : 'var(--text-muted)', fontWeight: 600, fontSize: '.82rem' }}><LayoutGrid size={15} /> Tabs</button>
        <button type="button" onClick={() => setViewMode('stacked')} title="Alle Seiten untereinander" style={{ display: 'flex', alignItems: 'center', gap: '.4rem', padding: '.5rem .8rem', border: 0, borderLeft: '1px solid var(--border)', cursor: 'pointer', background: viewMode === 'stacked' ? 'var(--primary-light)' : 'var(--bg-card)', color: viewMode === 'stacked' ? 'var(--primary)' : 'var(--text-muted)', fontWeight: 600, fontSize: '.82rem' }}><Rows3 size={15} /> Gestapelt</button>
      </div>
    </div>
    {suppliedContext ? (
      <div className="card" style={{ display: 'flex', alignItems: 'center', gap: '.75rem', marginBottom: '1rem', color: 'var(--text-muted)', fontSize: '.85rem' }}>
        <span>Patient: <strong style={{ color: 'var(--text-body, inherit)' }}>{[patients.find((item) => item.patientId === patientId)?.lastName, patients.find((item) => item.patientId === patientId)?.firstName].filter(Boolean).join(', ') || patientId}</strong></span>
        <span>· Modus: {mode === 'create' ? 'Neu' : mode === 'edit' ? 'Bearbeiten' : mode === 'prefill' ? 'Vorausfüllen' : 'Ansehen'}</span>
      </div>
    ) : (
      <div className="card" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr auto', gap: '.75rem', alignItems: 'end', marginBottom: '1rem' }}><label className="form-label">Patient<select className="form-input" value={patients.find((item) => item.patientId === patientId)?.id || ''} onChange={(event) => { const selected = patients.find((item) => item.id === event.target.value); if (selected) { setPatientId(selected.patientId); setNamespace(selected.patientNamespace || selected.namespace || ''); setEhrId(selected.ehrId || ''); } else { setPatientId(''); setNamespace(''); setEhrId(''); } reset(); }}><option value="">Patient auswählen…</option>{patients.map((item) => <option key={item.id} value={item.id}>{[item.lastName, item.firstName].filter(Boolean).join(', ') || item.patientId} · {item.patientId}</option>)}</select><input className="form-input" style={{ marginTop: '.4rem' }} value={patientId} onChange={(event) => { setPatientId(event.target.value); reset(); }} placeholder="Patient-ID / EHR-ID" /></label><label className="form-label">Namespace<input className="form-input" value={namespace} onChange={(event) => { setNamespace(event.target.value); reset(); }} /></label><label className="form-label">EHR-ID (optional)<input className="form-input" value={ehrId} onChange={(event) => { setEhrId(event.target.value); reset(); }} /></label><label className="form-label">Modus<select className="form-input" value={mode} onChange={(event) => { setMode(event.target.value as Mode); reset(); }}><option value="create">Neu</option><option value="edit">Bearbeiten</option><option value="prefill">Vorausfüllen</option><option value="view">Ansehen</option></select></label><button className="btn" onClick={() => void startVisible()} disabled={!contextReady}><RefreshCw size={16} /> Öffnen</button></div>
    )}
    {session && <section className="card" style={{ marginBottom: '1rem', borderColor: complete ? 'var(--success)' : 'var(--primary-light)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div>
          <strong>{record.name}</strong>
          <div style={{ color: 'var(--text-muted)', fontSize: '.82rem', marginTop: '.2rem' }}>Entwurf wird automatisch über die Unterformular-Sessions fortgesetzt · {session.progress.started}/{session.progress.total} gestartet · {session.progress.ready}/{session.progress.total} geprüft · {session.progress.submitted}/{session.progress.total} abgesendet</div>
          {committing && <div style={{ color: 'var(--text-muted)', fontSize: '.82rem', marginTop: '.3rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '.35rem' }}><Loader2 size={14} className="lf-spin" /> {session.progress.total} Dokumente werden gemeinsam gespeichert…</div>}
          {!committing && transactionSummary && <div style={{ color: transactionSummary.failed ? 'var(--danger)' : '#15803d', fontSize: '.82rem', marginTop: '.3rem', fontWeight: 600 }}>{transactionSummary.done ? `${transactionSummary.total} Dokumente wurden gemeinsam gespeichert.` : `${transactionSummary.committed}/${transactionSummary.total} gespeichert${transactionSummary.failed ? `, ${transactionSummary.failed} fehlgeschlagen` : ''}`}</div>}
          {!committing && transactionError && <div style={{ color: 'var(--danger)', fontSize: '.82rem', marginTop: '.3rem', fontWeight: 600, display: 'flex', alignItems: 'flex-start', gap: '.35rem' }}><AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} /> {transactionError}</div>}
        </div>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          <button className="btn btn-secondary" onClick={() => void validateAll()} disabled={checking || committing}><CheckCircle2 size={16} /> {checking ? 'Prüft…' : 'Alle Formulare prüfen'}</button>
          <button className="btn btn-primary" onClick={() => void commitTransaction()} disabled={committing || session.progress.total === 0}>{committing ? <Loader2 size={16} className="lf-spin" /> : <Save size={16} />} {committing ? 'Speichert…' : 'Alle Änderungen speichern'}</button>
        </div>
      </div>
      <div style={{ height: 8, background: 'var(--border)', borderRadius: 99, overflow: 'hidden', margin: '.8rem 0' }}><div style={{ height: '100%', width: `${session.progress.total ? session.progress.submitted / session.progress.total * 100 : 0}%`, background: complete ? 'var(--success)' : 'var(--primary)', transition: 'width .2s' }} /></div>
      {session.children.map((child, index) => <div key={child.sessionId || `${child.blockId}-${child.instanceIndex ?? index}`} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', fontSize: '.8rem', padding: '.15rem 0' }}>{childBadge(child.status)}<span style={{ color: 'var(--text-muted)' }}>{child.formId}{child.instanceIndex ? ` #${child.instanceIndex}` : ''}</span>{saveOutcomes[child.blockId]?.status === 'error' && <span style={{ color: 'var(--danger)' }}>· {saveOutcomes[child.blockId].message}</span>}</div>)}
      {complete && <div style={{ color: '#166534', fontWeight: 600, fontSize: '.85rem' }}>Der gesamte Vorgang ist abgeschlossen.</div>}
      <style>{'.lf-spin{animation:lf-spin .8s linear infinite}@keyframes lf-spin{to{transform:rotate(360deg)}}'}</style>
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
          {transactionError && <p style={{ color: 'var(--danger)', display: 'flex', alignItems: 'flex-start', gap: '.35rem', fontSize: '.85rem' }}><AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} /> {transactionError}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', marginTop: '1rem' }}>
            <button className="btn btn-secondary" onClick={() => setPendingNav(null)}>Weiter bearbeiten</button>
            <button className="btn btn-primary" disabled={committing} onClick={() => { const go = pendingNav; void commitTransaction().then((ok) => { if (ok) { setPendingNav(null); go?.(); } }); }}>{committing ? 'Speichert…' : 'Alle finalisieren und verlassen'}</button>
            <button className="btn" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={() => { const go = pendingNav; setPendingNav(null); go?.(); }}>Ohne Finalisieren verlassen</button>
          </div>
        </div>
      </div>
    )}
  </div>;
}
