import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { FORM_LAUNCH_PROTOCOL_VERSION, type FormDefinitionV1, type FormEmbedEventName, type RuntimeValues, type FormSessionRuntimeContext } from 'core';
import FormRuntime, { type FormRuntimeHandle } from '../components/FormRuntime';
import PluginHost from '../components/PluginHost';

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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...options,
    credentials: 'include',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    throw error;
  }
  return body as T;
}

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

  const publishEmbedEvent = (event: FormEmbedEventName, formId: string, sessionId?: string, message?: string, height?: number) => {
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
      
      // Submit
      const submissionProviderId = form?.canonical_json?.settings?.submission?.providerId || 'ehrbase';
      const result = await request<{ session: SessionRecord; provider: ProviderResult }>(`/form-sessions/${saved.id}/provider/submit`, {
        method: 'POST', 
        body: JSON.stringify({ providerId: submissionProviderId, validatedRevision: saved.revision }) 
      });
      
      setSession(result.session);
      setDraftValues(result.session.values || values);
      runtimeRef.current?.applyValues(result.session.values || values, 'script', true);
      setSubmitted(true);
      
      if (form) publishEmbedEvent('submitted', form.id, session.id);
    } catch (e: any) {
      if (form) publishEmbedEvent('error', form.id, session.id, e.message || 'Senden fehlgeschlagen.');
      setError(e.message || 'Senden fehlgeschlagen.');
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

  // A fresh session load sets draftValues to whatever was already there -
  // that's not a user edit and shouldn't trigger a write. Only genuine
  // subsequent changes (the user actually typing) should autosave.
  const skipNextAutosave = useRef(true);
  useEffect(() => { skipNextAutosave.current = true; }, [session?.id]);

  // Read via a ref inside the timer, not the `session` state variable
  // directly: the autosave below itself updates `session.revision` on
  // success, and depending on `session` (whose identity changes on every
  // such update) would re-trigger this effect and schedule a redundant
  // autosave of the same unchanged values every 2.5s forever. Depending
  // only on `session?.id`/`mode` (stable across a revision bump) avoids that.
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  useEffect(() => {
    if (!session || submitted || busy || (session as any).mode === 'view') return;
    if (skipNextAutosave.current) { skipNextAutosave.current = false; return; }
    // Debounced whole-form save: EHRbase commits a brand-new immutable
    // VERSION on every write, so this waits for a pause in editing rather
    // than pushing on every keystroke or field blur.
    const timer = setTimeout(() => {
      const current = sessionRef.current;
      if (!current) return;
      const providerId = form?.canonical_json?.settings?.submission?.providerId || 'ehrbase';
      request<SessionRecord>(`/form-sessions/${current.id}/provider/draft`, {
        method: 'POST',
        body: JSON.stringify({ providerId, values: draftValues }),
      }).then((updated) => {
        // Only the bookkeeping revision needs to stay in sync (so the
        // eventual final submit's optimistic-concurrency check doesn't
        // spuriously conflict with what autosave already persisted) - not
        // the displayed values, which would disrupt whatever the user is
        // still typing.
        setSession((latest) => (latest && latest.id === updated.id ? { ...latest, revision: updated.revision } : latest));
      }).catch((e) => console.warn('[autosave] Draft could not be persisted to the provider (will retry on the next edit):', e));
    }, 2500);
    return () => clearTimeout(timer);
  }, [draftValues, session?.id, (session as any)?.mode, submitted, busy, form]); // eslint-disable-line react-hooks/exhaustive-deps -- reads sessionRef.current, not `session`, on purpose (see comment above)

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
                  onClick={() => {
                    const url = searchParams.get('returnUrl')!;
                    if (url.startsWith('http')) {
                      window.location.href = url;
                    } else {
                      navigate(url);
                    }
                  }} 
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
            readOnly={submitted || (session as any).mode === 'view'} 
            busy={busy} 
            submitLabel={submitted ? 'Abgesendet' : 'Absenden'} 
            showSubmit={!isEmbedded}
            onValuesChange={setDraftValues} 
            onSubmit={handleSubmit} 
            mode={(session as any).mode || 'create'}
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
        </div>
      )}
    </div>
  );
}
