import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import type { FormDefinitionV1, RuntimeValues } from 'core';
import FormRuntime from '../components/FormRuntime';
import PluginHost from '../components/PluginHost';

const API = 'http://localhost:3001/api';

interface SessionRecord {
  id: string;
  formId: string;
  patientId: string;
  status: 'draft' | 'in_progress' | 'ready' | 'submitted' | 'failed' | 'cancelled';
  values: RuntimeValues;
  revision: number;
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
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!parentId) return;
    setLoading(true);
    
    // Attempt to load the latest published version of the form
    request<FormResponse>(`/forms/parent/${encodeURIComponent(parentId)}/latest-published`)
      .then(async (formData) => {
        setForm(formData);
        
        // Extract context from URL
        const patientId = searchParams.get('patientId') || searchParams.get('ehrId');
        
        if (patientId) {
          try {
            const query = `?patientId=${encodeURIComponent(patientId)}&formId=${encodeURIComponent(formData.id)}`;
            const existing = await request<SessionRecord[]>(`/form-sessions${query}`);
            const reusable = existing.find((item) => !['submitted', 'cancelled'].includes(item.status));
            
            const current = reusable || await request<SessionRecord>('/form-sessions', {
              method: 'POST',
              body: JSON.stringify({ formId: formData.id, patientId }),
            });
            
            setSession(current);
            setDraftValues(current.values || {});
            if (current.status === 'submitted') setSubmitted(true);
            
            // Notify parent window that the form has loaded
            window.parent.postMessage({ type: 'form:loaded', formId: formData.id, sessionId: current.id }, '*');
          } catch (e: any) {
            setError(e.message || 'Session konnte nicht gestartet werden.');
          }
        }
      })
      .catch((e: any) => setError(e.message || 'Live Formular nicht gefunden oder nicht veröffentlicht.'))
      .finally(() => setLoading(false));
  }, [parentId, searchParams]);

  const handleSubmit = async (values: RuntimeValues) => {
    if (!session || busy || submitted) return;
    setBusy(true);
    try {
      // Save draft
      const saved = await request<SessionRecord>(`/form-sessions/${session.id}`, { 
        method: 'PATCH', 
        body: JSON.stringify({ values, expectedRevision: session.revision }) 
      });
      
      // Submit
      const submissionProviderId = form?.canonical_json?.settings?.submission?.providerId || 'ehrbase';
      const result = await request<{ session: SessionRecord }>(`/form-sessions/${saved.id}/provider/submit`, { 
        method: 'POST', 
        body: JSON.stringify({ providerId: submissionProviderId, validatedRevision: saved.revision }) 
      });
      
      setSession(result.session);
      setDraftValues(result.session.values || values);
      setSubmitted(true);
      
      // Notify parent iframe
      window.parent.postMessage({ type: 'form:submitted', formId: form?.id, sessionId: session.id }, '*');
    } catch (e: any) {
      setError(e.message || 'Senden fehlgeschlagen.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div style={{ padding: '2rem', textAlign: 'center', fontFamily: 'sans-serif' }}>Lade Live Formular...</div>;
  if (error) return <div style={{ padding: '2rem', color: '#b91c1c', fontFamily: 'sans-serif' }}>{error}</div>;
  if (!form) return <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>Formular nicht gefunden.</div>;

  return (
    <div style={{ width: '100vw', minHeight: '100vh', background: '#f8fafc', padding: '1rem', boxSizing: 'border-box' }}>
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
        <div style={{ maxWidth: '960px', margin: '0 auto' }}>
          {submitted && (
            <div style={{ padding: '1.5rem', marginBottom: '1.5rem', background: '#dcfce7', color: '#15803d', borderRadius: '8px', border: '1px solid #bbf7d0', fontFamily: 'sans-serif', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ fontSize: '1.1rem' }}>Formular erfolgreich abgesendet.</strong>
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
            definition={form.canonical_json} 
            initialValues={session.values} 
            patientId={session.patientId} 
            ehrId={session.patientId} 
            encounterId={searchParams.get('encounterId') || undefined}
            readOnly={submitted} 
            busy={busy} 
            submitLabel={submitted ? 'Abgesendet' : 'Absenden'} 
            onValuesChange={setDraftValues} 
            onSubmit={handleSubmit} 
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
