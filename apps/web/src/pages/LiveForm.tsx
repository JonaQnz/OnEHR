import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  History,
  Loader2,
  Save,
  Undo2,
  XCircle,
} from 'lucide-react';
import { FORM_LAUNCH_PROTOCOL_VERSION, type FormDefinitionV1, type FormEmbedEventName, type RuntimeValues, type FormSessionRuntimeContext, type FormSessionLifecycleState, type FormSessionChangeType, type SaveState, type CompositionVersion } from 'core';
import FormRuntime, { type FormRuntimeHandle } from '../components/FormRuntime';
import PluginHost from '../components/PluginHost';
import CompositionHistoryPanel from '../components/CompositionHistoryPanel';
import HistoricalVersionView from '../components/HistoricalVersionView';
import CompositionDiffView from '../components/CompositionDiffView';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const API = 'http://localhost:3001/api';

interface SessionRecord {
  id: string;
  formId: string;
  mode: 'create' | 'edit' | 'view' | 'prefill';
  patientId: string;
  patientNamespace?: string;
  ehrId?: string;
  status: 'draft' | 'in_progress' | 'ready' | 'submitted' | 'failed' | 'cancelled';
  values: RuntimeValues;
  runtimeContext: FormSessionRuntimeContext;
  revision: number;
  providerReference?: string;
  draftReference?: string;
  baseVersionUid?: string;
  lifecycleState: FormSessionLifecycleState;
  lifecycleConfirmed: boolean;
  changeType?: FormSessionChangeType;
  changeDescription?: string;
}

interface ProviderResult {
  providerId: string;
  reference?: string;
  metadata?: {
    ehrId?: string;
    templateId?: string;
  };
}

interface FormResponse {
  id: string;
  canonical_json: FormDefinitionV1;
  name: string;
  version: string;
}

interface ValidationIssue {
  severity?: 'info' | 'warning' | 'error';
  code?: string;
  path?: string;
  message: string;
}

class RequestError extends Error {
  code?: string;
  messages?: ValidationIssue[];
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: 'include',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new RequestError(body.error || `Request failed (${response.status})`);
    if (typeof body.code === 'string') error.code = body.code;
    if (Array.isArray(body.messages)) error.messages = body.messages;
    throw error;
  }
  return body as T;
}

type Tone = 'neutral' | 'positive' | 'warning' | 'error';

// Plain clinical-language status - never the raw lifecycle_state/saveState
// codes. Deliberately not a form-field component's concern (state-poor
// components per the architecture principle); this is the editing session's
// own status area.
function clinicalStatusLabel(session: SessionRecord | null, saveState: SaveState): { text: string; tone: Tone } {
  if (!session) return { text: '', tone: 'neutral' };
  if (session.lifecycleState === 'deleted') return { text: 'Dokument zurückgezogen', tone: 'warning' };
  if (saveState === 'saving') return { text: 'Speichert…', tone: 'neutral' };
  if (saveState === 'conflict') return { text: 'Konflikt: Eine neuere Version liegt bereits vor', tone: 'error' };
  if (saveState === 'error') return { text: 'Speichern fehlgeschlagen', tone: 'error' };
  if (session.lifecycleState === 'complete' && session.status === 'submitted' && saveState !== 'dirty') return { text: 'Finalisiert', tone: 'positive' };
  if (saveState === 'dirty') return { text: 'Ungespeicherte Änderungen', tone: 'warning' };
  if (session.lifecycleState === 'incomplete') return { text: 'Entwurf gespeichert', tone: 'neutral' };
  return { text: 'Entwurf', tone: 'neutral' };
}

const TONE_COLORS: Record<Tone, { bg: string; fg: string; border: string }> = {
  neutral: { bg: 'var(--bg-sidebar, #f1f5f9)', fg: 'var(--text-muted, #475569)', border: 'var(--border, #e2e8f0)' },
  positive: { bg: 'var(--success-light, #d1fae5)', fg: 'var(--success-hover, #059669)', border: '#bbf7d0' },
  warning: { bg: 'var(--warning-light, #fef3c7)', fg: '#92400e', border: '#fde68a' },
  error: { bg: 'var(--danger-light, #fee2e2)', fg: 'var(--danger-hover, #dc2626)', border: '#fecaca' },
};

function ToneIcon({ tone, saveState, size = 15 }: { tone: Tone; saveState: SaveState; size?: number }) {
  if (saveState === 'saving') return <Loader2 size={size} className="lf-spin" />;
  if (tone === 'positive') return <CheckCircle2 size={size} />;
  if (tone === 'error') return <XCircle size={size} />;
  if (tone === 'warning') return <AlertTriangle size={size} />;
  return <FileText size={size} />;
}

function StatusPill({ tone, text, saveState }: { tone: Tone; text: string; saveState: SaveState }) {
  const colors = TONE_COLORS[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
      padding: '0.3rem 0.75rem', borderRadius: 999,
      background: colors.bg, color: colors.fg, border: `1px solid ${colors.border}`,
      fontSize: '0.82rem', fontWeight: 600, whiteSpace: 'nowrap',
    }}>
      <ToneIcon tone={tone} saveState={saveState} size={14} />
      {text}
    </span>
  );
}

function AlertCard({ tone, title, children, actions }: { tone: Tone; title: string; children?: React.ReactNode; actions?: React.ReactNode }) {
  const colors = TONE_COLORS[tone];
  return (
    <div style={{
      display: 'flex', gap: '0.75rem', padding: '1rem 1.1rem', marginBottom: '1rem',
      background: colors.bg, color: colors.fg, borderRadius: 10,
      border: `1px solid ${colors.border}`, borderLeft: `4px solid ${colors.fg}`,
    }}>
      <div style={{ paddingTop: '0.1rem', flexShrink: 0 }}><ToneIcon tone={tone} saveState="idle" size={19} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ display: 'block', fontSize: '0.95rem' }}>{title}</strong>
        {children && <div style={{ marginTop: '0.35rem', fontSize: '0.87rem', lineHeight: 1.5 }}>{children}</div>}
        {actions && <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>{actions}</div>}
      </div>
    </div>
  );
}

function Modal({ children, maxWidth = 440 }: { children: React.ReactNode; maxWidth?: number }) {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
      <div className="card" style={{ width: '100%', maxWidth, boxShadow: 'var(--shadow-lg, 0 10px 25px -5px rgba(0,0,0,0.2))', margin: 0 }}>
        {children}
      </div>
    </div>
  );
}

export default function LiveForm() {
  const { parentId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [form, setForm] = useState<FormResponse | null>(null);
  useDocumentTitle(form?.name || 'Form');
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [draftValues, setDraftValues] = useState<RuntimeValues>({});
  // Connection-wide autosave fallback (Configurable Settings roadmap) - a
  // form's own settings.runtime.autosaveEnabled/autosaveDebounceMs win when
  // set; this is only what applies to forms that don't set anything, so a
  // fetch failure just keeps this app's original built-in default (autosave
  // on, 2500ms) rather than blocking the form on a non-essential value.
  const [runtimeDefaults, setRuntimeDefaults] = useState({ autosaveEnabledByDefault: true, autosaveDebounceMsDefault: 2500 });
  useEffect(() => { void request<typeof runtimeDefaults>('/config/runtime-defaults').then(setRuntimeDefaults).catch(() => {}); }, []);

  const isEmbedded = useMemo(() => Boolean(searchParams.get('hostOrigin')), [searchParams]);
  const hostOrigin = useMemo(() => {
    const requested = searchParams.get('hostOrigin');
    if (!requested) return undefined;
    try { return new URL(requested).origin; } catch { return undefined; }
  }, [searchParams]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const runtimeRef = useRef<FormRuntimeHandle>(null);

  // --- Clinical Editing Layer: dirty tracking + save state (Epic 2) -------
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [lastSavedSignature, setLastSavedSignature] = useState('{}');
  const [validationIssues, setValidationIssues] = useState<ValidationIssue[] | null>(null);
  const dirty = JSON.stringify(draftValues) !== lastSavedSignature;

  // FormRuntime merges the form's own default values on top of whatever was
  // loaded (see createInitialRuntimeValues) - correct for a brand-new form,
  // but if we baselined dirty-tracking off the raw server payload, any field
  // with a default the loaded composition hadn't filled would immediately
  // "differ" from that baseline the moment the page opens, marking a
  // never-touched form dirty and autosaving a version nobody asked for. Set
  // this to true right before/while (re)loading a session; the next
  // onValuesChange call - FormRuntime's own settled post-merge state, not
  // the raw payload - becomes the real baseline instead.
  const baselinePendingRef = useRef(false);
  const handleValuesChange = (next: RuntimeValues) => {
    setDraftValues(next);
    if (baselinePendingRef.current) {
      baselinePendingRef.current = false;
      setLastSavedSignature(JSON.stringify(next));
    }
  };

  // Modification vs. amendment - only meaningful once editing an
  // already-`complete` composition.
  const [changeType, setChangeType] = useState<FormSessionChangeType>('modification');
  const [changeDescription, setChangeDescription] = useState('');

  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);

  // Navigation guard: `pendingNav` holds the action to run once the user
  // resolves the "unsaved changes" choice (continue editing / save & leave /
  // discard & leave).
  const [pendingNav, setPendingNav] = useState<(() => void) | null>(null);

  // --- Epic 3: Version History, Audit & Semantic Diff ---------------------
  const [historyOpen, setHistoryOpen] = useState(false);
  const [openHistoricalVersion, setOpenHistoricalVersion] = useState<string | null>(null);
  const [compareVersions, setCompareVersions] = useState<{ from: string; to: string } | null>(null);
  // The current version's own audit metadata (composer/committer/
  // contribution/preceding version) - fetched lazily, only when the
  // inspector is actually expanded (§28/§29), not on every page load.
  const [currentVersionDetail, setCurrentVersionDetail] = useState<CompositionVersion | null>(null);
  useEffect(() => { setCurrentVersionDetail(null); }, [session?.providerReference]);

  const publishEmbedEvent = (event: FormEmbedEventName, formId: string, sessionId?: string, message?: string, height?: number, dirtyState?: boolean) => {
    if (window.parent === window) return;
    let targetOrigin = window.location.origin;
    const requestedOrigin = searchParams.get('hostOrigin');
    if (requestedOrigin) {
      try { targetOrigin = new URL(requestedOrigin).origin; } catch { /* use same-origin fallback */ }
    }
    window.parent.postMessage({
      protocolVersion: FORM_LAUNCH_PROTOCOL_VERSION,
      event,
      formId,
      ...(sessionId ? { sessionId } : {}),
      ...(searchParams.get('launchId') ? { launchId: searchParams.get('launchId') } : {}),
      ...(message ? { message } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(dirtyState !== undefined ? { dirty: dirtyState } : {}),
    }, targetOrigin);
  };

  // Guards the session-bootstrap effect below against running twice for the
  // same launch - React 18 StrictMode deliberately double-invokes effects in
  // dev (mount -> cleanup -> mount), and this effect's async body has no
  // cancellation, so without this guard a single page load could fire two
  // independent `POST /form-sessions` calls back-to-back before either has
  // committed, defeating even the server's own reuse check and creating two
  // disconnected sessions for one visit.
  const bootstrapKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!parentId) return;
    const bootstrapKey = `${parentId}?${searchParams.toString()}`;
    if (bootstrapKeyRef.current === bootstrapKey) return;
    bootstrapKeyRef.current = bootstrapKey;
    setLoading(true);

    const exactVersion = searchParams.get('exactVersion') === 'true';
    const formPromise = exactVersion
      ? request<FormResponse>(`/forms/${encodeURIComponent(parentId)}`)
      : request<FormResponse>(`/forms/parent/${encodeURIComponent(parentId)}/latest-published`)
          .catch(() => request<FormResponse>(`/forms/${encodeURIComponent(parentId)}`));

    formPromise
      .then(async (formData) => {
        setForm(formData);

        const launchSessionId = searchParams.get('sessionId');
        if (launchSessionId) {
          const current = await request<SessionRecord>(`/form-sessions/${encodeURIComponent(launchSessionId)}`);
          if (current.formId !== formData.id) throw new Error('Die gestartete Session gehört nicht zu diesem Formular.');
          baselinePendingRef.current = true;
          setSession(current);
          setDraftValues(current.values || {});
          setLastSavedSignature(JSON.stringify(current.values || {})); // provisional - see baselinePendingRef
          if (current.status === 'submitted') setSubmitted(true);
          publishEmbedEvent('loaded', formData.id, current.id);
          return;
        }

        // Legacy direct-launch compatibility. New hosts use /form-launches.
        const patientId = searchParams.get('patientId') || searchParams.get('ehrId');
        const reference = searchParams.get('reference');
        const mode = searchParams.get('mode') || formData.canonical_json?.settings?.runtime?.defaultMode || 'create';

        if (patientId) {
          try {
            // The server itself now resumes this user's own still-open
            // edit/prefill session for the same form+patient(+composition)
            // instead of creating a disconnected duplicate - see
            // createFormSession()'s reuse lookup. No client-side pre-check
            // needed (and a client-side one racing this same decision would
            // only reintroduce the duplicate-session bug this replaces).
            const forceNew = searchParams.get('forceNew') === 'true';
            let current = await request<SessionRecord>('/form-sessions', {
              method: 'POST',
              body: JSON.stringify({
                formId: formData.id,
                patientId,
                mode,
                forceNew,
                ...(reference ? { providerReference: reference } : {})
              }),
            });
            // revision 0 = genuinely fresh (never loaded/saved) - only then
            // is it safe to pull the provider's current data. A resumed
            // session (revision > 0) already has real values; reloading here
            // would silently overwrite whatever the user last saved.
            if (mode !== 'create' && current.revision === 0) {
              const submissionProviderId = formData.canonical_json?.settings?.submission?.providerId || 'ehrbase';
              const loadResult = await request<{ session: SessionRecord }>(`/form-sessions/${current.id}/provider/load`, {
                method: 'POST',
                body: JSON.stringify({ providerId: submissionProviderId })
              });
              current = loadResult.session;
            }

            baselinePendingRef.current = true;
            setSession(current);
            setDraftValues(current.values || {});
            setLastSavedSignature(JSON.stringify(current.values || {})); // provisional - see baselinePendingRef
            if (current.status === 'submitted') setSubmitted(true);

            publishEmbedEvent('loaded', formData.id, current.id);
          } catch (e: any) {
            publishEmbedEvent('error', formData.id, undefined, e.message || 'Session konnte nicht gestartet werden.');
            setError(e.message || 'Session konnte nicht gestartet werden.');
          }
        }
      })
      .catch((e: any) => {
        publishEmbedEvent('error', parentId, undefined, e.message || 'Live Formular nicht gefunden oder nicht veröffentlicht.');
        setError(e.message || 'Live Formular nicht gefunden oder nicht veröffentlicht.');
      })
      .finally(() => setLoading(false));
  }, [parentId, searchParams]);

  const handleSubmit = async (values: RuntimeValues) => {
    if (!session || busy || submitted) return;
    setBusy(true);
    setValidationIssues(null);
    try {
      const beforeSave = await runtimeRef.current?.runLifecycle('beforeSave');
      if (beforeSave?.cancelled) throw new Error(beforeSave.message || 'Das Speichern wurde vom Form Script abgebrochen.');
      const valuesToSave = runtimeRef.current?.getValues() || values;
      // Save draft
      const saved = await request<SessionRecord>(`/form-sessions/${session.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ values: valuesToSave, expectedRevision: session.revision })
      });
      runtimeRef.current?.applyValues(saved.values || valuesToSave, 'script', true);
      await runtimeRef.current?.runLifecycle('afterSave');

      // Finalize: editing an already-`complete` composition is a
      // modification/amendment (real openEHR change_type), never a silent
      // overwrite - a fresh draft's first finalize has no change_type.
      const submissionProviderId = form?.canonical_json?.settings?.submission?.providerId || 'ehrbase';
      const isModifyingComplete = session.lifecycleState === 'complete';
      const result = await request<{ session: SessionRecord; provider: ProviderResult }>(`/form-sessions/${saved.id}/provider/submit`, {
        method: 'POST',
        body: JSON.stringify({
          providerId: submissionProviderId,
          validatedRevision: saved.revision,
          ...(isModifyingComplete ? { changeType, changeDescription: changeDescription.trim() || undefined } : {}),
        }),
      });

      setSession(result.session);
      setDraftValues(result.session.values || values);
      setLastSavedSignature(JSON.stringify(result.session.values || values));
      setSaveState('saved');
      runtimeRef.current?.applyValues(result.session.values || values, 'script', true);
      setSubmitted(true);

      if (form) publishEmbedEvent('submitted', form.id, session.id);
    } catch (e: any) {
      if (e.code === 'COMPOSITION_VERSION_CONFLICT') setSaveState('conflict');
      if (Array.isArray(e.messages) && e.messages.length > 0) setValidationIssues(e.messages);
      if (form) publishEmbedEvent('error', form.id, session.id, e.message || 'Finalisieren fehlgeschlagen.');
      setError(e.message || 'Finalisieren fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // A Composition host is the only legitimate sender of this control
      // message; the embed URL is only ever handed to that trusted parent.
      if (event.origin !== window.location.origin && event.origin !== hostOrigin) return;
      if (event.data?.type === 'EXTERNAL_FORM_SUBMIT') {
        handleSubmit(runtimeRef.current?.getValues() || draftValues);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [session, busy, submitted, draftValues, hostOrigin]);

  // Read via refs inside the debounce timer, not the `session`/`draftValues`
  // state directly: the autosave below itself updates `session` on success,
  // and depending on state whose identity changes on every such update
  // would re-trigger this effect and schedule a redundant autosave forever.
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);
  const draftValuesRef = useRef(draftValues);
  useEffect(() => { draftValuesRef.current = draftValues; }, [draftValues]);
  const savingRef = useRef(false);

  /**
   * The one save path both the debounced autosave and the manual "Entwurf
   * speichern" button use - no parallel saves (savingRef), and a version
   * conflict becomes its own explicit SaveState rather than being silently
   * retried or swallowed. Local values are never touched on failure: they
   * stay exactly as the user left them, conflict or not.
   */
  const saveDraftNow = async (): Promise<void> => {
    const current = sessionRef.current;
    if (!current || savingRef.current || current.mode === 'view' || current.lifecycleState === 'deleted') return;
    const valuesToSave = draftValuesRef.current;
    savingRef.current = true;
    setSaveState('saving');
    try {
      const providerId = form?.canonical_json?.settings?.submission?.providerId || 'ehrbase';
      const updated = await request<SessionRecord>(`/form-sessions/${current.id}/provider/draft`, {
        method: 'POST',
        body: JSON.stringify({ providerId, values: valuesToSave }),
      });
      setSession(updated);
      setLastSavedSignature(JSON.stringify(valuesToSave));
      setSaveState('saved');
    } catch (e: any) {
      if (e.code === 'COMPOSITION_VERSION_CONFLICT') {
        setSaveState('conflict');
      } else {
        setSaveState('error');
        console.warn('[save] Draft could not be persisted to the provider:', e);
      }
    } finally {
      savingRef.current = false;
    }
  };

  // The form's own settings.runtime.autosaveEnabled/autosaveDebounceMs win
  // when set; unset defers to the connection-wide default fetched above.
  // The manual "Entwurf speichern" button (saveDraftNow, called directly)
  // is unaffected either way - this only governs the debounced timer below.
  const runtimeSettings = form?.canonical_json?.settings?.runtime;
  const autosaveEnabled = runtimeSettings?.autosaveEnabled ?? runtimeDefaults.autosaveEnabledByDefault;
  const autosaveDebounceMs = runtimeSettings?.autosaveDebounceMs ?? runtimeDefaults.autosaveDebounceMsDefault;

  useEffect(() => {
    if (!session || submitted || busy || session.mode === 'view' || session.lifecycleState === 'deleted' || !dirty) return;
    setSaveState((s) => (s === 'saving' ? s : 'dirty'));
    if (!autosaveEnabled) return;
    // Debounced whole-form save: EHRbase commits a brand-new immutable
    // VERSION on every write, so this waits for a pause in editing rather
    // than pushing on every keystroke or field blur.
    const timer = setTimeout(() => { saveDraftNow(); }, autosaveDebounceMs);
    return () => clearTimeout(timer);
  }, [draftValues, session?.id, session?.mode, session?.lifecycleState, submitted, busy, dirty, autosaveEnabled, autosaveDebounceMs]); // eslint-disable-line react-hooks/exhaustive-deps -- reads sessionRef/draftValuesRef, not state, on purpose (see comment above)

  // Navigation guard (browser-level: tab close, refresh, address bar).
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Tells an embedding host (e.g. CompositionRuntime, which aggregates
  // several forms as one clinical Vorgang) about this form's own dirty
  // state, so the host's own "leave the page" guard can account for it too -
  // an iframe's beforeunload only ever protects that iframe's own document,
  // never a parent SPA route change.
  useEffect(() => {
    if (!isEmbedded || !form || !session) return;
    publishEmbedEvent('dirty', form.id, session.id, undefined, undefined, dirty);
  }, [isEmbedded, form?.id, session?.id, dirty]); // eslint-disable-line react-hooks/exhaustive-deps

  /** In-app navigation (return-url / back link): same 3-way choice as the
   * browser-level guard, since this app uses a plain BrowserRouter without
   * `useBlocker` (no data-router migration needed for this). */
  const guardedNavigate = (go: () => void) => {
    if (!dirty) { go(); return; }
    setPendingNav(() => go);
  };

  const withdrawNow = async () => {
    if (!session || withdrawing) return;
    setWithdrawing(true);
    try {
      const providerId = form?.canonical_json?.settings?.submission?.providerId || 'ehrbase';
      const result = await request<{ session: SessionRecord }>(`/form-sessions/${session.id}/provider/withdraw`, {
        method: 'POST',
        body: JSON.stringify({ providerId, reason: withdrawReason.trim() || undefined }),
      });
      setSession(result.session);
      setWithdrawOpen(false);
      setWithdrawReason('');
    } catch (e: any) {
      setError(e.message || 'Zurückziehen fehlgeschlagen.');
    } finally {
      setWithdrawing(false);
    }
  };

  const reloadLatestVersion = async () => {
    if (!session) return;
    try {
      const providerId = form?.canonical_json?.settings?.submission?.providerId || 'ehrbase';
      const result = await request<{ session: SessionRecord }>(`/form-sessions/${session.id}/provider/load`, {
        method: 'POST',
        body: JSON.stringify({ providerId }),
      });
      // Deliberately does NOT touch draftValues - the local snapshot the
      // user was working on stays exactly as it was; only the server's
      // baseline (session/lastSavedSignature) moves forward, so the next
      // save/dirty-check compares against the newly-loaded version. No
      // automatic merge (that's Epic 3) - the user decides what to keep.
      setSession(result.session);
      setLastSavedSignature(JSON.stringify(result.session.values || {}));
      setSaveState('dirty');
    } catch (e: any) {
      setError(e.message || 'Neue Version konnte nicht geladen werden.');
    }
  };

  useEffect(() => {
    if (!isEmbedded || !form || !session) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        publishEmbedEvent('resize', form.id, session.id, undefined, entry.contentRect.height);
      }
    });
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [isEmbedded, form?.id, session?.id]);

  const pageStyle = isEmbedded
    ? { width: '100%', height: '100%', background: 'var(--bg-body, #f8fafc)', boxSizing: 'border-box' as const }
    : { width: '100vw', minHeight: '100vh', background: 'var(--bg-body, #f8fafc)', padding: '1.5rem 1rem', boxSizing: 'border-box' as const, fontFamily: 'var(--font-family, sans-serif)' };

  if (loading) {
    return (
      <div style={{ ...pageStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem', color: 'var(--text-muted, #64748b)' }}>
        <Loader2 size={18} className="lf-spin" /> Lade Live Formular…
        <style>{'.lf-spin{animation:lf-spin 0.9s linear infinite}@keyframes lf-spin{to{transform:rotate(360deg)}}'}</style>
      </div>
    );
  }
  if (error) {
    return (
      <div style={pageStyle}>
        <div className="card" style={{ maxWidth: 560, margin: '2rem auto', display: 'flex', gap: '0.75rem', color: 'var(--danger, #ef4444)' }}>
          <XCircle size={20} style={{ flexShrink: 0, marginTop: '0.1rem' }} />
          <span>{error}</span>
        </div>
      </div>
    );
  }
  if (!form) {
    return (
      <div style={pageStyle}>
        <div className="card" style={{ maxWidth: 560, margin: '2rem auto', textAlign: 'center', color: 'var(--text-muted, #64748b)' }}>
          Formular nicht gefunden.
        </div>
      </div>
    );
  }

  const status = clinicalStatusLabel(session, saveState);
  const isModifyingComplete = Boolean(session && session.lifecycleState === 'complete' && !submitted);
  const isWithdrawn = session?.lifecycleState === 'deleted';

  return (
    <div style={pageStyle}>
      <style>{'.lf-spin{animation:lf-spin 0.9s linear infinite}@keyframes lf-spin{to{transform:rotate(360deg)}} .lf-radio{display:flex;align-items:center;gap:0.5rem;padding:0.6rem 0.75rem;border:1px solid var(--border,#e2e8f0);border-radius:8px;cursor:pointer;font-size:0.88rem;flex:1;min-width:220px}.lf-radio:has(input:checked){border-color:var(--primary,#4f46e5);background:var(--primary-light,#e0e7ff)}'}</style>
      {!session ? (
        <div className="card" style={{ maxWidth: '640px', margin: '2rem auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.75rem' }}>
            <FileText size={22} color="var(--primary, #4f46e5)" />
            <h1 style={{ margin: 0, fontSize: '1.3rem' }}>{form.name}</h1>
          </div>
          <p style={{ color: 'var(--text-muted, #64748b)', lineHeight: 1.6 }}>
            Bitte übergeben Sie eine <code>patientId</code> oder <code>ehrId</code> per URL-Parameter, um das Formular zu starten.
            <br/><br/>
            Beispiel: <code>?ehrId=838d21b7-781e-450f-9f7a-8dd2d1234567</code>
          </p>
        </div>
      ) : (
        <div style={isEmbedded ? { width: '100%' } : { maxWidth: '880px', margin: '0 auto' }}>
          {!isEmbedded && !submitted && !isWithdrawn && (
            <div className="card" style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0 }}>
                <FileText size={20} color="var(--primary, #4f46e5)" style={{ flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <strong style={{ display: 'block', fontSize: '1.05rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{form.name}</strong>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted, #64748b)' }}>
                    Patient: {session.patientId}{session.ehrId ? ` · EHR ${session.ehrId.slice(0, 8)}…` : ''}
                  </span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <StatusPill tone={status.tone} text={status.text} saveState={saveState} />
                <button
                  className="btn btn-secondary"
                  onClick={() => saveDraftNow()}
                  disabled={saveState === 'saving' || session.mode === 'view'}
                >
                  <Save size={15} /> Entwurf speichern
                </button>
                <button className="btn btn-secondary" onClick={() => setHistoryOpen((open) => !open)}>
                  <History size={15} /> Verlauf
                </button>
              </div>
            </div>
          )}

          {!isEmbedded && historyOpen && (
            <div className="card">
              <div style={{ fontWeight: 700, marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <History size={16} /> Dokumenthistorie
              </div>
              <CompositionHistoryPanel
                sessionId={session.id}
                refreshKey={session.revision}
                onOpenVersion={setOpenHistoricalVersion}
                onCompare={(from, to) => setCompareVersions({ from, to })}
              />
            </div>
          )}

          {saveState === 'conflict' && (
            <AlertCard
              tone="error"
              title="Diese Dokumentation wurde inzwischen von anderer Stelle geändert."
              actions={<>
                <button className="btn btn-danger" onClick={reloadLatestVersion}>Neue Version laden</button>
                <button className="btn btn-secondary" onClick={() => setSaveState('dirty')}>Weiter bearbeiten</button>
              </>}
            >
              Ihre lokalen Änderungen sind nicht verloren, wurden aber noch nicht gespeichert. Laden Sie die neue Version, bevor Sie weiterarbeiten - ein automatisches Zusammenführen findet nicht statt.
            </AlertCard>
          )}

          {validationIssues && validationIssues.length > 0 && (
            <AlertCard tone="warning" title={`${validationIssues.length} Angabe(n) verhindern das Finalisieren`}>
              <ul style={{ margin: '0.25rem 0 0 1.1rem', padding: 0 }}>
                {validationIssues.map((issue, index) => <li key={index}>{issue.path ? `${issue.path}: ` : ''}{issue.message}</li>)}
              </ul>
            </AlertCard>
          )}

          {isWithdrawn && (
            <AlertCard tone="warning" title="Dieses Dokument wurde zurückgezogen." />
          )}

          {isModifyingComplete && (
            <div className="card">
              <div className="form-label" style={{ marginBottom: '0.6rem' }}>Art der Änderung</div>
              <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
                <label className="lf-radio">
                  <input type="radio" name="changeType" checked={changeType === 'modification'} onChange={() => setChangeType('modification')} />
                  Routinemäßige Aktualisierung
                </label>
                <label className="lf-radio">
                  <input type="radio" name="changeType" checked={changeType === 'amendment'} onChange={() => setChangeType('amendment')} />
                  Korrektur eines Dokumentationsfehlers
                </label>
              </div>
              <input
                className="form-input"
                type="text"
                placeholder="Grund der Änderung (optional)"
                value={changeDescription}
                onChange={(event) => setChangeDescription(event.target.value)}
                style={{ marginTop: '0.75rem' }}
              />
            </div>
          )}

          {submitted && (
            <AlertCard
              tone="positive"
              title="Formular erfolgreich abgesendet."
              actions={searchParams.get('returnUrl') ? (
                <button
                  className="btn"
                  onClick={() => guardedNavigate(() => {
                    const url = searchParams.get('returnUrl')!;
                    if (url.startsWith('http')) window.location.href = url;
                    else navigate(url);
                  })}
                >
                  <ArrowLeft size={15} /> Zurück zur Übersicht
                </button>
              ) : undefined}
            >
              <span style={{ overflowWrap: 'anywhere' }}>
                Patient-ID: {session.patientId}
                {session.ehrId ? ` · EHR-ID: ${session.ehrId}` : ''}
                {session.providerReference ? ` · Referenz: ${session.providerReference}` : ''}
              </span>
            </AlertCard>
          )}

          <div className={isEmbedded ? undefined : 'card'} style={isEmbedded ? undefined : { padding: '1.5rem' }}>
            <FormRuntime
              ref={runtimeRef}
              definition={form.canonical_json}
              initialValues={session.values}
              patientId={session.patientId}
              ehrId={session.ehrId}
              encounterId={searchParams.get('encounterId') || undefined}
              sessionId={session.id}
              hiddenFieldIds={(searchParams.get('hiddenFieldIds') || '').split(',').map((id) => id.trim()).filter(Boolean)}
              runtimeContext={session.runtimeContext}
              readOnly={submitted || session.mode === 'view' || isWithdrawn}
              busy={busy}
              submitLabel={submitted ? 'Abgesendet' : (isModifyingComplete ? 'Änderung finalisieren' : 'Finalisieren')}
              showSubmit={!isEmbedded && !isWithdrawn}
              onValuesChange={handleValuesChange}
              onSubmit={handleSubmit}
              mode={session.mode || 'create'}
            />
          </div>
          <PluginHost
            slot="runtime"
            title="Aktionen"
            disabled={busy || submitted}
            context={{
              formId: form.id,
              patientId: session.patientId,
              sessionId: session.id,
              form: form.canonical_json as unknown as Record<string, unknown>,
              data: draftValues as unknown as Record<string, unknown>
            }}
            onResult={(res) => {
               if (res.data) setDraftValues(res.data as RuntimeValues);
            }}
          />

          {!isEmbedded && session.lifecycleState === 'complete' && !isWithdrawn && (
            <div style={{ marginTop: '1rem', textAlign: 'right' }}>
              <button className="btn btn-danger" onClick={() => setWithdrawOpen(true)}>
                <Undo2 size={15} /> Dokument zurückziehen
              </button>
            </div>
          )}

          {!isEmbedded && (
            <details
              className="card"
              style={{ marginTop: '1rem', fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-muted, #64748b)' }}
              onToggle={(event) => {
                // Lazy, on-demand only (§28/§29) - the current version's own
                // audit metadata (composer/committer/contribution/preceding
                // version) is fetched only once the inspector is actually
                // expanded, never on every page load.
                if ((event.target as HTMLDetailsElement).open && !currentVersionDetail && session.providerReference) {
                  request<{ version: CompositionVersion }>(`/form-sessions/${session.id}/provider/history/${encodeURIComponent(session.providerReference)}`)
                    .then((result) => setCurrentVersionDetail(result.version))
                    .catch(() => { /* best-effort - the rest of the inspector still works without this */ });
                }
              }}
            >
              <summary style={{ cursor: 'pointer', fontFamily: 'var(--font-family, sans-serif)', fontWeight: 600, color: 'var(--text-main, #0f172a)' }}>Clinical Editing (Entwickler-Inspektor)</summary>
              <div style={{ marginTop: '0.75rem', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.3rem 1rem' }}>
                <span>Composition UID</span><span style={{ overflowWrap: 'anywhere' }}>{session.providerReference || '—'}</span>
                <span>Version UID (Base)</span><span style={{ overflowWrap: 'anywhere' }}>{session.baseVersionUid || '—'}</span>
                <span>Draft Reference</span><span style={{ overflowWrap: 'anywhere' }}>{session.draftReference || '—'}</span>
                <span>Lifecycle State</span><span>{session.lifecycleState}{!session.lifecycleConfirmed ? ' (nicht vom CDR bestätigt)' : ''}</span>
                <span>Editing Mode</span><span>{session.mode}</span>
                <span>Dirty</span><span>{String(dirty)}</span>
                <span>Save State</span><span>{saveState}</span>
                <span>Change Type</span><span>{session.changeType || '—'}</span>
                <span>Historical Version</span><span>false</span>
                <span>Preceding Version UID</span><span style={{ overflowWrap: 'anywhere' }}>{currentVersionDetail?.precedingVersionUid || '—'}</span>
                <span>Committer</span><span>{currentVersionDetail?.committer?.name || '—'}</span>
                <span>Composer</span><span>{currentVersionDetail?.composer?.name || '—'}</span>
                <span>Contribution UID</span><span style={{ overflowWrap: 'anywhere' }}>{currentVersionDetail?.contributionUid || '—'}</span>
                <span>Commit Timestamp</span><span>{currentVersionDetail?.committedAt || '—'}</span>
              </div>
            </details>
          )}
        </div>
      )}

      {pendingNav && (
        <Modal>
          <h3 style={{ marginTop: 0 }}>Ungespeicherte Änderungen</h3>
          <p style={{ color: 'var(--text-muted, #475569)' }}>Sie haben nicht gespeicherte Änderungen an diesem Formular. Wie möchten Sie fortfahren?</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
            <button className="btn btn-secondary" onClick={() => setPendingNav(null)}>Weiter bearbeiten</button>
            <button
              className="btn"
              onClick={async () => { const go = pendingNav; setPendingNav(null); await saveDraftNow(); go?.(); }}
            >
              <Save size={15} /> Entwurf speichern und verlassen
            </button>
            <button className="btn btn-danger" onClick={() => { const go = pendingNav; setPendingNav(null); go?.(); }}>
              Änderungen verwerfen und verlassen
            </button>
          </div>
        </Modal>
      )}

      {openHistoricalVersion && session && (
        <HistoricalVersionView
          sessionId={session.id}
          versionUid={openHistoricalVersion}
          definition={form.canonical_json}
          patientId={session.patientId}
          ehrId={session.ehrId}
          onClose={() => setOpenHistoricalVersion(null)}
        />
      )}

      {compareVersions && session && (
        <CompositionDiffView
          sessionId={session.id}
          fromVersionUid={compareVersions.from}
          toVersionUid={compareVersions.to}
          onClose={() => setCompareVersions(null)}
        />
      )}

      {withdrawOpen && (
        <Modal>
          <h3 style={{ marginTop: 0 }}>Dokument zurückziehen</h3>
          <p style={{ color: 'var(--text-muted, #475569)' }}>Das Dokument wird als zurückgezogen markiert. Die bisherige Version bleibt im Verlauf erhalten, gilt aber nicht mehr als aktuell.</p>
          <input
            className="form-input"
            type="text"
            placeholder="Grund (optional)"
            value={withdrawReason}
            onChange={(event) => setWithdrawReason(event.target.value)}
            style={{ marginBottom: '1rem' }}
          />
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn btn-secondary" onClick={() => setWithdrawOpen(false)} disabled={withdrawing}>Abbrechen</button>
            <button className="btn btn-danger" onClick={withdrawNow} disabled={withdrawing} style={{ background: 'var(--danger, #ef4444)', color: '#fff' }}>
              {withdrawing ? <Loader2 size={15} className="lf-spin" /> : <Undo2 size={15} />}
              {withdrawing ? 'Wird zurückgezogen…' : 'Zurückziehen'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
