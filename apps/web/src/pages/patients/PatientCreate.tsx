import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import type { CanonicalForm, RuntimeValues } from 'core';
import FormRuntime from '../../components/FormRuntime';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { API_BASE_URL } from '../../integration/apiBaseUrl';

type CreationConfiguration = { mode: 'ehrbase' | 'fhir'; configured: boolean; formId?: string; error?: string };
type StoredForm = { id: string; name: string; version: string; canonical_json: CanonicalForm };

export default function PatientCreate() {
  useDocumentTitle('Patient anlegen');
  const navigate = useNavigate();
  const [configuration, setConfiguration] = useState<CreationConfiguration>();
  const [form, setForm] = useState<StoredForm>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const configResponse = await fetch(`${API_BASE_URL}/patients/creation/config`, { credentials: 'include' });
        const config = await configResponse.json() as CreationConfiguration & { error?: string };
        if (!configResponse.ok) throw new Error(config.error || 'Patientenanlage konnte nicht initialisiert werden.');
        if (!active) return;
        setConfiguration(config);
        if (config.mode !== 'fhir') { navigate('/patients', { replace: true }); return; }
        if (!config.configured || !config.formId) throw new Error(config.error || 'HIP FHIR-Patientenanlage ist nicht vollständig konfiguriert.');
        const formResponse = await fetch(`${API_BASE_URL}/forms/parent/${encodeURIComponent(config.formId)}/latest-published`, { credentials: 'include' });
        const stored = await formResponse.json() as StoredForm & { error?: string };
        if (!formResponse.ok) throw new Error(stored.error || 'Das konfigurierte Person-Formular konnte nicht geladen werden.');
        if (active) setForm(stored);
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Patientenanlage konnte nicht geladen werden.');
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => { active = false; };
  }, [navigate]);

  const submit = async (values: RuntimeValues) => {
    if (!configuration?.formId || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`${API_BASE_URL}/patients`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ formId: configuration.formId, values }),
      });
      const body = await response.json() as { fhirPatientId?: string; error?: string; message?: string; details?: { messages?: Array<{ message?: string }> } };
      if (!response.ok || !body.fhirPatientId) {
        const detail = body.details?.messages?.map((item) => item.message).filter(Boolean).join('; ');
        throw new Error(detail || body.error || body.message || 'FHIR Patient konnte nicht angelegt werden.');
      }
      navigate('/patients', { replace: true, state: { message: `FHIR Patient ${body.fhirPatientId} wurde von der HIP bestätigt. Die Patientenliste wird aus HIP/EHRbase aktualisiert.` } });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'FHIR Patient konnte nicht angelegt werden.');
      setBusy(false);
    }
  };

  return <div style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
    <Link to="/patients" style={{ display: 'inline-flex', alignItems: 'center', gap: '.5rem', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '1.5rem' }}><ArrowLeft size={16} /> Zurück zur Patientenübersicht</Link>
    {loading && <div className="card">HIP FHIR-Patientenanlage wird geladen…</div>}
    {error && <div className="card" style={{ color: 'var(--danger-hover)', borderColor: '#fecaca', marginBottom: '1rem' }}>{error}</div>}
    {form && <div className="card">
      <div style={{ marginBottom: '1rem' }}><span className="badge badge-published">HIP · FHIR R4 · ISiK Patient</span><p style={{ color: 'var(--text-muted)', marginBottom: 0 }}>Dieses bestehende Person-Formular wird validiert und anschließend als FHIR Patient an die aktive HIP übertragen. Es wird in diesem Schritt keine openEHR-Composition angelegt.</p></div>
      <FormRuntime definition={form.canonical_json} busy={busy} mode="create" submitLabel={busy ? 'FHIR Patient wird angelegt…' : 'FHIR Patient anlegen'} onSubmit={submit} chromeless />
    </div>}
  </div>;
}
