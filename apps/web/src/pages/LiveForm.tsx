import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { FORM_LAUNCH_PROTOCOL_VERSION, type FormDefinitionV1, type FormEmbedEventName, type RuntimeValues, type FormSessionRuntimeContext, type FormSessionLifecycleState, type FormSessionChangeType, type SaveState, type CompositionVersion } from 'core';
import FormRuntime, { type FormRuntimeHandle } from '../components/FormRuntime';
import PluginHost from '../components/PluginHost';
import CompositionHistoryPanel from '../components/CompositionHistoryPanel';
import HistoricalVersionView from '../components/HistoricalVersionView';
import CompositionDiffView from '../components/CompositionDiffView';

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

// Plain clinical-language status - never the raw lifecycle_state/saveState
// codes. Deliberately not a form-field component's concern (state-poor
// components per the architecture principle); this is the editing session's
// own status area.
function clinicalStatusLabel(session: SessionRecord | null, saveState: SaveState): { text: string; tone: 'neutral' | 'positive' | 'warning' | 'error' } {
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

const TONE_COLORS: Record<'neutral' | 'positive' | 'warning' | 'error', { bg: string; fg: string; border: string }> = {
  neutral: { bg: '#f1f5f9', fg: '#334155', border: '#e2e8f0' },
  positive: { bg: '#dcfce7', fg: '#15803d', border: '#bbf7d0' },
  warning: { bg: '#fef9c3', fg: '#854d0e', border: '#fde68a' },
  error: { bg: '#fee2e2', fg: '#b91c1c', border: '#fecaca' },
};

export default function LiveForm() {
  const { parentId } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [form, setForm] = useState<FormResponse | null>(null);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [draftValues, setDraftValues] = useState<RuntimeValues>({});

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

  useEffect(() => {
    if (!parentId) return;
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
          setSession(current);
          setDraftValues(current.values || {});
          setLastSavedSignature(JSON.stringify(current.values || {}));
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
            const query = `?patientId=${encodeURIComponent(patientId)}&formId=${encodeURIComponent(formData.id)}`;
            const existing = await request<SessionRecord[]>(`/form-sessions${query}`);
            const forceNew = searchParams.get('forceNew') === 'true';
            const reusable = forceNew ? undefined : existing.find((item) =>
              !['submitted', 'cancelled'].includes(item.status) &&
              (!reference || item.providerReference === reference) &&
              ((item as any).mode === mode)
            );

            let current = reusable;
            let newlyCreated = false;
            if (!current) {
               current = await request<SessionRecord>('/form-sessions', {
                method: 'POST',
                body: JSON.stringify({
                  formId: formData.id,
                  patientId,
                  mode,
                  ...(reference ? { providerReference: reference } : {})
                }),
              });
              newlyCreated = true;
            }

            if (newlyCreated) {
              if (mode !== 'create') {
                const submissionProviderId = formData.canonical_json?.settings?.submission?.providerId || 'ehrbase';
                const loadResult = await request<{ session: SessionRecord }>(`/form-sessions/${current.id}/provider/load`, {
                  method: 'POST',
                  body: JSON.stringify({ providerId: submissionProviderId })
                });
                current = loadResult.session;
              }
            }

            setSession(current);
            setDraftValues(current.values || {});
            setLastSavedSignature(JSON.stringify(current.values || {}));
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

  useEffect(() => {
    if (!session || submitted || busy || session.mode === 'view' || session.lifecycleState === 'deleted' || !dirty) return;
    setSaveState((s) => (s === 'saving' ? s : 'dirty'));
    // Debounced whole-form save: EHRbase commits a brand-new immutable
    // VERSION on every write, so this waits for a pause in editing rather
    // than pushing on every keystroke or field blur.
    const timer = setTimeout(() => { saveDraftNow(); }, 2500);
    return () => clearTimeout(timer);
  }, [draftValues, session?.id, session?.mode, session?.lifecycleState, submitted, busy, dirty]); // eslint-disable-line react-hooks/exhaustive-deps -- reads sessionRef/draftValuesRef, not state, on purpose (see comment above)

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

  if (loading) return <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'sans-serif' }}>Lade Live Formular...</div>;
  if (error) return <div style={{ padding: '2rem', color: '#b91c1c', fontFamily: 'sans-serif' }}>{error}</div>;
  if (!form) return <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>Formular nicht gefunden.</div>;

  const status = clinicalStatusLabel(session, saveState);
  const statusColor = TONE_COLORS[status.tone];
  const isModifyingComplete = Boolean(session && session.lifecycleState === 'complete' && !submitted);
  const isWithdrawn = session?.lifecycleState === 'deleted';

  return (
    <div style={isEmbedded ? { width: '100%', height: '100%', background: '#f8fafc', boxSizing: 'border-box' } : { width: '100vw', minHeight: '100vh', background: '#f8fafc', padding: '1rem', boxSizing: 'border-box' }}>
      {!session ? (
        <div style={{ maxWidth: '640px', margin: '2rem auto', padding: '2rem', background: '#fff', borderRadius: '8px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }}>
          <h1 style={{ margin: '0 0 1rem 0', fontFamily: 'sans-serif' }}>{form.name}</h1>
          <p style={{ fontFamily: 'sans-serif', color: '#64748b' }}>
            Bitte übergeben Sie eine <code>patientId</code> oder <code>ehrId</code> per URL-Parameter, um das Formular zu starten.
            <br/><br/>
            Beispiel: <code>?ehrId=838d21b7-781e-450f-9f7a-8dd2d1234567</code>
          </p>
        </div>
      ) : (
        <div style={isEmbedded ? { width: '100%' } : { maxWidth: '960px', margin: '0 auto' }}>
          {!isEmbedded && !submitted && !isWithdrawn && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', padding: '0.6rem 1rem', background: statusColor.bg, color: statusColor.fg, border: `1px solid ${statusColor.border}`, borderRadius: '8px', fontFamily: 'sans-serif', fontSize: '0.9rem' }}>
              <span><strong>{status.text}</strong></span>
              <button
                onClick={() => saveDraftNow()}
                disabled={saveState === 'saving' || session.mode === 'view'}
                style={{ background: 'transparent', border: `1px solid ${statusColor.fg}`, color: statusColor.fg, padding: '0.35rem 0.9rem', borderRadius: '6px', cursor: saveState === 'saving' ? 'default' : 'pointer', fontSize: '0.85rem' }}
              >
                Entwurf speichern
              </button>
            </div>
          )}

          {!isEmbedded && (
            <div style={{ marginBottom: '1rem' }}>
              <button
                onClick={() => setHistoryOpen((open) => !open)}
                style={{ background: 'transparent', border: '1px solid #cbd5e1', color: '#334155', padding: '0.35rem 0.9rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.85rem', fontFamily: 'sans-serif' }}
              >
                {historyOpen ? 'Verlauf ausblenden' : 'Verlauf anzeigen'}
              </button>
              {historyOpen && (
                <div style={{ marginTop: '0.5rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.75rem 1rem' }}>
                  <div style={{ fontWeight: 700, fontFamily: 'sans-serif', marginBottom: '0.4rem' }}>Dokumenthistorie</div>
                  <CompositionHistoryPanel
                    sessionId={session.id}
                    refreshKey={session.revision}
                    onOpenVersion={setOpenHistoricalVersion}
                    onCompare={(from, to) => setCompareVersions({ from, to })}
                  />
                </div>
              )}
            </div>
          )}

          {saveState === 'conflict' && (
            <div style={{ padding: '1rem', marginBottom: '1rem', background: '#fee2e2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: '8px', fontFamily: 'sans-serif' }}>
              <strong>Diese Dokumentation wurde inzwischen von anderer Stelle geändert.</strong>
              <p style={{ margin: '0.5rem 0' }}>Ihre lokalen Änderungen sind nicht verloren, wurden aber noch nicht gespeichert. Laden Sie die neue Version, bevor Sie weiterarbeiten - ein automatisches Zusammenführen findet nicht statt.</p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button onClick={reloadLatestVersion} style={{ background: '#b91c1c', color: '#fff', border: 'none', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }}>Neue Version laden</button>
                <button onClick={() => setSaveState('dirty')} style={{ background: 'transparent', border: '1px solid #b91c1c', color: '#b91c1c', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer' }}>Weiter bearbeiten</button>
              </div>
            </div>
          )}

          {validationIssues && validationIssues.length > 0 && (
            <div style={{ padding: '1rem', marginBottom: '1rem', background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a', borderRadius: '8px', fontFamily: 'sans-serif' }}>
              <strong>{validationIssues.length} Angabe(n) verhindern das Finalisieren:</strong>
              <ul style={{ margin: '0.5rem 0 0 1.2rem', padding: 0 }}>
                {validationIssues.map((issue, index) => <li key={index}>{issue.path ? `${issue.path}: ` : ''}{issue.message}</li>)}
              </ul>
            </div>
          )}

          {isWithdrawn && (
            <div style={{ padding: '1rem', marginBottom: '1rem', background: '#fef9c3', color: '#854d0e', border: '1px solid #fde68a', borderRadius: '8px', fontFamily: 'sans-serif' }}>
              Dieses Dokument wurde zurückgezogen.
            </div>
          )}

          {isModifyingComplete && (
            <div style={{ padding: '1rem', marginBottom: '1rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontFamily: 'sans-serif' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>Art der Änderung</div>
              <label style={{ marginRight: '1.5rem' }}>
                <input type="radio" name="changeType" checked={changeType === 'modification'} onChange={() => setChangeType('modification')} /> Routinemäßige Aktualisierung
              </label>
              <label>
                <input type="radio" name="changeType" checked={changeType === 'amendment'} onChange={() => setChangeType('amendment')} /> Korrektur eines Dokumentationsfehlers
              </label>
              <div style={{ marginTop: '0.6rem' }}>
                <input
                  type="text"
                  placeholder="Grund der Änderung (optional)"
                  value={changeDescription}
                  onChange={(event) => setChangeDescription(event.target.value)}
                  style={{ width: '100%', padding: '0.5rem', border: '1px solid #cbd5e1', borderRadius: '6px', boxSizing: 'border-box' }}
                />
              </div>
            </div>
          )}

          {submitted && (
            <div style={{ padding: '1.5rem', marginBottom: '1.5rem', background: '#dcfce7', color: '#15803d', borderRadius: '8px', border: '1px solid #bbf7d0', fontFamily: 'sans-serif', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <strong style={{ fontSize: '1.1rem' }}>Formular erfolgreich abgesendet.</strong>
                <div style={{ marginTop: '0.35rem', fontSize: '0.8rem', overflowWrap: 'anywhere' }}>
                  Patient-ID: {session.patientId}
                  {session.ehrId ? ` · EHR-ID: ${session.ehrId}` : ''}
                  {session.providerReference ? ` · Referenz: ${session.providerReference}` : ''}
                </div>
              </div>
              {searchParams.get('returnUrl') && (
                <button
                  onClick={() => guardedNavigate(() => {
                    const url = searchParams.get('returnUrl')!;
                    if (url.startsWith('http')) window.location.href = url;
                    else navigate(url);
                  })}
                  style={{ background: '#166534', color: 'white', border: 'none', padding: '0.6rem 1.2rem', borderRadius: '6px', cursor: 'pointer', fontWeight: 600 }}
                >
                  Zurück zur Übersicht
                </button>
              )}
            </div>
          )}
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
            onValuesChange={setDraftValues}
            onSubmit={handleSubmit}
            mode={session.mode || 'create'}
          />
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
            <div style={{ marginTop: '1.5rem', textAlign: 'right' }}>
              <button
                onClick={() => setWithdrawOpen(true)}
                style={{ background: 'transparent', border: '1px solid #b91c1c', color: '#b91c1c', padding: '0.5rem 1rem', borderRadius: '6px', cursor: 'pointer', fontFamily: 'sans-serif' }}
              >
                Dokument zurückziehen
              </button>
            </div>
          )}

          {!isEmbedded && (
            <details
              style={{ marginTop: '1.5rem', fontFamily: 'monospace', fontSize: '0.75rem', color: '#64748b' }}
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
              <summary style={{ cursor: 'pointer', fontFamily: 'sans-serif' }}>Clinical Editing (Entwickler-Inspektor)</summary>
              <div style={{ marginTop: '0.5rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '0.75rem', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.25rem 1rem' }}>
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: '10px', padding: '1.5rem', maxWidth: '420px', fontFamily: 'sans-serif', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.2)' }}>
            <h3 style={{ marginTop: 0 }}>Ungespeicherte Änderungen</h3>
            <p style={{ color: '#475569' }}>Sie haben nicht gespeicherte Änderungen an diesem Formular. Wie möchten Sie fortfahren?</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '1rem' }}>
              <button onClick={() => setPendingNav(null)} style={{ padding: '0.6rem', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer' }}>Weiter bearbeiten</button>
              <button
                onClick={async () => { const go = pendingNav; setPendingNav(null); await saveDraftNow(); go?.(); }}
                style={{ padding: '0.6rem', borderRadius: '6px', border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer' }}
              >
                Entwurf speichern und verlassen
              </button>
              <button
                onClick={() => { const go = pendingNav; setPendingNav(null); go?.(); }}
                style={{ padding: '0.6rem', borderRadius: '6px', border: '1px solid #b91c1c', background: '#fff', color: '#b91c1c', cursor: 'pointer' }}
              >
                Änderungen verwerfen und verlassen
              </button>
            </div>
          </div>
        </div>
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: '10px', padding: '1.5rem', maxWidth: '420px', fontFamily: 'sans-serif', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.2)' }}>
            <h3 style={{ marginTop: 0 }}>Dokument zurückziehen</h3>
            <p style={{ color: '#475569' }}>Das Dokument wird als zurückgezogen markiert. Die bisherige Version bleibt im Verlauf erhalten, gilt aber nicht mehr als aktuell.</p>
            <input
              type="text"
              placeholder="Grund (optional)"
              value={withdrawReason}
              onChange={(event) => setWithdrawReason(event.target.value)}
              style={{ width: '100%', padding: '0.5rem', border: '1px solid #cbd5e1', borderRadius: '6px', boxSizing: 'border-box', marginBottom: '1rem' }}
            />
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button onClick={() => setWithdrawOpen(false)} disabled={withdrawing} style={{ padding: '0.5rem 1rem', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#fff', cursor: 'pointer' }}>Abbrechen</button>
              <button onClick={withdrawNow} disabled={withdrawing} style={{ padding: '0.5rem 1rem', borderRadius: '6px', border: 'none', background: '#b91c1c', color: '#fff', cursor: 'pointer' }}>
                {withdrawing ? 'Wird zurückgezogen…' : 'Zurückziehen'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
