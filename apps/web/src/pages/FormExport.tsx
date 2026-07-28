import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

function downloadJson(data: any, filename: string) {
  if (!data) return;
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

export default function FormExport() {
  const { id } = useParams();
  const [cambio, setCambio] = useState<any>(null);
  const [mappings, setMappings] = useState<any>(null);
  const [formName, setFormName] = useState<string>('Form');

  useEffect(() => {
    // Optionally fetch the form to get its name
    fetch(`http://localhost:3001/api/forms/${id}`)
      .then(res => res.json())
      .then(data => setFormName(data.name || 'Form'))
      .catch(() => {});

    fetch(`http://localhost:3001/api/forms/${id}/export/cambio`)
      .then(async res => {
        if (!res.ok) {
          const errText = await res.text();
          try {
            return JSON.parse(errText);
          } catch {
            return { error: errText || `Export failed with status ${res.status}` };
          }
        }
        return res.json();
      })
      .then(data => setCambio(data))
      .catch(err => setCambio({ error: err.message }));
      
    fetch(`http://localhost:3001/api/forms/${id}/export/mappings`)
      .then(async res => {
        if (!res.ok) {
          const errText = await res.text();
          try {
            return JSON.parse(errText);
          } catch {
            return { error: errText || `Export failed with status ${res.status}` };
          }
        }
        return res.json();
      })
      .then(data => setMappings(data))
      .catch(err => setMappings({ error: err.message }));
  }, [id]);

  return (
    <div>
      <h1>Export Form</h1>
      
      <div style={{ display: 'flex', gap: '2rem' }}>
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            CambioForm.v1.1 JSON
            <button
              style={{ fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: '#0ea5e9', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 }}
              onClick={() => downloadJson(cambio, `${formName}_CambioForm.json`)}
              disabled={!cambio}
            >
              ⬇ Download
            </button>
          </h3>
          <pre style={{ background: '#f1f5f9', padding: '1rem', fontSize: '0.8rem', overflowX: 'auto', maxHeight: '600px' }}>
            {cambio ? JSON.stringify(cambio, null, 2) : 'Loading...'}
          </pre>
        </div>
        
        <div className="card" style={{ flex: 1 }}>
          <h3 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            openEHR Mapping JSON
            <button
              style={{ fontSize: '0.75rem', padding: '0.4rem 0.8rem', background: '#0ea5e9', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 600 }}
              onClick={() => downloadJson(mappings, `${formName}_openEHR_Mappings.json`)}
              disabled={!mappings}
            >
              ⬇ Download
            </button>
          </h3>
          <pre style={{ background: '#f1f5f9', padding: '1rem', fontSize: '0.8rem', overflowX: 'auto', maxHeight: '600px' }}>
            {mappings ? JSON.stringify(mappings, null, 2) : 'Loading...'}
          </pre>
        </div>
      </div>
    </div>
  );
}
