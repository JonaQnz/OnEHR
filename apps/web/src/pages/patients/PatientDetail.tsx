import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Plus, ArrowLeft, FileText, Activity } from 'lucide-react';

const API = 'http://localhost:3001/api';

export default function PatientDetail() {
  const { id } = useParams();
  const [patient, setPatient] = useState<any>(null);
  const [publishedForms, setPublishedForms] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showFormModal, setShowFormModal] = useState(false);

  useEffect(() => {
    fetch(`${API}/patients/${id}`)
      .then(r => r.json())
      .then(data => setPatient(data))
      .catch(console.error)
      .finally(() => setLoading(false));

    fetch(`${API}/forms`)
      .then(r => r.json())
      .then((data: any[]) => {
        // Group by parent_id, only latest published
        const grouped = data.reduce((acc, f) => {
          if (f.status === 'published') {
            const gid = f.parent_id || f.id;
            if (!acc[gid] || new Date(acc[gid].createdAt) < new Date(f.createdAt)) {
              acc[gid] = f;
            }
          }
          return acc;
        }, {} as Record<string, any>);
        setPublishedForms(Object.values(grouped));
      })
      .catch(console.error);
  }, [id]);

  if (loading) return <div style={{ padding: '2rem' }}>Lade Patient...</div>;
  if (!patient) return <div style={{ padding: '2rem' }}>Patient nicht gefunden.</div>;

  return (
    <div style={{ padding: '2rem', maxWidth: '1000px', margin: '0 auto' }}>
      <Link to="/patients" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-muted)', textDecoration: 'none', marginBottom: '1.5rem' }}>
        <ArrowLeft size={16} /> Zurück zur Übersicht
      </Link>
      
      <div className="card" style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <h1 style={{ margin: '0 0 0.5rem 0' }}>{patient.firstName} {patient.lastName}</h1>
            <div style={{ display: 'flex', gap: '1rem', color: 'var(--text-muted)' }}>
              <span>{patient.patientId}</span>
              <span>•</span>
              <span>{patient.birthDate ? new Date(patient.birthDate).toLocaleDateString() : 'Kein Geburtsdatum'}</span>
            </div>
            <div style={{ marginTop: '0.5rem', fontFamily: 'monospace', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
              EHR: {patient.ehrId}
            </div>
          </div>
          <div>
            <button className="btn" onClick={() => setShowFormModal(true)}>
              <Plus size={18} /> Neues Formular
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '2rem', borderBottom: '1px solid var(--border)', marginBottom: '2rem' }}>
        <div style={{ paddingBottom: '0.5rem', borderBottom: '2px solid var(--primary)', fontWeight: 600, color: 'var(--primary)', cursor: 'pointer' }}>Formulare und Dokumente</div>
        <div style={{ paddingBottom: '0.5rem', color: 'var(--text-muted)', cursor: 'pointer' }}>Übersicht</div>
        <div style={{ paddingBottom: '0.5rem', color: 'var(--text-muted)', cursor: 'pointer' }}>Daten</div>
        <div style={{ paddingBottom: '0.5rem', color: 'var(--text-muted)', cursor: 'pointer' }}>Versionen</div>
      </div>

      <div className="card">
        <div style={{ padding: '4rem 2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          <Activity size={48} style={{ opacity: 0.5, marginBottom: '1rem', margin: '0 auto' }} />
          Bisher keine Formulardaten erfasst.
          <br/>
          (TODO: Abfrage von FormSessions für diesen Patienten implementieren)
        </div>
      </div>

      {showFormModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="card" style={{ width: '100%', maxWidth: '500px', padding: '2rem', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <h2 style={{ marginTop: 0, marginBottom: '1.5rem' }}>Formular auswählen</h2>
            <div style={{ overflowY: 'auto', flex: 1, marginBottom: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {publishedForms.map(f => (
                <a key={f.id} 
                   href={`/live/${f.parent_id || f.id}?patientId=${encodeURIComponent(patient.patientId)}&returnUrl=/patients/${id}`} 
                   target="_blank" rel="noreferrer"
                   style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '1rem', border: '1px solid var(--border)', borderRadius: '6px', textDecoration: 'none', color: 'inherit', transition: 'background 0.2s' }}
                   onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.02)'}
                   onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  <FileText size={20} color="var(--primary)" />
                  <div>
                    <strong style={{ display: 'block' }}>{f.name}</strong>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Version {f.version}</span>
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
