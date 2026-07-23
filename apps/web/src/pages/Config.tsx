import { useEffect, useState } from 'react';
import { Save, CheckCircle2, AlertCircle } from 'lucide-react';

export default function Config() {
  const [config, setConfig] = useState<any>({
    ehrbaseUrl: '',
    ehrbaseUser: '',
    ehrbasePass: '',
    authMode: 'basic',
    keycloakApi: '',
    keycloakTenantName: '',
    keycloakClientId: '',
    keycloakGrantType: 'password',
    mappingServiceApi: ''
  });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('http://localhost:3001/api/config')
      .then(res => res.json())
      .then(data => {
        setConfig(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load config:', err);
        setLoading(false);
      });
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setConfig({
      ...config,
      [e.target.name]: e.target.value
    });
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setMessage('');
    setError('');

    fetch('http://localhost:3001/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })
      .then(res => res.json())
      .then(data => {
        setConfig(data.config);
        setMessage('Configuration saved successfully!');
        setTimeout(() => setMessage(''), 4000);
      })
      .catch(err => {
        setError('Error saving configuration: ' + err.message);
      });
  };

  if (loading) return <div style={{ padding: '2rem' }}>Loading Configuration...</div>;

  return (
    <div style={{ maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, margin: '0 0 0.5rem 0', letterSpacing: '-0.02em' }}>System Settings</h1>
        <p style={{ margin: 0, color: 'var(--text-muted)' }}>Configure connections to EHRbase, Keycloak, and Mapping Services.</p>
      </div>

      {message && (
        <div className="card" style={{ backgroundColor: 'var(--success-light)', color: 'var(--success-hover)', borderColor: '#bbf7d0', marginBottom: '1.5rem', padding: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <CheckCircle2 size={20} />
          <span style={{ fontWeight: 500 }}>{message}</span>
        </div>
      )}

      {error && (
        <div className="card" style={{ backgroundColor: 'var(--danger-light)', color: 'var(--danger-hover)', borderColor: '#fecaca', marginBottom: '1.5rem', padding: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <AlertCircle size={20} />
          <span style={{ fontWeight: 500 }}>{error}</span>
        </div>
      )}

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        
        <div className="card">
          <h3 style={{ marginTop: 0, borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1.25rem', fontSize: '1.1rem' }}>openEHR Server (EHRbase)</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">EHRbase REST URL</label>
              <input type="text" name="ehrbaseUrl" value={config.ehrbaseUrl} onChange={handleChange} className="form-input" required />
            </div>
            <div>
              <label className="form-label">Authentication Mode</label>
              <select name="authMode" value={config.authMode} onChange={handleChange} className="form-input">
                <option value="basic">Basic Auth</option>
                <option value="keycloak">Keycloak OAuth2</option>
              </select>
            </div>
            {config.authMode === 'basic' && (
              <>
                <div>
                  <label className="form-label">Username</label>
                  <input type="text" name="ehrbaseUser" value={config.ehrbaseUser} onChange={handleChange} className="form-input" />
                </div>
                <div>
                  <label className="form-label">Password</label>
                  <input type="password" name="ehrbasePass" value={config.ehrbasePass} onChange={handleChange} className="form-input" placeholder="••••••••" />
                </div>
              </>
            )}
          </div>
        </div>

        {config.authMode === 'keycloak' && (
          <div className="card">
            <h3 style={{ marginTop: 0, borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1.25rem', fontSize: '1.1rem' }}>Keycloak Settings</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">Keycloak API URL</label>
                <input type="text" name="keycloakApi" value={config.keycloakApi} onChange={handleChange} className="form-input" />
              </div>
              <div>
                <label className="form-label">Tenant / Realm Name</label>
                <input type="text" name="keycloakTenantName" value={config.keycloakTenantName} onChange={handleChange} className="form-input" />
              </div>
              <div>
                <label className="form-label">Client ID</label>
                <input type="text" name="keycloakClientId" value={config.keycloakClientId} onChange={handleChange} className="form-input" />
              </div>
              <div>
                <label className="form-label">Grant Type</label>
                <input type="text" name="keycloakGrantType" value={config.keycloakGrantType} onChange={handleChange} className="form-input" />
              </div>
              <div>
                <label className="form-label">Username</label>
                <input type="text" name="ehrbaseUser" value={config.ehrbaseUser} onChange={handleChange} className="form-input" />
              </div>
              <div>
                <label className="form-label">Password</label>
                <input type="password" name="ehrbasePass" value={config.ehrbasePass} onChange={handleChange} className="form-input" placeholder="••••••••" />
              </div>
            </div>
          </div>
        )}

        <div className="card">
          <h3 style={{ marginTop: 0, borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1.25rem', fontSize: '1.1rem' }}>Interoperability & Mapping</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Mapping Service API</label>
              <input type="text" name="mappingServiceApi" value={config.mappingServiceApi} onChange={handleChange} className="form-input" />
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
          <button type="submit" className="btn" style={{ padding: '0.75rem 2rem', fontSize: '1rem' }}>
            <Save size={18} /> Save Configuration
          </button>
        </div>
      </form>
    </div>
  );
}
