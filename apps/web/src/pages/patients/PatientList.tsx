import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, Plus, UserRound } from 'lucide-react';

const API = 'http://localhost:3001/api';

export default function PatientList() {
  const [patients, setPatients] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const navigate = useNavigate();

  // Create Form State
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
      const data = await res.json();
      setPatients(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPatients();
  }, []);

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
      // Based on user feedback: live/a0717dce-a9bd-4321-9715-ecc717f51579
      const personFormId = 'a0717dce-a9bd-4321-9715-ecc717f51579';
      navigate(`/live/${personFormId}?patientId=${encodeURIComponent(data.patient.patientId)}&returnUrl=/patients/${data.patient.id}`);
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '2rem', maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, margin: '0 0 0.5rem 0' }}>Patienten</h1>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>Patientenübersicht und Akten</p>
        </div>
        <button className="btn" onClick={() => setIsCreating(true)}>
          <Plus size={18} /> Patient anlegen
        </button>
      </div>

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

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>Lade Patienten...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '4rem 2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
            <UserRound size={48} style={{ opacity: 0.5, marginBottom: '1rem', margin: '0 auto' }} />
            Keine Patienten gefunden.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {filtered.map(p => (
              <li key={p.id} style={{ borderBottom: '1px solid var(--border)', transition: 'background-color 0.2s' }}
                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.02)'}
                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                <Link to={`/patients/${p.id}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '1.25rem 1.5rem', textDecoration: 'none', color: 'inherit' }}>
                  <div>
                    <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                      <strong style={{ fontSize: '1.1rem', color: 'var(--text-main)' }}>{p.firstName} {p.lastName}</strong>
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>{p.birthDate ? new Date(p.birthDate).toLocaleDateString() : ''}</span>
                      <span className="badge badge-published" style={{ background: '#f1f5f9', color: '#475569', borderColor: '#cbd5e1' }}>{p.patientId}</span>
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', gap: '1.5rem' }}>
                      <span>EHR: <span style={{ fontFamily: 'monospace' }}>{p.ehrId.substring(0,8)}...</span></span>
                      <span>Registriert: {new Date(p.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
