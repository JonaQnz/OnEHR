import { useEffect, useState } from 'react';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import type { FormDefinitionV1, RuntimeValues } from 'core';
import FormRuntime from '../components/FormRuntime';
import { API_BASE_URL } from '../integration/apiBaseUrl';

const API = API_BASE_URL;

export default function FormRuntimePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState<any>(null);
  const [error, setError] = useState('');
  const [submittedValues, setSubmittedValues] = useState<RuntimeValues | null>(null);

  useEffect(() => {
    if (!id) return;
    fetch(`${API}/forms/${id}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Formular konnte nicht geladen werden.');
        return body;
      })
      .then(setForm)
      .catch((reason: Error) => setError(reason.message));
  }, [id]);

  if (error) return <div className="card" style={{ maxWidth: '900px', margin: '2rem auto', color: '#b91c1c' }}>{error}</div>;
  if (!form) return <p style={{ padding: '2rem' }}>Formular wird geladen…</p>;

  return <div style={{ padding: '1.5rem 1rem 3rem' }}>
    <div style={{ maxWidth: '960px', margin: '0 auto 1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
      <button className="btn btn-secondary" type="button" onClick={() => navigate(`/forms/${id}/builder`)}><ArrowLeft size={16} /> Zum Designer</button>
      <span style={{ color: '#64748b', fontSize: '0.85rem' }}>Runtime-Vorschau · keine EHRbase-Übermittlung</span>
    </div>
    <FormRuntime definition={form.canonical_json as FormDefinitionV1} submitLabel="Validieren" onSubmit={setSubmittedValues} />
    {submittedValues && <div className="card" style={{ maxWidth: '960px', margin: '1rem auto 0', borderColor: '#86efac' }}><div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', color: '#15803d', fontWeight: 600 }}><CheckCircle2 size={18} /> Formularwerte sind runtime-valid.</div><pre style={{ overflow: 'auto', marginTop: '1rem', background: '#0f172a', color: '#e2e8f0', padding: '0.75rem', borderRadius: '6px' }}>{JSON.stringify(submittedValues, null, 2)}</pre></div>}
  </div>;
}
