import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Database,
  ExternalLink,
  FileText,
  History,
  Plus,
} from 'lucide-react';

const API = 'http://localhost:3001/api';

interface PatientRecord {
  id: string;
  patientId: string;
  namespace?: string;
  firstName: string;
  lastName: string;
  birthDate?: string | null;
  gender?: string | null;
  ehrId?: string | null;
  createdAt: string;
}

interface FormLayoutElement {
  id?: string;
  label?: string;
  name?: string;
  options?: Array<{ value: string; text: string }>;
  children?: FormLayoutElement[];
}

interface StoredForm {
  id: string;
  parent_id?: string | null;
  name: string;
  version: string;
  status: string;
  createdAt: string;
  canonical_json?: {
    layout?: FormLayoutElement;
  };
}

type SessionStatus = 'draft' | 'in_progress' | 'ready' | 'submitted' | 'failed' | 'cancelled';

interface FormSessionRecord {
  id: string;
  formId: string;
  formVersion: string;
  patientId: string;
  patientNamespace?: string;
  ehrId?: string;
  status: SessionStatus;
  values: Record<string, unknown>;
  revision: number;
  providerId?: string;
  providerReference?: string;
  createdAt: string;
  updatedAt: string;
}

interface FieldDescriptor {
  label: string;
  options: Map<string, string>;
}

type PatientTab = 'documents' | 'overview' | 'data' | 'versions';

const TABS: Array<{ id: PatientTab; label: string }> = [
  { id: 'documents', label: 'Formulare und Dokumente' },
  { id: 'overview', label: 'Übersicht' },
  { id: 'data', label: 'Daten' },
  { id: 'versions', label: 'Versionen' },
];

const STATUS_LABELS: Record<SessionStatus, string> = {
  draft: 'Entwurf',
  in_progress: 'In Bearbeitung',
  ready: 'Bereit',
  submitted: 'Abgesendet',
  failed: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
};

const STATUS_COLORS: Record<SessionStatus, { background: string; color: string; border: string }> = {
  draft: { background: '#f8fafc', color: '#475569', border: '#cbd5e1' },
  in_progress: { background: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe' },
  ready: { background: '#fefce8', color: '#854d0e', border: '#fde68a' },
  submitted: { background: '#f0fdf4', color: '#15803d', border: '#bbf7d0' },
  failed: { background: '#fef2f2', color: '#b91c1c', border: '#fecaca' },
  cancelled: { background: '#f8fafc', color: '#64748b', border: '#cbd5e1' },
};

async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    credentials: 'include',
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || body.message || `Anfrage fehlgeschlagen (${response.status})`);
  }
  return body as T;
}

function formatDateTime(value?: string): string {
  if (!value) return '–';
  return new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function collectFieldDescriptors(
  element: FormLayoutElement | undefined,
  target = new Map<string, FieldDescriptor>(),
): Map<string, FieldDescriptor> {
  if (!element) return target;
  if (element.id) {
    target.set(element.id, {
      label: element.label || element.name || element.id,
      options: new Map((element.options || []).map((option) => [option.value, option.text])),
    });
  }
  for (const child of element.children || []) collectFieldDescriptors(child, target);
  return target;
}

function displayValue(value: unknown, descriptor?: FieldDescriptor): string {
  if (value === null || value === undefined || value === '') return '–';
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (typeof value === 'string') return descriptor?.options.get(value) || value;
  if (typeof value === 'number') return new Intl.NumberFormat('de-DE').format(value);
  if (Array.isArray(value)) {
    return value.map((item) => displayValue(item, descriptor)).join(', ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.magnitude !== undefined) {
      return `${displayValue(record.magnitude)}${record.unit ? ` ${String(record.unit)}` : ''}`;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function statusBadge(status: SessionStatus) {
  const colors = STATUS_COLORS[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '0.2rem 0.55rem',
        borderRadius: '999px',
        border: `1px solid ${colors.border}`,
        background: colors.background,
        color: colors.color,
        fontSize: '0.75rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function EmptyState({ icon, title, detail }: { icon: React.ReactNode; title: string; detail?: string }) {
  return (
    <div style={{ padding: '4rem 2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{ opacity: 0.55, marginBottom: '1rem' }}>{icon}</div>
      <strong style={{ display: 'block', color: 'var(--text-main)', marginBottom: detail ? '0.35rem' : 0 }}>
        {title}
      </strong>
      {detail && <span style={{ fontSize: '0.9rem' }}>{detail}</span>}
    </div>
  );
}

export default function PatientDetail() {
  const { id } = useParams();
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [forms, setForms] = useState<StoredForm[]>([]);
  const [sessions, setSessions] = useState<FormSessionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showFormModal, setShowFormModal] = useState(false);
  const [activeTab, setActiveTab] = useState<PatientTab>('documents');
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [selectedDataSessionId, setSelectedDataSessionId] = useState('');

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError('');
      try {
        const patientData = await request<PatientRecord>(
          `/patients/${encodeURIComponent(id)}`,
          controller.signal,
        );
        const [formData, sessionData] = await Promise.all([
          request<StoredForm[]>('/forms', controller.signal),
          request<FormSessionRecord[]>(
            `/form-sessions?patientId=${encodeURIComponent(patientData.patientId)}`,
            controller.signal,
          ),
        ]);
        setPatient(patientData);
        setForms(formData);
        setSessions(sessionData);
        const firstWithData = sessionData.find((session) => Object.keys(session.values || {}).length > 0);
        setSelectedDataSessionId(firstWithData?.id || '');
      } catch (reason) {
        if ((reason as Error).name !== 'AbortError') {
          setError(reason instanceof Error ? reason.message : 'Patientenakte konnte nicht geladen werden.');
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, [id]);

  const formsById = useMemo(
    () => new Map(forms.map((form) => [form.id, form])),
    [forms],
  );

  const publishedForms = useMemo(() => {
    const grouped = new Map<string, StoredForm>();
    for (const form of forms) {
      if (form.status !== 'published') continue;
      const groupId = form.parent_id || form.id;
      const current = grouped.get(groupId);
      if (!current || new Date(current.createdAt).getTime() < new Date(form.createdAt).getTime()) {
        grouped.set(groupId, form);
      }
    }
    return [...grouped.values()].sort((left, right) => left.name.localeCompare(right.name, 'de'));
  }, [forms]);

  const sessionsWithData = useMemo(
    () => sessions.filter((session) => Object.keys(session.values || {}).length > 0),
    [sessions],
  );

  const selectedDataSession = sessionsWithData.find(
    (session) => session.id === selectedDataSessionId,
  ) || sessionsWithData[0];

  const submittedCount = sessions.filter((session) => session.status === 'submitted').length;
  const openCount = sessions.filter((session) => ['draft', 'in_progress', 'ready'].includes(session.status)).length;
  const distinctFormCount = new Set(sessions.map((session) => session.formId)).size;
  const latestSession = sessions[0];

  const formName = (session: FormSessionRecord) => formsById.get(session.formId)?.name || 'Unbekanntes Formular';

  const sessionEntries = (session: FormSessionRecord) => {
    const descriptors = collectFieldDescriptors(formsById.get(session.formId)?.canonical_json?.layout);
    return Object.entries(session.values || {}).map(([fieldId, value]) => ({
      id: fieldId,
      label: descriptors.get(fieldId)?.label || fieldId,
      value: displayValue(value, descriptors.get(fieldId)),
    }));
  };

  if (loading) return <div style={{ padding: '2rem' }}>Lade Patientenakte…</div>;
  if (error) {
    return (
      <div style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto' }}>
        <div className="card" style={{ color: '#b91c1c' }}>{error}</div>
      </div>
    );
  }
  if (!patient) return <div style={{ padding: '2rem' }}>Patient nicht gefunden.</div>;

  const renderDocuments = () => (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {sessions.length === 0 ? (
        <EmptyState
          icon={<Activity size={48} style={{ margin: '0 auto' }} />}
          title="Bisher keine Formulardaten erfasst."
          detail="Über „Neues Formular“ kann die erste Dokumentation gestartet werden."
        />
      ) : (
        <div>
          <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {sessions.length} {sessions.length === 1 ? 'Formular-Session' : 'Formular-Sessions'}
          </div>
          {sessions.map((session) => {
            const expanded = expandedSessionId === session.id;
            const entries = sessionEntries(session);
            return (
              <article key={session.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <button
                  type="button"
                  onClick={() => setExpandedSessionId(expanded ? null : session.id)}
                  aria-expanded={expanded}
                  style={{
                    width: '100%',
                    border: 0,
                    background: expanded ? 'rgba(37, 99, 235, 0.04)' : 'transparent',
                    color: 'inherit',
                    padding: '1rem 1.25rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', minWidth: 0 }}>
                    <FileText size={21} color="var(--primary)" style={{ flexShrink: 0 }} />
                    <div style={{ minWidth: 0 }}>
                      <strong style={{ display: 'block' }}>{formName(session)}</strong>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                        Version {session.formVersion} · geändert {formatDateTime(session.updatedAt)}
                      </span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    {statusBadge(session.status)}
                    <span style={{ color: 'var(--text-muted)', transform: expanded ? 'rotate(90deg)' : undefined }}>›</span>
                  </div>
                </button>
                {expanded && (
                  <div style={{ padding: '0 1.25rem 1.25rem 3.35rem' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.5rem', color: 'var(--text-muted)', fontSize: '0.82rem', marginBottom: entries.length ? '1rem' : 0 }}>
                      <span>Session: <code>{session.id}</code></span>
                      <span>Revision: {session.revision}</span>
                      <span>{entries.length} ausgefüllte Felder</span>
                      {session.ehrId && <span>EHR: <code>{session.ehrId}</code></span>}
                    </div>
                    {entries.length > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 0.8fr) minmax(220px, 1.2fr)', border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden' }}>
                        {entries.map((entry) => (
                          <div key={entry.id} style={{ display: 'contents' }}>
                            <div style={{ padding: '0.55rem 0.75rem', background: '#f8fafc', borderBottom: '1px solid var(--border)', fontSize: '0.82rem', fontWeight: 600 }}>
                              {entry.label}
                            </div>
                            <div style={{ padding: '0.55rem 0.75rem', borderBottom: '1px solid var(--border)', fontSize: '0.85rem', overflowWrap: 'anywhere' }}>
                              {entry.value}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {session.providerReference && (
                      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.9rem', flexWrap: 'wrap' }}>
                        <a
                          href={`/live/${session.formId}?patientId=${encodeURIComponent(patient.patientId)}&reference=${encodeURIComponent(session.providerReference)}&mode=view`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--primary)', fontSize: '0.82rem', fontWeight: 500 }}
                        >
                          Ansehen
                        </a>
                        <a
                          href={`/live/${session.formId}?patientId=${encodeURIComponent(patient.patientId)}&reference=${encodeURIComponent(session.providerReference)}&mode=edit`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--primary)', fontSize: '0.82rem', fontWeight: 500 }}
                        >
                          Bearbeiten
                        </a>
                        <a
                          href={`/live/${session.formId}?patientId=${encodeURIComponent(patient.patientId)}&reference=${encodeURIComponent(session.providerReference)}&mode=prefill`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--primary)', fontSize: '0.82rem', fontWeight: 500 }}
                        >
                          Werte übernehmen
                        </a>
                        <a
                          href={session.providerReference}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--text-muted)', fontSize: '0.82rem', overflowWrap: 'anywhere' }}
                        >
                          Rohdaten ansehen <ExternalLink size={13} />
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );

  const renderOverview = () => (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: '1rem' }}>
        {[
          { label: 'Formulare', value: distinctFormCount, icon: <FileText size={19} /> },
          { label: 'Abgesendet', value: submittedCount, icon: <CheckCircle2 size={19} /> },
          { label: 'Offen', value: openCount, icon: <Clock3 size={19} /> },
          { label: 'Sessions gesamt', value: sessions.length, icon: <History size={19} /> },
        ].map((metric) => (
          <div key={metric.label} className="card" style={{ padding: '1.1rem 1.25rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
              {metric.icon} {metric.label}
            </div>
            <strong style={{ display: 'block', fontSize: '1.75rem', marginTop: '0.5rem' }}>{metric.value}</strong>
          </div>
        ))}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Patientenakte</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
          <div><span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Patienten-ID</span><strong style={{ display: 'block', marginTop: '0.2rem' }}>{patient.patientId}</strong></div>
          <div><span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Namensraum</span><strong style={{ display: 'block', marginTop: '0.2rem' }}>{patient.namespace || 'default'}</strong></div>
          <div><span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>EHR-ID</span><code style={{ display: 'block', marginTop: '0.2rem', overflowWrap: 'anywhere' }}>{patient.ehrId || 'Nicht hinterlegt'}</code></div>
          <div><span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Letzte Aktivität</span><strong style={{ display: 'block', marginTop: '0.2rem' }}>{formatDateTime(latestSession?.updatedAt)}</strong></div>
        </div>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Letzte Aktivitäten</h3>
        {sessions.length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>Noch keine Aktivitäten vorhanden.</span>
        ) : sessions.slice(0, 5).map((session) => (
          <div key={session.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.75rem 0', borderTop: '1px solid var(--border)' }}>
            <div>
              <strong>{formName(session)}</strong>
              <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>{formatDateTime(session.updatedAt)}</div>
            </div>
            {statusBadge(session.status)}
          </div>
        ))}
      </div>
    </div>
  );

  const renderData = () => {
    if (!selectedDataSession) {
      return (
        <div className="card">
          <EmptyState
            icon={<Database size={48} style={{ margin: '0 auto' }} />}
            title="Keine Formulardaten vorhanden."
            detail="Entwürfe ohne Werte werden hier nicht angezeigt."
          />
        </div>
      );
    }
    const entries = sessionEntries(selectedDataSession);
    return (
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
          <div>
            <h3 style={{ margin: '0 0 0.3rem' }}>Erfasste Daten</h3>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              Werte aus einer konkreten Formular-Session
            </span>
          </div>
          <div style={{ minWidth: '300px', maxWidth: '100%' }}>
            <label className="form-label" htmlFor="patient-data-session">Formularstand</label>
            <select
              id="patient-data-session"
              className="form-input"
              value={selectedDataSession.id}
              onChange={(event) => setSelectedDataSessionId(event.target.value)}
            >
              {sessionsWithData.map((session) => (
                <option key={session.id} value={session.id}>
                  {formName(session)} · v{session.formVersion} · {formatDateTime(session.updatedAt)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 0.8fr) minmax(240px, 1.2fr)', border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden' }}>
          {entries.map((entry) => (
            <div key={entry.id} style={{ display: 'contents' }}>
              <div style={{ padding: '0.75rem', background: '#f8fafc', borderBottom: '1px solid var(--border)', fontWeight: 600, fontSize: '0.85rem' }}>
                {entry.label}
              </div>
              <div style={{ padding: '0.75rem', borderBottom: '1px solid var(--border)', overflowWrap: 'anywhere' }}>
                {entry.value}
              </div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.5rem', marginTop: '1rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
          <span>Status: {STATUS_LABELS[selectedDataSession.status]}</span>
          <span>Revision: {selectedDataSession.revision}</span>
          <span>Session: <code>{selectedDataSession.id}</code></span>
        </div>
      </div>
    );
  };

  const renderVersions = () => (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {sessions.length === 0 ? (
        <EmptyState
          icon={<History size={48} style={{ margin: '0 auto' }} />}
          title="Keine Versionen vorhanden."
        />
      ) : (
        <>
          <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)' }}>
            <strong>Gespeicherte Formularstände</strong>
            <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.25rem' }}>
              Formularversion und aktuelle Session-Revision
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '720px' }}>
              <thead>
                <tr style={{ background: '#f8fafc', textAlign: 'left', color: 'var(--text-muted)', fontSize: '0.78rem' }}>
                  <th style={{ padding: '0.7rem 1rem' }}>Formular</th>
                  <th style={{ padding: '0.7rem 1rem' }}>Version</th>
                  <th style={{ padding: '0.7rem 1rem' }}>Revision</th>
                  <th style={{ padding: '0.7rem 1rem' }}>Status</th>
                  <th style={{ padding: '0.7rem 1rem' }}>Erstellt</th>
                  <th style={{ padding: '0.7rem 1rem' }}>Geändert</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((session) => (
                  <tr key={session.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '0.8rem 1rem', fontWeight: 600 }}>{formName(session)}</td>
                    <td style={{ padding: '0.8rem 1rem' }}>v{session.formVersion}</td>
                    <td style={{ padding: '0.8rem 1rem' }}>r{session.revision}</td>
                    <td style={{ padding: '0.8rem 1rem' }}>{statusBadge(session.status)}</td>
                    <td style={{ padding: '0.8rem 1rem', color: 'var(--text-muted)', fontSize: '0.82rem' }}>{formatDateTime(session.createdAt)}</td>
                    <td style={{ padding: '0.8rem 1rem', color: 'var(--text-muted)', fontSize: '0.82rem' }}>{formatDateTime(session.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px', margin: '0 auto' }}>
      <Link
        to="/patients"
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '1.5rem' }}
      >
        <ArrowLeft size={16} /> Zurück zur Übersicht
      </Link>

      <div className="card" style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: '0 0 0.5rem 0' }}>{patient.firstName} {patient.lastName}</h1>
            <div style={{ display: 'flex', gap: '1rem', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              <span>{patient.patientId}</span>
              <span>•</span>
              <span>{patient.birthDate ? new Date(patient.birthDate).toLocaleDateString('de-DE') : 'Kein Geburtsdatum'}</span>
            </div>
            <div style={{ marginTop: '0.5rem', fontFamily: 'monospace', color: 'var(--text-muted)', fontSize: '0.85rem', overflowWrap: 'anywhere' }}>
              EHR: {patient.ehrId || 'Nicht hinterlegt'}
            </div>
          </div>
          <button className="btn" onClick={() => setShowFormModal(true)}>
            <Plus size={18} /> Neues Formular
          </button>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Bereiche der Patientenakte"
        style={{ display: 'flex', gap: '1.75rem', borderBottom: '1px solid var(--border)', marginBottom: '2rem', overflowX: 'auto' }}
      >
        {TABS.map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: '0 0 0.65rem',
                border: 0,
                borderBottom: active ? '2px solid var(--primary)' : '2px solid transparent',
                background: 'transparent',
                fontWeight: active ? 600 : 500,
                color: active ? 'var(--primary)' : 'var(--text-muted)',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        {activeTab === 'documents' && renderDocuments()}
        {activeTab === 'overview' && renderOverview()}
        {activeTab === 'data' && renderData()}
        {activeTab === 'versions' && renderVersions()}
      </div>

      {showFormModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
          <div className="card" style={{ width: '100%', maxWidth: '500px', padding: '2rem', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ marginTop: 0, marginBottom: '1.5rem' }}>Formular auswählen</h2>
            <div style={{ overflowY: 'auto', flex: 1, marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {publishedForms.length === 0 ? (
                <span style={{ color: 'var(--text-muted)' }}>Keine veröffentlichten Formulare verfügbar.</span>
              ) : publishedForms.map((form) => (
                <a
                  key={form.id}
                  href={`/live/${form.parent_id || form.id}?patientId=${encodeURIComponent(patient.patientId)}&mode=create&returnUrl=${encodeURIComponent(`/patients/${id}`)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1rem', border: '1px solid var(--border)', borderRadius: '6px', textDecoration: 'none', color: 'inherit' }}
                >
                  <FileText size={20} color="var(--primary)" />
                  <div>
                    <strong style={{ display: 'block' }}>{form.name}</strong>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Version {form.version}</span>
                  </div>
                </a>
              ))}
            </div>
            <button className="btn btn-secondary" onClick={() => setShowFormModal(false)}>Schließen</button>
          </div>
        </div>
      )}
    </div>
  );
}
