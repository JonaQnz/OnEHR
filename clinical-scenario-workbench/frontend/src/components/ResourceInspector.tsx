import { useEffect, useState, type CSSProperties } from 'react';
import { getEntityDetail, updateEntity, type EntityRecord, type FhirFormField } from '../api/client';

/**
 * Spec section 29 - "click a resource, see its type/provenance/references,
 * with a fitting field-by-field view" - NOT raw JSON, and NOT rendered via
 * the Form Builder (it has no concept of FHIR resources at all). Field
 * labels come from the entity's own FhirResourceForm (fetched together with
 * the live resource body via GET .../entities/:scenarioKey) - the exact
 * same field set create_fhir_resource/update_fhir_resource validate
 * against, so what's shown here always matches what the resource form
 * actually models.
 *
 * Spec section 11/37's "open an Appointment, change the time, save" is the
 * edit mode below - always a USER-provenance PUT (api/client.ts's
 * updateEntity), going through the exact same Resource Form + Blueprint
 * validation gate a scenario-driven write does (agent/planner.ts's
 * updateFhirResourceEntity on the backend), never a separate "UI edit path".
 */

const PROVENANCE_COLORS: Record<string, string> = {
  SOURCE: '#2563eb', DERIVED: '#7c3aed', GENERATED: '#b45309', USER: '#15803d',
};

function ProvenanceBadge({ provenance }: { provenance: string }) {
  const color = PROVENANCE_COLORS[provenance] ?? '#64748b';
  return (
    <span style={{ fontSize: '0.7rem', fontWeight: 600, color, border: `1px solid ${color}`, borderRadius: '999px', padding: '0.05rem 0.5rem' }}>
      {provenance}
    </span>
  );
}

function getAtPath(source: unknown, path: string): unknown {
  let cursor: any = source;
  for (const segment of path.split('.')) {
    if (cursor === undefined || cursor === null) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function asDisplayText(value: unknown): string {
  if (value === undefined || value === null || value === '') return '–';
  if (typeof value === 'object') {
    const reference = (value as { reference?: string }).reference;
    if (reference) return reference;
    return JSON.stringify(value);
  }
  return String(value);
}

// datetime-local inputs use local, timezone-less "YYYY-MM-DDTHH:mm" - every
// value this workbench actually stores/reads is a UTC ISO string, so both
// directions need a real conversion, not a substring trim.
function toDatetimeLocal(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function fromDatetimeLocal(value: string): string {
  return new Date(value).toISOString();
}

const staticFieldStyle: CSSProperties = {
  padding: '0.5rem 0.65rem',
  border: '1px solid #e2e8f0',
  borderRadius: '6px',
  fontSize: '0.85rem',
  width: '100%',
  background: '#f8fafc',
  color: '#0f172a',
};

/** Spec's own "real form, much more static than the openEHR forms" request -
 * every field is rendered as its own labeled row with a real (disabled)
 * form control matching the field's actual type, not a compact key/value
 * grid - this is what makes it read as a FORM rather than a table, while
 * staying deliberately plain/read-only (no client-side interactivity) since
 * this is a summary view, not the edit form below. */
function StaticFieldView({ field, value }: { field: FhirFormField; value: unknown }) {
  if (field.type === 'boolean') {
    return <input type="checkbox" checked={value === true} disabled style={{ width: '1.1rem', height: '1.1rem' }} />;
  }
  if (field.type === 'select' && field.options) {
    const option = field.options.find((o) => o.value === value);
    return <input style={staticFieldStyle} disabled value={option?.label ?? asDisplayText(value)} />;
  }
  if (field.type === 'datetime' || field.type === 'date') {
    return <input style={staticFieldStyle} disabled value={asDisplayText(value)} />;
  }
  return <input style={staticFieldStyle} disabled value={asDisplayText(value)} />;
}

function FieldEditor({ field, value, onChange }: { field: FhirFormField; value: unknown; onChange: (next: unknown) => void }) {
  const style = { padding: '0.3rem 0.5rem', border: '1px solid #cbd5e1', borderRadius: '4px', fontSize: '0.85rem', width: '100%' };
  if (field.type === 'reference') return <span style={{ color: '#94a3b8' }}>{asDisplayText(value)} (nicht editierbar)</span>;
  if (field.type === 'boolean') return <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  if (field.type === 'number') return <input style={style} type="number" value={typeof value === 'number' ? value : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
  if (field.type === 'date') return <input style={style} type="date" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
  if (field.type === 'datetime') return <input style={style} type="datetime-local" value={toDatetimeLocal(value)} onChange={(e) => onChange(e.target.value ? fromDatetimeLocal(e.target.value) : undefined)} />;
  if (field.type === 'select' && field.options) {
    return (
      <select style={style} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">–</option>
        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    );
  }
  return <input style={style} type="text" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} />;
}

export function ResourceInspector({ scenarioRunId, entity }: { scenarioRunId: string; entity: EntityRecord }) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getEntityDetail>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string[]>([]);

  const load = () => {
    setError(null);
    return getEntityDetail(scenarioRunId, entity.scenarioKey)
      .then((result) => setDetail(result))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(() => {
    let cancelled = false;
    getEntityDetail(scenarioRunId, entity.scenarioKey)
      .then((result) => { if (!cancelled) setDetail(result); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [scenarioRunId, entity.scenarioKey]);

  const startEditing = () => {
    if (!detail?.form) return;
    const initial: Record<string, unknown> = {};
    detail.form.fields.forEach((field) => { initial[field.path] = getAtPath(detail.resource, field.path); });
    setDraft(initial);
    setRefused([]);
    setSaveError(null);
    setEditing(true);
  };

  const save = async () => {
    if (!detail?.form) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Only the fields that actually changed - matches api/client.ts's
      // updateEntity contract (a partial values patch, merged server-side).
      const changed: Record<string, unknown> = {};
      for (const field of detail.form.fields) {
        const before = getAtPath(detail.resource, field.path);
        const after = draft[field.path];
        if (after !== before && !(before === undefined && after === '')) changed[field.path] = after;
      }
      const result = await updateEntity(scenarioRunId, entity.scenarioKey, changed);
      setRefused(result.refused);
      setEditing(false);
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" style={{ padding: '1.1rem 1.25rem', marginBottom: '0.75rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '0.7rem', marginBottom: '0.7rem', borderBottom: '1px solid #f1f5f9' }}>
        <div>
          <strong style={{ fontSize: '1rem' }}>{entity.resourceType}</strong>
          <span style={{ color: '#94a3b8', marginLeft: '0.5rem', fontSize: '0.8rem', fontFamily: 'monospace' }}>{entity.scenarioKey}</span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <ProvenanceBadge provenance={entity.provenance} />
          {!editing && detail?.form && (
            <button type="button" onClick={startEditing} style={{ border: 0, background: 'transparent', color: '#2563eb', cursor: 'pointer', fontSize: '0.78rem', fontWeight: 600 }}>
              Bearbeiten
            </button>
          )}
        </div>
      </div>
      {error && <p style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</p>}
      {!detail && !error && <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Lädt…</p>}
      {refused.length > 0 && (
        <p style={{ color: '#b45309', fontSize: '0.78rem' }}>
          Nicht übernommen (bereits durch einen höherrangigen Wert belegt): {refused.join(', ')}
        </p>
      )}
      {saveError && <p style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{saveError}</p>}

      {detail?.form && !editing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
          {detail.form.fields.map((field) => {
            const value = getAtPath(detail.resource, field.path);
            if (value === undefined && !expanded) return null;
            const fieldProvenance = entity.fieldProvenance[field.path];
            return (
              <div key={field.path}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.2rem' }}>
                  <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b' }}>{field.label}</label>
                  {fieldProvenance && (
                    <span style={{ fontSize: '0.62rem', fontWeight: 600, color: PROVENANCE_COLORS[fieldProvenance] ?? '#94a3b8' }}>{fieldProvenance}</span>
                  )}
                </div>
                <StaticFieldView field={field} value={value} />
              </div>
            );
          })}
        </div>
      )}

      {detail?.form && editing && (
        <div style={{ marginTop: '0.5rem', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.5rem 0.75rem', fontSize: '0.85rem', alignItems: 'center' }}>
          {detail.form.fields.map((field) => (
            <div key={field.path} style={{ display: 'contents' }}>
              <span style={{ color: '#64748b' }}>{field.label}{field.required && <span style={{ color: '#dc2626' }}> *</span>}</span>
              <FieldEditor field={field} value={draft[field.path]} onChange={(next) => setDraft((current) => ({ ...current, [field.path]: next }))} />
            </div>
          ))}
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}>
            <button type="button" className="btn" disabled={saving} onClick={save} style={{ padding: '0.35rem 0.9rem' }}>{saving ? '…' : 'Speichern'}</button>
            <button type="button" disabled={saving} onClick={() => setEditing(false)} style={{ border: '1px solid #cbd5e1', background: 'white', borderRadius: '6px', padding: '0.35rem 0.9rem', cursor: 'pointer' }}>Abbrechen</button>
          </div>
        </div>
      )}

      {detail?.form && !editing && (
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          style={{ marginTop: '0.5rem', border: 0, background: 'transparent', color: '#2563eb', cursor: 'pointer', fontSize: '0.78rem', padding: 0 }}
        >
          {expanded ? 'Alle Felder ausblenden' : 'Alle Felder anzeigen'}
        </button>
      )}
    </div>
  );
}

export default ResourceInspector;
