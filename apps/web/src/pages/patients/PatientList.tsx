import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, Plus, UserRound, Settings, RefreshCw, UserCheck, UserX, FileEdit } from 'lucide-react';

const API = 'http://localhost:3001/api';

export default function PatientList() {
  const [patients, setPatients] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState('');
  const navigate = useNavigate();

  const [showSettings, setShowSettings] = useState(false);
  // Falls back to the published Stammdaten form bound to the vg_Person
  // template (parent id, so /live/ always resolves the latest version) -
  // used both for "Patient anlegen" and for "Stammdaten erfassen" on a
  // patient whose EHR has no Person composition yet.
  const [defaultFormId, setDefaultFormId] = useState(() => localStorage.getItem('defaultPatientFormId') || '237bacbe-3583-444d-8bac-adc98c18c0a8');

  const saveSettings = (newFormId: string) => {
    setDefaultFormId(newFormId);
    localStorage.setItem('defaultPatientFormId', newFormId);
  };
  const [patientId, setPatientId] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');

  const fetchPatients = async () => {
    try {
      const res = await fetch(`${API}/patients`);
      const data: unknown = await res.json().catch(() => undefined);
      if (!res.ok) throw new Error('Patienten konnten nicht geladen werden.');
      if (!Array.isArray(data)) throw new Error('Die API hat keine Patientenliste zurückgegeben.');
      setPatients(data);
      setLoadError('');
    } catch (err) {
      console.error(err);
      setPatients([]);
      setLoadError(err instanceof Error ? err.message : 'Patienten konnten nicht geladen werden.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPatients();
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMessage('');
    try {
      const res = await fetch(`${API}/patients/sync`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || data.message || 'Synchronisation fehlgeschlagen.');
      setSyncMessage(`${data.synchronized ?? 0} EHR${data.synchronized === 1 ? '' : 's'} von EHRbase abgeglichen.`);
      await fetchPatients();
    } catch (err) {
      setSyncMessage(err instanceof Error ? err.message : 'Synchronisation fehlgeschlagen.');
    } finally {
      setSyncing(false);
    }
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreateBusy(true);
    setCreateError('');
    try {
      const res = await fetch(`${API}/patients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientId, firstName, lastName, birthDate, gender })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || 'Fehler beim Erstellen');
      
      // Auto-navigate to live form for vg_Person
      navigate(`/live/${defaultFormId}?patientId=${encodeURIComponent(data.patient.patientId)}&returnUrl=/patients/${data.patient.id}`);
    } catch (err: any) {
      setCreateError(err.message);
      setCreateBusy(false);
    }
  };

  const filtered = patients.filter(p => {
    const q = searchQuery.toLowerCase();
    return (
      p.patientId.toLowerCase().includes(q) ||
      p.firstName.toLowerCase().includes(q) ||
      p.lastName.toLowerCase().includes(q) ||
      p.ehrId.toLowerCase().includes(q)
    );
  });

  // hasPersonArchetype reflects whether the last EHRbase sync actually
  // found an openEHR-EHR-CLUSTER.person.v1 (vg_Person) composition for this
  // EHR - i.e. whether firstName/lastName/birthDate/gender are genuine
  // demographics or just an "Unbekannt" placeholder. Patients without one
  // need someone to document Stammdaten (or link the EHR to the right
  // person) before the record means anything.
  const withPersonData = filtered.filter(p => p.hasPersonArchetype);
  const needsAssignment = filtered.filter(p => !p.hasPersonArchetype);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '2rem', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>Patienten</h1>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>Patientenübersicht und Akten</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-secondary" onClick={() => setShowSettings(!showSettings)} title="Einstellungen">
            <Settings size={18} />
          </button>
          <button className="btn btn-secondary" onClick={handleSync} disabled={syncing} title="Alle EHR-IDs von EHRbase abgleichen">
            <RefreshCw size={18} /> {syncing ? 'Synchronisiere…' : 'Von EHRbase synchronisieren'}
          </button>
          <button className="btn" onClick={() => setIsCreating(true)}>
            <Plus size={18} /> Patient anlegen
          </button>
        </div>
      </div>

      {syncMessage && (
        <div className="card" style={{ marginBottom: '1.5rem', color: 'var(--text-muted)' }}>
          {syncMessage}
        </div>
      )}

      {loadError && (
        <div className="card" style={{ marginBottom: '1.5rem', color: 'var(--danger-hover)', borderColor: '#fecaca' }}>
          {loadError}
        </div>
      )}

      {showSettings && (
        <div className="card" style={{ marginBottom: '1.5rem', padding: '1.5rem', backgroundColor: 'var(--bg-sidebar)' }}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Einstellungen</h3>
          <div>
            <label className="form-label">Standard Formular-ID für Patienten</label>
            <input
              type="text"
              className="form-input"
              value={defaultFormId}
              onChange={e => saveSettings(e.target.value)}
              placeholder="UUID des Formulars (z.B. 237bacbe-3583-...)"
            />
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.5rem', marginBottom: 0 }}>
              Dieses Formular wird automatisch aufgerufen, wenn ein neuer Patient angelegt wird.
            </p>
          </div>
        </div>
      )}

      <div className="card" style={{ display: 'flex', gap: '1rem', padding: '1rem 1.5rem', marginBottom: '1.5rem', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input 
            type="text" 
            placeholder="Name | Patienten-ID | Geburtsdatum | EHR-ID suchen..." 
            className="form-input" 
            style={{ paddingLeft: '2.5rem' }}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
      </div>

      {isCreating && (
        <div className="card" style={{ marginBottom: '1.5rem', padding: '1.5rem', border: '1px solid var(--primary)' }}>
          <h3 style={{ marginTop: 0, marginBottom: '1rem' }}>Neuen Patienten anlegen</h3>
          {createError && <div style={{ color: '#b91c1c', marginBottom: '1rem' }}>{createError}</div>}
          <form onSubmit={handleCreateSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <label className="form-label">Vorname *</label>
                <input required className="form-input" value={firstName} onChange={e => setFirstName(e.target.value)} />
              </div>
              <div>
                <label className="form-label">Nachname *</label>
                <input required className="form-input" value={lastName} onChange={e => setLastName(e.target.value)} />
              </div>
              <div>
                <label className="form-label">Patienten-ID *</label>
                <input required className="form-input" value={patientId} onChange={e => setPatientId(e.target.value)} placeholder="z.B. PAT-1234" />
              </div>
              <div>
                <label className="form-label">Geburtsdatum</label>
                <input type="date" className="form-input" value={birthDate} onChange={e => setBirthDate(e.target.value)} />
              </div>
              <div>
                <label className="form-label">Administratives Geschlecht</label>
                <select className="form-input" value={gender} onChange={e => setGender(e.target.value)}>
                  <option value="">Auswählen...</option>
                  <option value="male">Männlich</option>
                  <option value="female">Weiblich</option>
                  <option value="diverse">Divers</option>
                  <option value="unknown">Unbekannt</option>
                </select>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setIsCreating(false)} disabled={createBusy}>Abbrechen</button>
              <button type="submit" className="btn" disabled={createBusy}>{createBusy ? 'Speichere...' : 'Speichern & Stammdaten erfassen'}</button>
            </div>
          </form>
        </div>
      )}

      {loading ? (
        <div className="card" style={{ padding: '2rem', textAlign: 'center' }}>Lade Patienten...</div>
      ) : filtered.length === 0 ? (
        <div className="card" style={{ padding: '4rem 2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          <UserRound size={48} style={{ opacity: 0.5, marginBottom: '1rem', margin: '0 auto' }} />
          Keine Patienten gefunden.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <section>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem', color: 'var(--text-main)' }}>
              <UserCheck size={18} color="#15803d" />
              <strong>Mit Stammdaten</strong>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>({withPersonData.length}) · Person-Archetyp auf EHRbase gefunden</span>
            </div>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {withPersonData.length === 0 ? (
                <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>Keine Patienten mit erfassten Stammdaten.</div>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {withPersonData.map(p => <PatientRow key={p.id} p={p} />)}
                </ul>
              )}
            </div>
          </section>

          <section>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem', color: 'var(--text-main)' }}>
              <UserX size={18} color="#a16207" />
              <strong>Ohne Stammdaten – Zuordnung erforderlich</strong>
              <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>({needsAssignment.length}) · EHR auf EHRbase vorhanden, aber (noch) kein Person-Archetyp</span>
            </div>
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {needsAssignment.length === 0 ? (
                <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.9rem' }}>Alle EHRs haben zugeordnete Stammdaten.</div>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {needsAssignment.map(p => (
                    <PatientRow key={p.id} p={p}>
                      <Link
                        to={`/live/${defaultFormId}?patientId=${encodeURIComponent(p.patientId)}${p.patientNamespace ? `&patientNamespace=${encodeURIComponent(p.patientNamespace)}` : ''}&ehrId=${encodeURIComponent(p.ehrId)}&returnUrl=${encodeURIComponent(`/patients/${p.id}`)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="btn btn-secondary"
                        style={{ fontSize: '0.8rem', padding: '0.4rem 0.75rem', whiteSpace: 'nowrap' }}
                      >
                        <FileEdit size={14} /> Stammdaten erfassen
                      </Link>
                    </PatientRow>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function PatientRow({ p, children }: { p: any; children?: React.ReactNode }) {
  return (
    <li style={{ borderBottom: '1px solid var(--border)', transition: 'background-color 0.2s' }}
        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.02)'}
        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
      <Link to={`/patients/${p.id}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', padding: '1.25rem 1.5rem', textDecoration: 'none', color: 'inherit' }}>
        <div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
            <strong style={{ fontSize: '1.1rem', color: 'var(--text-main)' }}>{p.firstName} {p.lastName}</strong>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{p.birthDate ? new Date(p.birthDate).toLocaleDateString() : ''}</span>
            <span className="badge badge-published" style={{ background: '#f1f5f9', color: '#475569', borderColor: '#cbd5e1' }}>{p.patientId}</span>
            {p.origin === 'imported' ? (
              <span className="badge" style={{ background: '#fffbeb', color: '#a16207', borderColor: '#fde68a' }} title="Auf EHRbase gefunden, noch kein Formular in Forms erfasst">Importiert</span>
            ) : (
              <span className="badge" style={{ background: '#f0fdf4', color: '#15803d', borderColor: '#bbf7d0' }} title="In Forms angelegt bzw. bereits dokumentiert">Nativ</span>
            )}
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', gap: '1.5rem' }}>
            <span>EHR: <span style={{ fontFamily: 'monospace' }}>{p.ehrId.substring(0,8)}...</span></span>
            <span>Registriert: {new Date(p.createdAt).toLocaleDateString()}</span>
          </div>
        </div>
        {children}
      </Link>
    </li>
  );
}
