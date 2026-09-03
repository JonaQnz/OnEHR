import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { API_BASE_URL } from '../../integration/apiBaseUrl';
import {
  Activity,
  ArrowLeft,
  Bug,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  ExternalLink,
  FileText,
  FolderArchive,
  History,
  Plus,
} from 'lucide-react';
import { formEmbedUrl, isFormEmbedEvent, launchEmbeddedForm } from '../../integration/formLaunch';
import type { FormLaunchLoadPolicy, FormRuntimeMode } from 'core';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useDebugMode } from '../../hooks/useDebugMode';
import { useAuth } from '../../App';

// Code-split like every other routed page (see App.tsx's own React.lazy
// calls) - PatientDetail is visited far more often than a patient actually
// having a published Klinisches Cockpit, so this shouldn't inflate every
// patient page's bundle regardless of whether the tab ends up used.
const CompositionRuntime = lazy(() => import('../CompositionRuntime'));

const API = API_BASE_URL;

interface PatientRecord {
  id: string;
  patientId: string;
  namespace?: string;
  firstName: string;
  lastName: string;
  birthDate?: string | null;
  gender?: string | null;
  ehrId?: string | null;
  origin?: 'native' | 'imported';
  hasPersonArchetype?: boolean;
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
    sourceTemplates?: Array<{ id?: string }>;
    extensions?: Record<string, unknown>;
  };
}

type SessionStatus = 'draft' | 'in_progress' | 'ready' | 'submitted' | 'failed' | 'cancelled';

interface CompositionSessionRecord {
  id: string;
  compositionFormId: string;
  compositionVersion: string;
  patientId: string;
  patientNamespace?: string;
  ehrId?: string;
  mode: FormRuntimeMode;
  status: SessionStatus;
  progress: { total: number; started: number; ready: number; submitted: number };
  createdAt: string;
  updatedAt: string;
}

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

// Mirrors IntegrationCallLog (apps/api/prisma/schema.prisma) - raw capture
// of every outbound FHIR/openEHR write, kept for later download/curation
// into a Bruno collection. Only shown here in the "Debug" tab (see
// useDebugMode) since a real request/response body is not something a
// clinician needs to see day to day.
interface IntegrationCallLogRow {
  id: string;
  protocol: 'fhir' | 'openehr';
  resourceType: string;
  operation: string;
  method: string;
  url: string;
  statusCode: number | null;
  success: boolean;
  errorMessage: string | null;
  ehrId: string | null;
  patientId: string | null;
  fhirPatientId: string | null;
  createdAt: string;
}

interface IntegrationCallLogFull extends IntegrationCallLogRow {
  requestBody: unknown;
  responseBody: unknown;
}

function downloadJson(data: unknown, filename: string) {
  if (data === null || data === undefined) return;
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(href);
}

// Downloads whatever binary the API sends back (used for the Bruno .zip
// export - JSON.stringify isn't applicable there) and saves it under the
// filename the server proposed via Content-Disposition, falling back to a
// generic name if that header is missing.
async function downloadFile(url: string, fallbackFilename: string): Promise<void> {
  const response = await fetch(url, { credentials: 'include' });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || body.message || `Download fehlgeschlagen (${response.status})`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : fallbackFilename;
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(href);
}

interface FieldDescriptor {
  label: string;
  options: Map<string, string>;
}

type PatientTab = 'cockpit' | 'documents' | 'overview' | 'data' | 'versions' | 'kis' | 'clinicalCompositions' | 'debug';

// 'cockpit' is prepended separately in the render (only when a "Klinisches
// Cockpit" Form is actually published for this instance) rather than listed
// here statically, so installs without that Form see the tab bar exactly as
// before.
const TABS: Array<{ id: PatientTab; label: string }> = [
  { id: 'documents', label: 'Formulare und Dokumente' },
  { id: 'overview', label: 'Übersicht' },
  { id: 'data', label: 'Daten' },
  { id: 'versions', label: 'Versionen' },
  { id: 'clinicalCompositions', label: 'Klinische Compositions' },
  { id: 'kis', label: 'KIS-Arbeitsplatz' },
];

interface KisWorkflow {
  id: string;
  title: string;
  detail: string;
  templateId: string;
  mode: FormRuntimeMode;
  load: FormLaunchLoadPolicy;
}

const KIS_WORKFLOWS: KisWorkflow[] = [
  { id: 'service-request', title: 'Laborauftrag', detail: 'Neuen Auftrag für das Labor anlegen.', templateId: 'vg_ServiceRequest.v1.1.1', mode: 'create', load: 'never' },
  { id: 'specimen', title: 'Probe erfassen', detail: 'Neue Probe im Kontext eines Auftrags dokumentieren.', templateId: 'vg_Specimen.v1.0.0', mode: 'create', load: 'never' },
  { id: 'observation-lab', title: 'Laborwerte übernehmen', detail: 'Vorhandene Laborwerte laden und ergänzen.', templateId: 'vg_ObservationLab.v1.2.0', mode: 'prefill', load: 'provider' },
  { id: 'diagnostic-report', title: 'Laborbefund', detail: 'Neuen diagnostischen Laborbericht dokumentieren.', templateId: 'vg_DiagnosticReportLab.v1.1.2', mode: 'create', load: 'never' },
  { id: 'diagnosis', title: 'Diagnose', detail: 'Bestehende Diagnose laden und versioniert bearbeiten.', templateId: 'vg_Diagnosis.v1.1.1', mode: 'edit', load: 'provider' },
  { id: 'procedure', title: 'Prozedur', detail: 'Neue Prozedur dokumentieren.', templateId: 'vg_Procedure.v1.1.0', mode: 'create', load: 'never' },
  { id: 'medication-administration', title: 'Medikamentengabe', detail: 'Neue Medikamentengabe erfassen.', templateId: 'vg_MedicationAdministration.v1.0.2', mode: 'create', load: 'never' },
  { id: 'medication-statement', title: 'Medikationsplan', detail: 'Bestehenden Medikationsplan laden und versionieren.', templateId: 'vg_MedicationStatement.v1.1.0', mode: 'edit', load: 'provider' },
  { id: 'person', title: 'Stammdaten', detail: 'Personendaten aus der bestehenden Composition bearbeiten.', templateId: 'vg_Person.v1.1.1', mode: 'edit', load: 'provider' },
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

function isCompositionForm(form: StoredForm): boolean {
  return Boolean(form.canonical_json?.extensions?.['watehr.composition']);
}

function patientFormUrl(form: StoredForm, patient: PatientRecord, returnUrl: string): string {
  // Never forceNew here: this is the general "open this form for this
  // patient" launcher (the "Formular auswählen" picker), not a "start a
  // distinct new one" action - the server's own reuse logic already
  // decides correctly per mode (a plain create-mode form always gets a
  // fresh session either way; a Composition, or a form whose own default
  // mode is edit/prefill, correctly resumes an already-open session
  // instead). Forcing a new session on every click here used to spawn a
  // whole new empty Composition session - and a fresh empty child form
  // session per block - every time someone reopened the same in-progress
  // Composition, since there was previously no other reliable way back in.
  const parameters = new URLSearchParams({
    patientId: patient.patientId,
    returnUrl,
  });
  if (patient.namespace) parameters.set('patientNamespace', patient.namespace);
  if (patient.ehrId) parameters.set('ehrId', patient.ehrId);

  if (isCompositionForm(form)) {
    return `/compositions/${form.id}?${parameters.toString()}`;
  }
  return `/live/${form.parent_id || form.id}?${parameters.toString()}`;
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
  // Same permission the standalone /compositions/:id route enforces via
  // <Protected permission="form.execute">. Checked here (not by wrapping
  // the embedded CompositionRuntime in <Protected>) so a user without it
  // simply never sees the Cockpit tab, instead of the tab rendering and
  // <Protected>'s <Navigate> then yanking the whole app to "/".
  const canExecuteForms = useAuth().permissions.includes('form.execute');
  // Same permission that gates the underlying /admin/ehrbase/call-logs
  // endpoints server-side - a user without it would just get a 403, so the
  // tab is hidden rather than shown-and-failing.
  const canConfigureSystem = useAuth().permissions.includes('system.configure');
  const [debugMode] = useDebugMode();
  const showDebugTab = canConfigureSystem && debugMode;
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  useDocumentTitle(patient ? [patient.lastName, patient.firstName].filter(Boolean).join(', ') || patient.patientId : 'Patient');
  const [forms, setForms] = useState<StoredForm[]>([]);
  const [sessions, setSessions] = useState<FormSessionRecord[]>([]);
  const [compositionSessions, setCompositionSessions] = useState<CompositionSessionRecord[]>([]);
  const [clinicalCompositions, setClinicalCompositions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showFormModal, setShowFormModal] = useState(false);
  const [activeTab, setActiveTab] = useState<PatientTab>('documents');
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [selectedDataSessionId, setSelectedDataSessionId] = useState('');
  const [embeddedLaunch, setEmbeddedLaunch] = useState<{ url: string; title: string } | null>(null);
  const [launchingWorkflow, setLaunchingWorkflow] = useState<string | null>(null);
  const [callLogs, setCallLogs] = useState<IntegrationCallLogRow[]>([]);
  const [callLogsLoading, setCallLogsLoading] = useState(false);
  const [callLogsError, setCallLogsError] = useState('');
  const [expandedCallLogId, setExpandedCallLogId] = useState<string | null>(null);
  const [expandedCallLogDetail, setExpandedCallLogDetail] = useState<IntegrationCallLogFull | null>(null);
  const [expandedCallLogLoading, setExpandedCallLogLoading] = useState(false);
  const [exportingBruno, setExportingBruno] = useState<'patient' | 'all' | null>(null);
  const [exportError, setExportError] = useState('');
  const [ehrStatus, setEhrStatus] = useState<{ isQueryable: boolean; isModifiable: boolean } | null>(null);
  const [ehrStatusLoading, setEhrStatusLoading] = useState(false);
  const [ehrStatusError, setEhrStatusError] = useState('');
  const [ehrStatusSaving, setEhrStatusSaving] = useState<'isQueryable' | 'isModifiable' | null>(null);

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
        const [formData, sessionData, compSessionData, compSessionData2] = await Promise.all([
          request<StoredForm[]>('/forms', controller.signal),
          request<FormSessionRecord[]>(
            `/form-sessions?patientId=${encodeURIComponent(patientData.patientId)}`,
            controller.signal,
          ),
          request<CompositionSessionRecord[]>(
            `/composition-sessions?patientId=${encodeURIComponent(patientData.patientId)}`,
            controller.signal,
          ),
          request<any[]>(
            `/patients/${encodeURIComponent(id)}/compositions`,
            controller.signal,
          ),
        ]);
        setPatient(patientData);
        setForms(formData);
        setSessions(sessionData);
        setCompositionSessions(compSessionData);
        setClinicalCompositions(compSessionData2);
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

  // Loaded lazily (only once the Debug tab is actually opened, not on every
  // patient page visit) - these are raw request/response bodies, not
  // something worth fetching unless a debugger asked to see them.
  useEffect(() => {
    if (activeTab !== 'debug' || !showDebugTab || !patient) return undefined;
    const controller = new AbortController();
    setCallLogsLoading(true);
    setCallLogsError('');
    const params = new URLSearchParams({ limit: '100' });
    if (patient.ehrId) params.set('ehrId', patient.ehrId);
    params.set('patientId', patient.patientId);
    request<{ logs: IntegrationCallLogRow[] }>(`/admin/ehrbase/call-logs?${params.toString()}`, controller.signal)
      .then((data) => setCallLogs(data.logs))
      .catch((reason) => {
        if ((reason as Error).name !== 'AbortError') {
          setCallLogsError(reason instanceof Error ? reason.message : 'Aufrufprotokolle konnten nicht geladen werden.');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setCallLogsLoading(false); });
    return () => controller.abort();
  }, [activeTab, showDebugTab, patient]);

  // Debug mode can be switched off (from the sidebar) while its tab is
  // still active - snap back to the default tab rather than leaving an
  // active-but-now-hidden tab showing a blank panel.
  useEffect(() => {
    if (activeTab === 'debug' && !showDebugTab) setActiveTab('documents');
  }, [activeTab, showDebugTab]);

  // EHR_STATUS flags (is_queryable/is_modifiable) - same lazy-load-on-tab-
  // open pattern as the Debug tab's call logs above, admin-gated the same
  // way. EHR-wide, not per Form-Session - see ehrStatusService.ts.
  useEffect(() => {
    if (activeTab !== 'overview' || !canConfigureSystem || !patient?.ehrId) return undefined;
    const controller = new AbortController();
    setEhrStatusLoading(true);
    setEhrStatusError('');
    request<{ isQueryable: boolean; isModifiable: boolean }>(`/patients/${patient.id}/ehr-status`, controller.signal)
      .then(setEhrStatus)
      .catch((reason) => {
        if ((reason as Error).name !== 'AbortError') {
          setEhrStatusError(reason instanceof Error ? reason.message : 'EHR-Status konnte nicht geladen werden.');
        }
      })
      .finally(() => { if (!controller.signal.aborted) setEhrStatusLoading(false); });
    return () => controller.abort();
  }, [activeTab, canConfigureSystem, patient?.id, patient?.ehrId]);

  const updateEhrStatusFlag = async (flag: 'isQueryable' | 'isModifiable', value: boolean) => {
    if (!patient) return;
    if (flag === 'isModifiable' && !value) {
      const confirmed = window.confirm('Akte wirklich sperren? Damit können keine neuen Formulare/Compositions mehr für diesen Patienten abgesendet werden, bis sie wieder entsperrt wird.');
      if (!confirmed) return;
    }
    setEhrStatusSaving(flag);
    setEhrStatusError('');
    try {
      const response = await fetch(`${API}/patients/${patient.id}/ehr-status`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [flag]: value }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || body.message || `Anfrage fehlgeschlagen (${response.status})`);
      setEhrStatus(body);
    } catch (error) {
      setEhrStatusError(error instanceof Error ? error.message : 'EHR-Status konnte nicht gespeichert werden.');
    } finally {
      setEhrStatusSaving(null);
    }
  };

  const exportBrunoFolder = async (scope: 'patient' | 'all') => {
    if (!patient) return;
    setExportingBruno(scope);
    setExportError('');
    try {
      const params = new URLSearchParams();
      if (scope === 'patient') {
        if (patient.ehrId) params.set('ehrId', patient.ehrId);
        params.set('patientId', patient.patientId);
        params.set('folderName', `${patient.firstName} ${patient.lastName}`.trim() || patient.patientId);
      } else {
        params.set('folderName', 'Alle FHIR-openEHR-Aufrufe');
      }
      await downloadFile(`${API}/admin/ehrbase/call-logs/export/bruno?${params.toString()}`, 'bruno-export.zip');
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : 'Bruno-Export fehlgeschlagen.');
    } finally {
      setExportingBruno(null);
    }
  };

  const toggleCallLog = (logId: string) => {
    if (expandedCallLogId === logId) {
      setExpandedCallLogId(null);
      setExpandedCallLogDetail(null);
      return;
    }
    setExpandedCallLogId(logId);
    setExpandedCallLogDetail(null);
    setExpandedCallLogLoading(true);
    request<IntegrationCallLogFull>(`/admin/ehrbase/call-logs/${encodeURIComponent(logId)}`)
      .then(setExpandedCallLogDetail)
      .catch((reason) => setCallLogsError(reason instanceof Error ? reason.message : 'Details konnten nicht geladen werden.'))
      .finally(() => setExpandedCallLogLoading(false));
  };

  const formsById = useMemo(
    () => new Map(forms.map((form) => [form.id, form])),
    [forms],
  );

  const allSessions = useMemo(() => {
    return [
      ...sessions.map((s) => ({ ...s, type: 'form' as const })),
      ...compositionSessions.map((s) => ({ ...s, type: 'composition' as const })),
    ].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [sessions, compositionSessions]);

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

  // Only Forms (Compositions) can be started directly for a patient - a
  // bare Form Section has nowhere to hang shared/general data or widgets,
  // and the backend now rejects launching one standalone anyway (see
  // formSessionService's assertFormSectionLaunchAllowed). Form Sections
  // still show up everywhere else (session lists, template lookups) via
  // the unfiltered publishedForms/formsById - only the "start something
  // new for this patient" picker is restricted.
  const launchableForms = useMemo(
    () => publishedForms.filter(isCompositionForm),
    [publishedForms],
  );

  // Klinisches Cockpit is bound as the fixed per-patient start page - but
  // integrated as the default tab of this same page (embedded inline),
  // not a separate destination: the other tabs and the "Neues Formular"
  // picker stay visible and reachable at all times, exactly as before.
  // Matched by name (not a hardcoded form/parent id) so it keeps working
  // across republishes and even a full rebuild of the Form.
  const cockpitForm = useMemo(
    () => (canExecuteForms ? launchableForms.find((form) => form.name === 'Klinisches Cockpit') : undefined),
    [launchableForms, canExecuteForms],
  );
  // Switches to the Cockpit tab the first time it becomes available (forms
  // load asynchronously, so it's usually not there on the very first
  // render) - but only until the user has actually clicked a tab
  // themselves, so it never yanks them away from a tab they picked.
  const [userPickedTab, setUserPickedTab] = useState(false);
  useEffect(() => {
    if (!userPickedTab && cockpitForm) setActiveTab('cockpit');
  }, [cockpitForm, userPickedTab]);
  const selectTab = (tab: PatientTab) => { setUserPickedTab(true); setActiveTab(tab); };

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

  const formForTemplate = (templateId: string) => publishedForms.find(
    (form) => form.canonical_json?.sourceTemplates?.some((template) => template.id === templateId),
  );

  const launchKisWorkflow = async (workflow: KisWorkflow) => {
    if (!patient) return;
    const form = formForTemplate(workflow.templateId);
    if (!form) return;
    setLaunchingWorkflow(workflow.id);
    setError('');
    try {
      const launch = await launchEmbeddedForm({
        formId: form.id,
        patient: { id: patient.patientId, ...(patient.namespace ? { namespace: patient.namespace } : {}) },
        mode: workflow.mode,
        load: workflow.load,
        launchId: `${workflow.id}-${Date.now()}`,
      });
      setEmbeddedLaunch({ url: formEmbedUrl(launch.launchUrl), title: workflow.title });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Formular konnte nicht gestartet werden.');
    } finally {
      setLaunchingWorkflow(null);
    }
  };

  useEffect(() => {
    if (!embeddedLaunch || !patient) return undefined;
    const receiveEmbedEvent = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || !isFormEmbedEvent(event.data)) return;
      if (event.data.event === 'error' && event.data.message) setError(event.data.message);
      if (event.data.event === 'submitted') {
        setEmbeddedLaunch(null);
        void request<FormSessionRecord[]>(`/form-sessions?patientId=${encodeURIComponent(patient.patientId)}`)
          .then(setSessions)
          .catch(() => undefined);
      }
    };
    window.addEventListener('message', receiveEmbedEvent);
    return () => window.removeEventListener('message', receiveEmbedEvent);
  }, [embeddedLaunch, patient]);

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

  // The Cockpit Composition is mounted directly as a real component here -
  // NOT an iframe of the standalone /compositions/:id page. An iframe would
  // nest a second whole app page (its own header, patient-picker fallback,
  // "Zurück"-link) inside this one; rendering CompositionRuntime itself
  // means its cards, page-tabs (Übersicht, Zeitleiste, Labor...) and block
  // launches become native DOM in this tab, sharing this page's patient
  // context instead of re-deriving it behind an iframe boundary. The
  // `embedded` prop drops CompositionRuntime's own now-redundant page
  // chrome (its outer padding/max-width and "Zurück zur Patientenakte"
  // link - this tab already has both, one level up).
  const renderCockpit = (form: StoredForm) => (
    <Suspense fallback={<div className="card" style={{ padding: '2rem', color: 'var(--text-muted)' }}>Klinisches Cockpit wird geladen…</div>}>
      <CompositionRuntime
        formId={form.id}
        initialPatientId={patient.patientId}
        initialNamespace={patient.namespace}
        initialEhrId={patient.ehrId || undefined}
        embedded
      />
    </Suspense>
  );

  const renderDocuments = () => (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      {allSessions.length === 0 ? (
        <EmptyState
          icon={<Activity size={48} style={{ margin: '0 auto' }} />}
          title="Bisher keine Formulardaten erfasst."
          detail="Über „Neues Formular“ kann die erste Dokumentation gestartet werden."
        />
      ) : (
        <div>
          <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            {allSessions.length} {allSessions.length === 1 ? 'Session' : 'Sessions'}
          </div>
          {allSessions.map((session) => {
            const expanded = expandedSessionId === session.id;
            const entries = session.type === 'form' ? sessionEntries(session as FormSessionRecord) : [];
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
                      <strong style={{ display: 'block' }}>{session.type === 'form' ? formName(session as FormSessionRecord) : formsById.get((session as CompositionSessionRecord).compositionFormId)?.name || 'Composition'}</strong>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                        Version {session.type === 'form' ? (session as FormSessionRecord).formVersion : (session as CompositionSessionRecord).compositionVersion} · geändert {formatDateTime(session.updatedAt)}
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
                      {session.type === 'form' && <span>Revision: {(session as FormSessionRecord).revision}</span>}
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
                    {session.type === 'composition' && (
                      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.9rem', flexWrap: 'wrap' }}>
                        <Link
                          to={`/compositions/${(session as CompositionSessionRecord).compositionFormId}?patientId=${encodeURIComponent(patient.patientId)}&ehrId=${encodeURIComponent(session.ehrId || '')}`}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--primary)', fontSize: '0.82rem', fontWeight: 500 }}
                        >
                          Fortsetzen
                        </Link>
                      </div>
                    )}
                    {session.type === 'form' && (session as FormSessionRecord).providerReference && (
                      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.9rem', flexWrap: 'wrap' }}>
                        <a
                          href={`/live/${(session as FormSessionRecord).formId}?patientId=${encodeURIComponent(patient.patientId)}&reference=${encodeURIComponent((session as FormSessionRecord).providerReference!)}&mode=view&exactVersion=true`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--primary)', fontSize: '0.82rem', fontWeight: 500 }}
                        >
                          Ansehen
                        </a>
                        <a
                          href={`/live/${(session as FormSessionRecord).formId}?patientId=${encodeURIComponent(patient.patientId)}&reference=${encodeURIComponent((session as FormSessionRecord).providerReference!)}&mode=edit&exactVersion=true`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--primary)', fontSize: '0.82rem', fontWeight: 500 }}
                        >
                          Bearbeiten
                        </a>
                        <a
                          href={`/live/${(session as FormSessionRecord).formId}?patientId=${encodeURIComponent(patient.patientId)}&reference=${encodeURIComponent((session as FormSessionRecord).providerReference!)}&mode=prefill&exactVersion=true`}
                          target="_blank"
                          rel="noreferrer"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--primary)', fontSize: '0.82rem', fontWeight: 500 }}
                        >
                          Werte übernehmen
                        </a>
                        <a
                          href={(session as FormSessionRecord).providerReference!}
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

  const renderClinicalCompositions = () => {
    // Columns come from every row's keys, not just clinicalCompositions[0]'s
    // - a later composition with a key the first one lacks used to lose
    // that column's data entirely (header never rendered it), and cells
    // were rendered via Object.values(comp) in that row's OWN key order,
    // so a row with different keys/order than the first would misalign
    // its values under the wrong headers instead of just missing a
    // column. Looking each cell up by column key fixes both at once.
    const columns = Array.from(new Set(clinicalCompositions.flatMap((comp) => Object.keys(comp || {}))));
    return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>Klinische Compositions (aus EHRbase)</h3>
      {clinicalCompositions.length === 0 ? (
        <span style={{ color: 'var(--text-muted)' }}>Keine Compositions vorhanden.</span>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                {columns.map((key) => (
                  <th key={key} style={{ textAlign: 'left', padding: '0.5rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>{key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {clinicalCompositions.map((comp, idx) => (
                <tr key={idx} style={{ borderBottom: '1px solid var(--border)' }}>
                  {columns.map((key) => (
                    <td key={key} style={{ padding: '0.5rem' }}>{String(comp?.[key] ?? '—')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
    );
  };

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
          <div><span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Herkunft</span><strong style={{ display: 'block', marginTop: '0.2rem' }}>{patient.origin === 'imported' ? 'Importiert (aus EHRbase)' : 'Nativ (in Forms angelegt)'}</strong></div>
          <div><span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Letzte Aktivität</span><strong style={{ display: 'block', marginTop: '0.2rem' }}>{formatDateTime(latestSession?.updatedAt)}</strong></div>
        </div>
      </div>
      {canConfigureSystem && patient.ehrId && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Verwaltung</h3>
          <p style={{ margin: '0 0 0.85rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
            Wirkt auf die gesamte EHR dieses Patienten (nicht auf ein einzelnes Formular) - direkt gegen EHRbase gesetzt.
          </p>
          {ehrStatusError && <p style={{ color: 'var(--danger)', fontSize: '0.82rem', marginBottom: '0.6rem' }}>{ehrStatusError}</p>}
          {ehrStatusLoading || !ehrStatus ? (
            <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{ehrStatusLoading ? 'Lädt…' : '–'}</span>
          ) : (
            <div style={{ display: 'grid', gap: '0.6rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.85rem' }}>
                <input
                  type="checkbox"
                  checked={ehrStatus.isQueryable}
                  disabled={ehrStatusSaving === 'isQueryable'}
                  onChange={(event) => void updateEhrStatusFlag('isQueryable', event.target.checked)}
                />
                Für Auswertungen/AQL sichtbar
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.85rem' }}>
                <input
                  type="checkbox"
                  checked={ehrStatus.isModifiable}
                  disabled={ehrStatusSaving === 'isModifiable'}
                  onChange={(event) => void updateEhrStatusFlag('isModifiable', event.target.checked)}
                />
                Akte bearbeitbar (neue Compositions erlaubt)
              </label>
            </div>
          )}
        </div>
      )}
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

  const renderKis = () => (
    <div style={{ display: 'grid', gap: '1.25rem' }}>
      <div className="card" style={{ background: 'linear-gradient(135deg, #eff6ff, #fff)', borderColor: '#bfdbfe' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div><span style={{ color: 'var(--primary)', fontSize: '.78rem', fontWeight: 700, letterSpacing: '.08em' }}>KIS · PATIENTENKONTEXT</span><h3 style={{ margin: '.35rem 0' }}>{patient.firstName} {patient.lastName}</h3><span style={{ color: 'var(--text-muted)', fontSize: '.85rem' }}>{patient.patientId} · {patient.ehrId ? `EHR ${patient.ehrId.slice(0, 8)}…` : 'EHR wird aufgelöst'}</span></div>
          <div style={{ display: 'flex', gap: '.5rem', flexWrap: 'wrap' }}><span className="badge badge-published">{openCount} offene Arbeit{openCount === 1 ? '' : 'en'}</span><span className="badge badge-published" style={{ background: '#f1f5f9', color: '#475569' }}>{submittedCount} dokumentiert</span></div>
        </div>
        <p style={{ margin: '1rem 0 0', color: 'var(--text-muted)' }}>Die Aktionen starten Formulare über die öffentliche Launch-Schnittstelle mit Patienten-ID, Namespace, EHR-Kontext, Modus und Ladepolitik. Die Zuordnung erfolgt über Template-ID statt über fest kodierte Formular-IDs.</p>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, .8fr) minmax(420px, 1.6fr)', gap: '1.25rem', alignItems: 'start' }}>
        <div className="card">
          <h3 style={{ marginTop: 0, fontSize: '1rem' }}>Arbeitsliste</h3>
          {sessions.filter((session) => ['draft', 'in_progress', 'ready', 'failed'].includes(session.status)).length === 0 ? <span style={{ color: 'var(--text-muted)', fontSize: '.85rem' }}>Keine offenen Formularvorgänge.</span> : sessions.filter((session) => ['draft', 'in_progress', 'ready', 'failed'].includes(session.status)).slice(0, 5).map((session) => <div key={session.id} style={{ padding: '.7rem 0', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: '.5rem' }}><div><strong style={{ display: 'block', fontSize: '.88rem' }}>{formName(session)}</strong><span style={{ fontSize: '.75rem', color: 'var(--text-muted)' }}>{formatDateTime(session.updatedAt)}</span></div>{statusBadge(session.status)}</div>)}
          <button className="btn btn-secondary" style={{ width: '100%', justifyContent: 'center', marginTop: '1rem' }} onClick={() => selectTab('documents')}>Vorgänge öffnen</button>
        </div>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)' }}><strong>Formular-Integration</strong><div style={{ color: 'var(--text-muted)', fontSize: '.8rem', marginTop: '.25rem' }}>Einbettung im KIS, Create/Edit/Prefill und Provider-Laden</div></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '.75rem', padding: '1rem' }}>
            {KIS_WORKFLOWS.filter((workflow) => ['service-request', 'observation-lab', 'diagnosis', 'person'].includes(workflow.id)).map((workflow) => {
              const form = formForTemplate(workflow.templateId); const starting = launchingWorkflow === workflow.id;
              return <article key={workflow.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '.85rem', display: 'flex', flexDirection: 'column', gap: '.55rem' }}><strong>{workflow.title}</strong><span style={{ color: 'var(--text-muted)', fontSize: '.78rem', minHeight: '2.3rem' }}>{workflow.detail}</span><span style={{ fontSize: '.72rem', color: 'var(--text-muted)' }}>{workflow.mode} · {workflow.load === 'provider' ? 'bestehende Daten laden' : 'neuer Vorgang'}</span>{form ? <button className="btn" disabled={starting} onClick={() => void launchKisWorkflow(workflow)}><FileText size={15} /> {starting ? 'Starte…' : 'Im KIS öffnen'}</button> : <span style={{ color: '#a16207', fontSize: '.78rem' }}>Kein publiziertes Formular</span>}</article>;
            })}
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '1rem' }}>
        {KIS_WORKFLOWS.map((workflow) => {
          const form = formForTemplate(workflow.templateId);
          const starting = launchingWorkflow === workflow.id;
          return (
            <article key={workflow.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div>
                <strong style={{ display: 'block', marginBottom: '0.3rem' }}>{workflow.title}</strong>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{workflow.detail}</span>
              </div>
              <code style={{ color: 'var(--text-muted)', fontSize: '0.72rem', overflowWrap: 'anywhere' }}>{workflow.templateId}</code>
              {form ? (
                <>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{form.name} · {workflow.mode}{workflow.load === 'provider' ? ' · Provider laden' : ''}</span>
                  <button className="btn" disabled={starting} onClick={() => void launchKisWorkflow(workflow)}>
                    <FileText size={16} /> {starting ? 'Starte…' : 'Formular öffnen'}
                  </button>
                </>
              ) : (
                <span style={{ color: '#a16207', fontSize: '0.82rem' }}>Kein veröffentlichtes Formular für dieses Template zugeordnet.</span>
              )}
            </article>
          );
        })}
      </div>
      {embeddedLaunch && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '0.85rem 1rem', display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
            <strong>{embeddedLaunch.title}</strong>
            <button className="btn btn-secondary" onClick={() => setEmbeddedLaunch(null)}>Schließen</button>
          </div>
          <iframe title={embeddedLaunch.title} src={embeddedLaunch.url} style={{ width: '100%', minHeight: '760px', border: 0, display: 'block', background: '#f8fafc' }} />
        </div>
      )}
    </div>
  );

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

  const renderDebug = () => (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div className="card" style={{ background: 'linear-gradient(135deg, #fefce8, #fff)', borderColor: '#fde68a' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '.75rem', marginBottom: '.9rem' }}>
          <Bug size={20} color="#a16207" style={{ flexShrink: 0 }} />
          <span style={{ color: '#854d0e', fontSize: '.85rem' }}>
            Rohe FHIR/openEHR-Aufrufprotokolle (Request/Response) - nur ab dem Zeitpunkt der Einführung dieser Protokollierung erfasst, nicht rückwirkend.
          </span>
        </div>
        <div style={{ display: 'flex', gap: '.6rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={exportingBruno !== null || callLogs.length === 0}
            onClick={() => void exportBrunoFolder('patient')}
          >
            <FolderArchive size={14} /> {exportingBruno === 'patient' ? 'Exportiere…' : 'Diesen Patienten als Bruno-Ordner'}
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={exportingBruno !== null}
            onClick={() => void exportBrunoFolder('all')}
          >
            <FolderArchive size={14} /> {exportingBruno === 'all' ? 'Exportiere…' : 'Alle Aufrufe als Bruno-Ordner'}
          </button>
        </div>
      </div>
      {(callLogsError || exportError) && <div className="card" style={{ color: '#b91c1c' }}>{callLogsError || exportError}</div>}
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {callLogsLoading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Lade Aufrufprotokolle…</div>
        ) : callLogs.length === 0 ? (
          <EmptyState
            icon={<Bug size={48} style={{ margin: '0 auto' }} />}
            title="Keine erfassten Aufrufe für diesen Patienten."
            detail="Erst ab jetzt gemachte FHIR/openEHR-Schreibvorgänge erscheinen hier."
          />
        ) : (
          <div>
            <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              {callLogs.length} {callLogs.length === 1 ? 'Aufruf' : 'Aufrufe'}
            </div>
            {callLogs.map((log) => {
              const expanded = expandedCallLogId === log.id;
              return (
                <article key={log.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <button
                    type="button"
                    onClick={() => toggleCallLog(log.id)}
                    aria-expanded={expanded}
                    style={{
                      width: '100%', border: 0, background: expanded ? 'rgba(37, 99, 235, 0.04)' : 'transparent', color: 'inherit',
                      padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', textAlign: 'left', cursor: 'pointer',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', minWidth: 0 }}>
                      <Bug size={19} color={log.protocol === 'fhir' ? '#2563eb' : '#7c3aed'} style={{ flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <strong style={{ display: 'block' }}>{log.protocol.toUpperCase()} · {log.resourceType} · {log.operation}</strong>
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
                          {log.method} · {formatDateTime(log.createdAt)}{log.statusCode ? ` · HTTP ${log.statusCode}` : ''}
                        </span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <span
                        style={{
                          display: 'inline-flex', alignItems: 'center', padding: '0.2rem 0.55rem', borderRadius: '999px',
                          border: `1px solid ${log.success ? '#bbf7d0' : '#fecaca'}`, background: log.success ? '#f0fdf4' : '#fef2f2',
                          color: log.success ? '#15803d' : '#b91c1c', fontSize: '0.75rem', fontWeight: 600, whiteSpace: 'nowrap',
                        }}
                      >
                        {log.success ? 'Erfolgreich' : 'Fehlgeschlagen'}
                      </span>
                      <span style={{ color: 'var(--text-muted)', transform: expanded ? 'rotate(90deg)' : undefined }}>›</span>
                    </div>
                  </button>
                  {expanded && (
                    <div style={{ padding: '0 1.25rem 1.25rem 3.35rem' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem 1.5rem', color: 'var(--text-muted)', fontSize: '0.82rem', marginBottom: '1rem' }}>
                        <span>URL: <code style={{ overflowWrap: 'anywhere' }}>{log.url}</code></span>
                        {log.errorMessage && <span style={{ color: '#b91c1c' }}>Fehler: {log.errorMessage}</span>}
                      </div>
                      {expandedCallLogLoading ? (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Lade Details…</span>
                      ) : expandedCallLogDetail ? (
                        <>
                          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={expandedCallLogDetail.requestBody === null || expandedCallLogDetail.requestBody === undefined}
                              onClick={() => downloadJson(expandedCallLogDetail.requestBody, `${log.protocol}-${log.resourceType}-${log.operation}-request.json`)}
                            >
                              <Download size={14} /> Request herunterladen
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={expandedCallLogDetail.responseBody === null || expandedCallLogDetail.responseBody === undefined}
                              onClick={() => downloadJson(expandedCallLogDetail.responseBody, `${log.protocol}-${log.resourceType}-${log.operation}-response.json`)}
                            >
                              <Download size={14} /> Response herunterladen
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              onClick={() => downloadJson(expandedCallLogDetail, `${log.protocol}-${log.resourceType}-${log.operation}-full.json`)}
                            >
                              <Download size={14} /> Alles herunterladen
                            </button>
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
                            <div>
                              <strong style={{ display: 'block', fontSize: '.8rem', marginBottom: '.35rem', color: 'var(--text-muted)' }}>Request Body</strong>
                              <pre style={{ margin: 0, padding: '0.75rem', background: '#0f172a', color: '#e2e8f0', borderRadius: '6px', fontSize: '.78rem', overflow: 'auto', maxHeight: '360px' }}>
                                {expandedCallLogDetail.requestBody ? JSON.stringify(expandedCallLogDetail.requestBody, null, 2) : '–'}
                              </pre>
                            </div>
                            <div>
                              <strong style={{ display: 'block', fontSize: '.8rem', marginBottom: '.35rem', color: 'var(--text-muted)' }}>Response Body</strong>
                              <pre style={{ margin: 0, padding: '0.75rem', background: '#0f172a', color: '#e2e8f0', borderRadius: '6px', fontSize: '.78rem', overflow: 'auto', maxHeight: '360px' }}>
                                {expandedCallLogDetail.responseBody ? JSON.stringify(expandedCallLogDetail.responseBody, null, 2) : '–'}
                              </pre>
                            </div>
                          </div>
                        </>
                      ) : null}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <h1 style={{ margin: 0 }}>{patient.firstName} {patient.lastName}</h1>
              {patient.origin === 'imported' ? (
                <span className="badge" style={{ background: '#fffbeb', color: '#a16207', borderColor: '#fde68a' }} title="Auf EHRbase gefunden, noch kein Formular in Forms erfasst">Importiert</span>
              ) : (
                <span className="badge" style={{ background: '#f0fdf4', color: '#15803d', borderColor: '#bbf7d0' }} title="In Forms angelegt bzw. bereits dokumentiert">Nativ</span>
              )}
              {!patient.hasPersonArchetype && (
                <span className="badge" style={{ background: '#fef2f2', color: '#b91c1c', borderColor: '#fecaca' }} title="Kein Person-Archetyp (vg_Person) auf EHRbase gefunden - Name/Geburtsdatum ggf. nur vorläufig">Kein Person-Archetyp</span>
              )}
            </div>
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
        {(cockpitForm ? [{ id: 'cockpit' as const, label: 'Klinisches Cockpit' }, ...TABS] : TABS)
          .concat(showDebugTab ? [{ id: 'debug' as const, label: 'Debug' }] : [])
          .map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectTab(tab.id)}
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
        {activeTab === 'cockpit' && cockpitForm && renderCockpit(cockpitForm)}
        {activeTab === 'documents' && renderDocuments()}
        {activeTab === 'overview' && renderOverview()}
        {activeTab === 'data' && renderData()}
        {activeTab === 'versions' && renderVersions()}
        {activeTab === 'clinicalCompositions' && renderClinicalCompositions()}
        {activeTab === 'kis' && renderKis()}
        {activeTab === 'debug' && showDebugTab && renderDebug()}
      </div>

      {showFormModal && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' }}>
          <div className="card" style={{ width: '100%', maxWidth: '500px', padding: '2rem', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ marginTop: 0, marginBottom: '1.5rem' }}>Formular auswählen</h2>
            <div style={{ overflowY: 'auto', flex: 1, marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {launchableForms.length === 0 ? (
                <span style={{ color: 'var(--text-muted)' }}>Keine veröffentlichten Formulare verfügbar.</span>
              ) : launchableForms.map((form) => (
                <a
                  key={form.id}
                  href={patientFormUrl(form, patient, `/patients/${id}`)}
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
