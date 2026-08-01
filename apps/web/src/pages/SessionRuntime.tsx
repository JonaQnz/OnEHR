import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, Download, Save, Send, UserRound } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import type { FormDefinitionV1, RuntimeValues, FormSessionRuntimeContext } from 'core';
import FormRuntime, { type FormRuntimeHandle } from '../components/FormRuntime';
import PluginHost from '../components/PluginHost';

const API = 'http://localhost:3001/api';

interface SessionRecord {
  id: string;
  formId: string;
  formVersion: string;
  patientId: string;
  patientNamespace?: string;
  ehrId?: string;
  status: 'draft' | 'in_progress' | 'ready' | 'submitted' | 'failed' | 'cancelled';
  values: RuntimeValues;
  runtimeContext: FormSessionRuntimeContext;
  validation: Array<{ path?: string; code: string; message: string }>;
  messages?: Array<{ severity: 'info' | 'warning' | 'error'; code?: string; path?: string; message: string }>;
  revision: number;
  providerReference?: string;
  updatedAt: string;
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
  if (!response.ok) { const error = new Error(body.error || `Request failed (${response.status})`) as Error & { status?: number; messages?: unknown }; error.status = response.status; error.messages = body.messages; throw error; }
  return body as T;
}

export default function SessionRuntime() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState<FormResponse | null>(null);
  const [patientId, setPatientId] = useState('');
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [draftValues, setDraftValues] = useState<RuntimeValues>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const operationRef = useRef(false);
  const runtimeRef = useRef<FormRuntimeHandle>(null);
  const beginOperation = () => {
    if (operationRef.current) return false;
    operationRef.current = true;
    setBusy(true);
    return true;
  };
  const endOperation = () => { operationRef.current = false; setBusy(false); };

  const reportError = (reason: unknown, fallback: string) => {
    const error = reason as Error & { messages?: unknown };
    const message = error instanceof Error ? error.message : fallback;
    setError(message);
    const serverMessages = Array.isArray(error.messages) ? error.messages.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).message === 'string')).map((item) => ({
      severity: (item.severity === 'warning' ? 'warning' : item.severity === 'info' ? 'info' : 'error') as 'info' | 'warning' | 'error',
      ...(typeof item.code === 'string' ? { code: item.code } : {}),
      ...(typeof item.path === 'string' ? { path: item.path } : {}),
      message: String(item.message),
    })) : [];
    const messages: NonNullable<SessionRecord['messages']> = serverMessages.length > 0 ? serverMessages : [{ severity: 'error', message }];
    setSession((current) => current ? { ...current, messages: [...(current.messages || []), ...messages] } : current);
  };
  useEffect(() => {
    if (!id) return;
    setLoading(true);
    Promise.all([
      request<FormResponse>(`/forms/${encodeURIComponent(id)}`),
      request<{ defaultEhrId?: string }>('/config').catch(() => ({ defaultEhrId: '' })),
    ])
      .then(([formData, configData]) => {
        setForm(formData);
        const resolvedId = (configData.defaultEhrId && configData.defaultEhrId.trim()) || 'patient-123';
        setPatientId(resolvedId);
        void autoStart(id, resolvedId);
      })
      .catch((reason: Error) => reportError(reason, 'Formular konnte nicht geladen werden.'))
      .finally(() => setLoading(false));
  }, [id]);

  const autoStart = async (formId: string, targetPatientId: string) => {
    if (!beginOperation()) return;
    setError('');
    setNotice('');
    try {
      const query = `?patientId=${encodeURIComponent(targetPatientId)}&formId=${encodeURIComponent(formId)}`;
      const existing = await request<SessionRecord[]>(`/form-sessions${query}`);
      const reusable = existing.find((item) => !['submitted', 'cancelled'].includes(item.status));
      const current = reusable || await request<SessionRecord>('/form-sessions', {
        method: 'POST',
        body: JSON.stringify({ formId, patientId: targetPatientId }),
      });
      setSession(current);
      setPatientId(current.patientId);
      setDraftValues(current.values || {});
      setNotice(reusable ? 'Bestehende Session geladen.' : 'Neue Session gestartet.');
    } catch (reason: any) {
      reportError(reason, 'Session konnte nicht gestartet werden.');
    } finally {
      endOperation();
    }
  };

  const startSession = async (customPatientId?: string) => {
    const pid = (customPatientId || patientId).trim();
    if (!id || !pid) {
      setError('Bitte eine Patient / EHR-ID eingeben.');
      return;
    }
    await autoStart(id, pid);
  };

  const submission = form?.canonical_json.settings?.submission;
  const n8nSubmitEnabled = submission?.mode === 'workflow'
    && submission.providerId === 'n8n'
    && submission.workflow?.enabledHooks?.submit === true;

  const submissionProviderId = n8nSubmitEnabled ? 'n8n' : 'ehrbase';
  const saveDraft = async (values = draftValues, showNotice = true): Promise<SessionRecord | null> => {
    if (!session) return null;
    const beforeSave = await runtimeRef.current?.runLifecycle('beforeSave');
    if (beforeSave?.cancelled) throw new Error(beforeSave.message || 'Das Speichern wurde vom Form Script abgebrochen.');
    const valuesToSave = runtimeRef.current?.getValues() || values;
    let updated: SessionRecord;
    try {
      updated = await request<SessionRecord>(`/form-sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ values: valuesToSave, expectedRevision: session.revision }) });
    } catch (reason: any) {
      if (reason?.status !== 409) throw reason;
      const latest = await request<SessionRecord>(`/form-sessions/${session.id}`);
      updated = await request<SessionRecord>(`/form-sessions/${session.id}`, { method: 'PATCH', body: JSON.stringify({ values: valuesToSave, expectedRevision: latest.revision }) });
    }
    setSession(updated);
    setDraftValues(updated.values || {});
    runtimeRef.current?.applyValues(updated.values || {}, 'script', true);
    await runtimeRef.current?.runLifecycle('afterSave');
    if (showNotice) setNotice('Entwurf gespeichert.');
    return updated;
  };

  const saveOnly = async () => {
    if (!beginOperation()) return;
    setError('');
    try { await saveDraft(); } catch (reason: any) { reportError(reason, 'Speichern fehlgeschlagen.'); } finally { endOperation(); }
  };

  const loadFromEhrbase = async () => {
    if (!session) return;
    if (!beginOperation()) return;
    setError('');
    setNotice('');
    try {
      const beforeLoad = await runtimeRef.current?.runLifecycle('beforeLoad');
      if (beforeLoad?.cancelled) throw new Error(beforeLoad.message || 'Das Laden wurde vom Form Script abgebrochen.');
      const loaded = await request<{ session: SessionRecord; provider: ProviderResult }>(`/form-sessions/${session.id}/provider/load`, { method: 'POST', body: JSON.stringify({ providerId: 'ehrbase' }) });
      setSession(loaded.session);
      setDraftValues(loaded.session.values || {});
      runtimeRef.current?.applyValues(loaded.session.values || {}, 'load', true);
      await runtimeRef.current?.runLifecycle('afterLoad');
      setNotice(`Werte aus EHRbase geladen${loaded.provider.metadata?.ehrId ? ` · EHR ${loaded.provider.metadata.ehrId}` : ''}.`);
    } catch (reason: any) {
      reportError(reason, 'Werte konnten nicht aus EHRbase geladen werden.');
    } finally {
      endOperation();
    }
  };

  const submitToEhrbase = async () => {
    if (!session) return;
    if (!beginOperation()) return;
    setError('');
    setNotice('');
    try {
      const saved = await saveDraft(draftValues, false);
      if (!saved) return;
      const beforeSubmit = await runtimeRef.current?.runLifecycle('beforeSubmit');
      if (beforeSubmit?.cancelled) throw new Error(beforeSubmit.message || 'Das Absenden wurde vom Form Script abgebrochen.');
      const result = await request<{ session: SessionRecord; provider: ProviderResult }>(`/form-sessions/${saved.id}/provider/submit`, { method: 'POST', body: JSON.stringify({ providerId: submissionProviderId }) });
      setSession(result.session);
      setDraftValues(result.session.values || draftValues);
      runtimeRef.current?.applyValues(result.session.values || draftValues, 'script', true);
      await runtimeRef.current?.runLifecycle('afterSubmit');
      setNotice(submissionProviderId === 'n8n'
        ? 'Session erfolgreich an n8n gesendet.'
        : `Session erfolgreich an EHRbase gesendet${result.provider.metadata?.ehrId ? ` · EHR ${result.provider.metadata.ehrId}` : ''}${result.provider.reference ? ` · ${result.provider.reference}` : ''}.`);
    } catch (reason: any) {
      reportError(reason, 'Session konnte nicht an EHRbase gesendet werden.');
    } finally {
      endOperation();
    }
  };

  const validateAndSubmit = async (values: RuntimeValues) => {
    if (!beginOperation()) return;
    setError('');
    setNotice('');
    try {
      const saved = await saveDraft(values, false);
      if (!saved) return;
      const validation = await request<{ valid: boolean; issues: SessionRecord['validation']; session: SessionRecord }>(`/form-sessions/${saved.id}/validate`, { method: 'POST' });
      if (!validation.valid) {
        setSession(validation.session);
        setError(`${validation.issues.length} Validierungsfehler müssen korrigiert werden.`);
        return;
      }
      const submitted = await request<{ session: SessionRecord; provider: ProviderResult }>(`/form-sessions/${saved.id}/provider/submit`, { method: 'POST', body: JSON.stringify({ providerId: submissionProviderId, validatedRevision: validation.session.revision }) });
      setSession(submitted.session);
      setDraftValues(submitted.session.values || values);
      setNotice(submissionProviderId === 'n8n'
        ? 'Session erfolgreich an n8n gesendet.'
        : `Session erfolgreich an EHRbase gesendet${submitted.provider.metadata?.ehrId ? ` · EHR ${submitted.provider.metadata.ehrId}` : ''}${submitted.provider.reference ? ` · ${submitted.provider.reference}` : ''}.`);
    } catch (reason: any) {
      reportError(reason, 'Session konnte nicht abgesendet werden.');
      throw reason;
    } finally {
      endOperation();
    }
  };

  if (loading) return <p style={{ padding: '2rem' }}>Formular wird geladen…</p>;
  if (!form || !id) return <div className="card" style={{ maxWidth: '900px', margin: '2rem auto', color: '#b91c1c' }}>{error || 'Formular nicht gefunden.'}</div>;

  const submitted = session?.status === 'submitted';
  return <div style={{ padding: '1.5rem 1rem 3rem' }}>
    <div style={{ maxWidth: '960px', margin: '0 auto 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
      <button className="btn btn-secondary" type="button" onClick={() => navigate(`/forms/${id}/builder`)}><ArrowLeft size={16} /> Zum Designer</button>
      <span style={{ color: '#64748b', fontSize: '0.85rem' }}>{session ? `Patient-ID: ${session.patientId}${session.ehrId ? ` · EHR-ID: ${session.ehrId}` : ''} · Status: ${session.status}` : 'Session wird gestartet…'}</span>
    </div>
    {error && <div role="alert" className="card" style={{ maxWidth: '960px', margin: '0 auto 1rem', color: '#b91c1c', borderColor: '#fecaca' }}>{error}</div>}
    {notice && <div className="card" style={{ maxWidth: '960px', margin: '0 auto 1rem', color: '#15803d', borderColor: '#bbf7d0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}><CheckCircle2 size={18} />{notice}</div>}
    {session?.messages?.map((item, index) => <div key={`${item.code || item.severity}:${index}`} className="card" style={{ maxWidth: '960px', margin: '0 auto 0.5rem', color: item.severity === 'error' ? '#b91c1c' : item.severity === 'warning' ? '#92400e' : '#1d4ed8', borderColor: item.severity === 'error' ? '#fecaca' : item.severity === 'warning' ? '#fde68a' : '#bfdbfe' }}><strong>{item.severity === 'error' ? 'Fehler' : item.severity === 'warning' ? 'Warnung' : 'Hinweis'}:</strong> {item.message}{item.path ? ` (${item.path})` : ''}</div>)}
    {!session ? <section className="card" style={{ maxWidth: '640px', margin: '2rem auto', padding: '2rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.5rem' }}><UserRound size={20} /><h1 style={{ margin: 0 }}>{form.name}</h1></div>
      <p style={{ color: '#64748b' }}>Patient / EHR-ID eingeben oder korrigieren:</p>
      <label className="form-label" htmlFor="patient-id">Patient / EHR-ID</label>
      <input id="patient-id" className="form-input" value={patientId} onChange={(event) => setPatientId(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void startSession(); }} placeholder="z. B. 838d21b7-781e-450f-9f7a-8dd2d1234567 oder patient-123" autoFocus />
      <button className="btn" type="button" disabled={busy || !patientId.trim()} onClick={() => void startSession()} style={{ marginTop: '1.25rem' }}>{busy ? 'Session wird geladen…' : 'Session starten'}</button>
    </section> : <>
      <div style={{ maxWidth: '960px', margin: '0 auto 1rem', display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="btn btn-secondary" type="button" disabled={busy || submitted} onClick={() => void loadFromEhrbase()}><Download size={16} /> Aus EHRbase laden</button>
          <button className="btn btn-secondary" type="button" disabled={busy || submitted} onClick={() => void submitToEhrbase()}><Send size={16} /> {submissionProviderId === 'n8n' ? 'An n8n senden' : 'An EHRbase senden'}</button>
        </div>
        <button className="btn btn-secondary" type="button" disabled={busy || submitted} onClick={() => void saveOnly()}><Save size={16} /> Entwurf speichern</button>
      </div>
      <FormRuntime ref={runtimeRef} definition={form.canonical_json} initialValues={session.values} patientId={session.patientId} ehrId={session.ehrId} sessionId={session.id} runtimeContext={session.runtimeContext} readOnly={submitted} busy={busy} submitLabel={submitted ? 'Abgesendet' : 'Speichern und absenden'} onValuesChange={setDraftValues} onSubmit={validateAndSubmit} mode="edit" />
      <PluginHost slot="runtime" title="Runtime-Erweiterungen" disabled={busy || submitted} context={{ formId: id, patientId: session.patientId, sessionId: session.id, form: form.canonical_json as unknown as Record<string, unknown>, data: draftValues as unknown as Record<string, unknown>, metadata: { status: session.status } }} onResult={(result) => { if (result.data) setDraftValues(result.data as RuntimeValues); if (result.message) setNotice(result.message); if (result.messages?.length) { setSession((current) => current ? { ...current, messages: [...(current.messages || []), ...result.messages!] } : current); const firstError = result.messages.find((item) => item.severity === 'error'); if (firstError) setError(firstError.message); } }} />
      {submitted && <div className="card" style={{ maxWidth: '960px', margin: '1rem auto 0', borderColor: '#86efac', color: '#15803d' }}>Diese Session wurde abgesendet und ist schreibgeschützt.</div>}
    </>}
  </div>;
}
