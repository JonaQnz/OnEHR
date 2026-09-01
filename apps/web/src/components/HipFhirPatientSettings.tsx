import { useEffect, useMemo, useState } from 'react';
import { collectRuntimeFields, type CanonicalForm } from 'core';

export interface HipFhirPatientMappingDraft {
  insuranceNumber?: string;
  insuranceType?: string;
  firstName?: string;
  lastName?: string;
  gender?: string;
  birthDate?: string;
  street?: string;
  houseNumber?: string;
  city?: string;
  postalCode?: string;
  country?: string;
}

interface HipConnectionDraft {
  id: string;
  fhirBaseUrl?: string;
  mappingServiceBaseUrl?: string;
  fhirPatientProfile?: string;
  fhirPatientFormId?: string;
  fhirPatientMapping?: HipFhirPatientMappingDraft;
}

interface FormSummary { id: string; parent_id?: string | null; name: string; version: string; status: string; kind?: string; }
interface StoredForm { canonical_json: CanonicalForm; }
interface FieldOption { path: string; label: string; }

const API = 'http://localhost:3001/api';
const TARGETS: readonly { key: keyof HipFhirPatientMappingDraft; label: string; required?: boolean }[] = [
  { key: 'firstName', label: 'Patient.name.given', required: true },
  { key: 'lastName', label: 'Patient.name.family', required: true },
  { key: 'birthDate', label: 'Patient.birthDate' },
  { key: 'gender', label: 'Patient.gender' },
  { key: 'insuranceType', label: 'Versicherungsart (GKV/PKV)' },
  { key: 'insuranceNumber', label: 'Versichertennummer' },
  { key: 'street', label: 'Patient.address: Straße' },
  { key: 'houseNumber', label: 'Patient.address: Hausnummer' },
  { key: 'postalCode', label: 'Patient.address.postalCode' },
  { key: 'city', label: 'Patient.address.city' },
  { key: 'country', label: 'Patient.address.country (Standard DE)' },
];

export default function HipFhirPatientSettings({ connection, onChange }: {
  connection: HipConnectionDraft;
  onChange: (key: string, value: unknown) => void;
}) {
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [fields, setFields] = useState<FieldOption[]>([]);
  const [fieldError, setFieldError] = useState('');
  const mapping = connection.fhirPatientMapping || {};

  useEffect(() => {
    let active = true;
    fetch(`${API}/forms?status=published&summary=true`, { credentials: 'include' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Formulare konnten nicht geladen werden.');
        return Array.isArray(body) ? body as FormSummary[] : [];
      })
      .then((items) => { if (active) setForms(items.filter((item) => item.kind !== 'composition')); })
      .catch((error: Error) => { if (active) setFieldError(error.message); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const formId = connection.fhirPatientFormId?.trim();
    if (!formId) { setFields([]); return () => { active = false; }; }
    setFieldError('');
    fetch(`${API}/forms/parent/${encodeURIComponent(formId)}/latest-published`, { credentials: 'include' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Formularfelder konnten nicht geladen werden.');
        return body as StoredForm;
      })
      .then((stored) => {
        if (!active) return;
        setFields(collectRuntimeFields(stored.canonical_json).map((field) => ({
          path: field.repeatableGroupId ? `${field.repeatableGroupId}[0].${field.id}` : field.id,
          label: `${field.label} · ${field.aqlPath || field.id}`,
        })));
      })
      .catch((error: Error) => { if (active) { setFields([]); setFieldError(error.message); } });
    return () => { active = false; };
  }, [connection.fhirPatientFormId]);

  const formOptions = useMemo(() => {
    const seen = new Set<string>();
    return forms.filter((form) => {
      const parentId = form.parent_id || form.id;
      if (seen.has(parentId)) return false;
      seen.add(parentId);
      return true;
    });
  }, [forms]);

  const updateMapping = (key: keyof HipFhirPatientMappingDraft, value: string) => {
    onChange('fhirPatientMapping', { ...mapping, [key]: value });
  };

  return <fieldset style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 8, padding: '1rem' }}>
    <legend style={{ padding: '0 .4rem', fontWeight: 700 }}>HIP APIs und FHIR-Patientenanlage</legend>
    <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>Diese APIs verwenden denselben serverseitigen Keycloak-Token wie EHRbase. Ist HIP aktiv, wird „Patient anlegen“ ausschließlich über dieses FHIR-Mapping ausgeführt.</p>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
      <div style={{ gridColumn: '1 / -1' }}><label className="form-label">FHIR API</label><input className="form-input" type="url" value={connection.fhirBaseUrl || ''} onChange={(event) => onChange('fhirBaseUrl', event.target.value)} placeholder="https://… (Forms ergänzt /fhir/R4/Patient)" required /></div>
      <div style={{ gridColumn: '1 / -1' }}><label className="form-label">Mapping Service API (optional)</label><input className="form-input" type="url" value={connection.mappingServiceBaseUrl || ''} onChange={(event) => onChange('mappingServiceBaseUrl', event.target.value)} placeholder="https://…/mapping-service-api" /></div>
      <div style={{ gridColumn: '1 / -1' }}><label className="form-label">ISiK Patient Profile</label><input className="form-input" type="url" value={connection.fhirPatientProfile || 'https://gematik.de/fhir/isik/StructureDefinition/ISiKPatient'} onChange={(event) => onChange('fhirPatientProfile', event.target.value)} /></div>
      <div style={{ gridColumn: '1 / -1' }}><label className="form-label">Person-Formular</label><select className="form-input" value={connection.fhirPatientFormId || ''} onChange={(event) => { onChange('fhirPatientFormId', event.target.value); onChange('fhirPatientMapping', {}); }} required><option value="">Veröffentlichtes Formular auswählen…</option>{formOptions.map((form) => <option key={form.parent_id || form.id} value={form.parent_id || form.id}>{form.name} · {form.version}</option>)}</select></div>
      {TARGETS.map((target) => <div key={target.key}><label className="form-label">{target.label}{target.required ? ' *' : ''}</label><select className="form-input" value={mapping[target.key] || ''} onChange={(event) => updateMapping(target.key, event.target.value)} required={target.required}><option value="">Nicht zugeordnet</option>{fields.map((field) => <option key={`${target.key}:${field.path}`} value={field.path}>{field.label}</option>)}</select></div>)}
    </div>
    {fieldError && <p style={{ color: 'var(--danger-hover)', marginBottom: 0 }}>{fieldError}</p>}
    <p style={{ color: 'var(--text-muted)', fontSize: '.82rem', marginBottom: 0 }}>Die Versicherungsart muss im Formular den Code <code>GKV</code> oder <code>PKV</code> liefern. Ohne Länderfeld wird <code>DE</code> verwendet.</p>
  </fieldset>;
}
