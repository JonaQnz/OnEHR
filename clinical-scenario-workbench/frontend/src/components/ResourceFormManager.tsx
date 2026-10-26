import { useEffect, useState } from 'react';
import {
  addResourceFormField, listResourceForms, updateResourceFormField,
  type FhirFormField, type FhirResourceForm,
} from '../api/client';

/**
 * Spec section 30 - lists every FhirResourceForm (one per resource type in
 * use, GLOBAL across scenario runs - see api/client.ts's own note) and lets
 * a person grow one with a new field, or edit an existing field's config.
 * This is the exact same ResourceFormStore the MCP's
 * create_fhir_resource_form/update_fhir_resource_form tools call (spec
 * section 10/12) - a field added here is immediately what
 * create_fhir_resource/update_fhir_resource validate against, in the UI and
 * for an agent, with no separate path for either.
 */
const FIELD_TYPES: FhirFormField['type'][] = ['text', 'number', 'boolean', 'date', 'datetime', 'select', 'reference', 'code'];
const SOURCE_POLICIES = ['scenario', 'derived', 'generated', 'user'];

const inputStyle = { padding: '0.3rem 0.5rem', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '0.82rem' };

function FieldEditRow({ field, formId, onSaved }: { field: FhirFormField; formId: string; onSaved: (form: FhirResourceForm) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<FhirFormField>(field);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateResourceFormField(formId, field.path, {
        label: draft.label, type: draft.type, required: draft.required, editable: draft.editable, sourcePolicy: draft.sourcePolicy,
      });
      onSaved(updated);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <tr>
        <td style={{ fontFamily: 'monospace', fontSize: '0.78rem', padding: '0.3rem 0.5rem' }}>{field.path}</td>
        <td style={{ padding: '0.3rem 0.5rem' }}>{field.label}</td>
        <td style={{ padding: '0.3rem 0.5rem', color: '#64748b' }}>{field.type}</td>
        <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>{field.required ? '✓' : ''}</td>
        <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}>{field.editable ? '✓' : ''}</td>
        <td style={{ padding: '0.3rem 0.5rem', color: '#94a3b8' }}>{field.sourcePolicy}</td>
        <td style={{ padding: '0.3rem 0.5rem' }}>
          <button type="button" onClick={() => { setDraft(field); setEditing(true); }} style={{ border: 0, background: 'transparent', color: '#2563eb', cursor: 'pointer', fontSize: '0.75rem' }}>
            Bearbeiten
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td style={{ fontFamily: 'monospace', fontSize: '0.78rem', padding: '0.3rem 0.5rem' }}>{field.path}</td>
      <td style={{ padding: '0.3rem 0.5rem' }}><input style={inputStyle} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></td>
      <td style={{ padding: '0.3rem 0.5rem' }}>
        <select style={inputStyle} value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as FhirFormField['type'] })}>
          {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </td>
      <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}><input type="checkbox" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} /></td>
      <td style={{ padding: '0.3rem 0.5rem', textAlign: 'center' }}><input type="checkbox" checked={draft.editable} onChange={(e) => setDraft({ ...draft, editable: e.target.checked })} /></td>
      <td style={{ padding: '0.3rem 0.5rem' }}>
        <select style={inputStyle} value={draft.sourcePolicy} onChange={(e) => setDraft({ ...draft, sourcePolicy: e.target.value as FhirFormField['sourcePolicy'] })}>
          {SOURCE_POLICIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </td>
      <td style={{ padding: '0.3rem 0.5rem', whiteSpace: 'nowrap' }}>
        <button type="button" className="btn" disabled={saving} onClick={save} style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem', marginRight: '0.35rem' }}>{saving ? '…' : 'Speichern'}</button>
        <button type="button" disabled={saving} onClick={() => setEditing(false)} style={{ border: '1px solid #cbd5e1', background: 'white', borderRadius: '4px', padding: '0.2rem 0.6rem', fontSize: '0.75rem', cursor: 'pointer' }}>Abbrechen</button>
        {error && <div style={{ color: '#b91c1c', fontSize: '0.72rem' }}>{error}</div>}
      </td>
    </tr>
  );
}

function AddFieldForm({ formId, onAdded }: { formId: string; onAdded: (form: FhirResourceForm) => void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<FhirFormField['type']>('text');
  const [required, setRequired] = useState(false);
  const [editable, setEditable] = useState(true);
  const [sourcePolicy, setSourcePolicy] = useState<FhirFormField['sourcePolicy']>('user');
  const [referenceTypes, setReferenceTypes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const field: FhirFormField = {
        path, label, type, required, editable, sourcePolicy,
        referenceResourceTypes: type === 'reference' && referenceTypes.trim() ? referenceTypes.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      };
      const updated = await addResourceFormField(formId, field);
      onAdded(updated);
      setPath(''); setLabel(''); setType('text'); setRequired(false); setEditable(true); setSourcePolicy('user'); setReferenceTypes(''); setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} style={{ border: 0, background: 'transparent', color: '#2563eb', cursor: 'pointer', fontSize: '0.78rem', padding: '0.4rem 0' }}>
        + Feld hinzufügen
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center', padding: '0.5rem 0' }}>
      <input style={{ ...inputStyle, width: '11rem', fontFamily: 'monospace' }} placeholder="pfad.zum.feld" value={path} onChange={(e) => setPath(e.target.value)} />
      <input style={{ ...inputStyle, width: '9rem' }} placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <select style={inputStyle} value={type} onChange={(e) => setType(e.target.value as FhirFormField['type'])}>
        {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      {type === 'reference' && (
        <input style={{ ...inputStyle, width: '9rem' }} placeholder="Ziel-Typen (Komma)" value={referenceTypes} onChange={(e) => setReferenceTypes(e.target.value)} />
      )}
      <label style={{ fontSize: '0.78rem', color: '#64748b' }}><input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Pflicht</label>
      <label style={{ fontSize: '0.78rem', color: '#64748b' }}><input type="checkbox" checked={editable} onChange={(e) => setEditable(e.target.checked)} /> editierbar</label>
      <select style={inputStyle} value={sourcePolicy} onChange={(e) => setSourcePolicy(e.target.value as FhirFormField['sourcePolicy'])}>
        {SOURCE_POLICIES.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      <button type="button" className="btn" disabled={saving || !path || !label} onClick={submit} style={{ padding: '0.25rem 0.7rem', fontSize: '0.78rem' }}>{saving ? '…' : 'Hinzufügen'}</button>
      <button type="button" disabled={saving} onClick={() => setOpen(false)} style={{ border: '1px solid #cbd5e1', background: 'white', borderRadius: '4px', padding: '0.25rem 0.7rem', fontSize: '0.78rem', cursor: 'pointer' }}>Abbrechen</button>
      {error && <div style={{ color: '#b91c1c', fontSize: '0.75rem', width: '100%' }}>{error}</div>}
    </div>
  );
}

export function ResourceFormManager() {
  const [forms, setForms] = useState<FhirResourceForm[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(true);

  const load = () => {
    listResourceForms()
      .then((result) => setForms(result.forms))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(load, []);

  const replaceForm = (updated: FhirResourceForm) => {
    setForms((current) => current.map((form) => (form.id === updated.id ? updated : form)));
  };

  return (
    <section style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }} onClick={() => setCollapsed((c) => !c)}>
        <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Resource-Formulare</h2>
        <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>{collapsed ? 'einblenden' : 'ausblenden'}</span>
      </div>
      {!collapsed && (
        <div style={{ marginTop: '0.75rem' }}>
          {error && <p style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</p>}
          {forms.length === 0 && !error && <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Noch kein Resource Form angelegt.</p>}
          {forms.map((form) => (
            <div key={form.id} style={{ borderTop: '1px solid #f1f5f9', paddingTop: '0.5rem', marginTop: '0.5rem' }}>
              <button
                type="button"
                onClick={() => setExpanded((current) => (current === form.id ? null : form.id))}
                style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', width: '100%', textAlign: 'left', border: 0, background: 'transparent', cursor: 'pointer', padding: 0, fontSize: '0.9rem' }}
              >
                <strong>{form.resourceType}</strong>
                <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}>v{form.version} · {form.fields.length} Felder</span>
              </button>
              {expanded === form.id && (
                <div style={{ marginTop: '0.5rem', overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: '0.82rem', width: '100%' }}>
                    <thead>
                      <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                        <th style={{ padding: '0.2rem 0.5rem' }}>Pfad</th>
                        <th style={{ padding: '0.2rem 0.5rem' }}>Label</th>
                        <th style={{ padding: '0.2rem 0.5rem' }}>Typ</th>
                        <th style={{ padding: '0.2rem 0.5rem' }}>Pflicht</th>
                        <th style={{ padding: '0.2rem 0.5rem' }}>Editierbar</th>
                        <th style={{ padding: '0.2rem 0.5rem' }}>Quelle</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {form.fields.map((field) => (
                        <FieldEditRow key={field.path} field={field} formId={form.id} onSaved={replaceForm} />
                      ))}
                    </tbody>
                  </table>
                  <AddFieldForm formId={form.id} onAdded={replaceForm} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default ResourceFormManager;
