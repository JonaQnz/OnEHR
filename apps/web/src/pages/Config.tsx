import { useEffect, useState } from 'react';
import { Save, CheckCircle2, AlertCircle, Plus, Trash2 } from 'lucide-react';
import PluginSettingsHost from '../components/PluginSettingsHost';

type ConnectionDraft = {
  id: string;
  name: string;
  url: string;
  authPlugin: 'none' | 'basic' | 'hip-keycloak';
  username?: string;
  password?: string;
  keycloakBaseUrl?: string;
  keycloakRealm?: string;
  keycloakClientId?: string;
  keycloakGrantType?: string;
  subjectNamespace?: string;
  defaultEhrId?: string;
};

export default function Config() {
  const [config, setConfig] = useState<any>({
    ehrbaseConnections: [],
    activeEhrbaseConnectionId: '',
    userAuthMode: 'local',
    localUsername: '',
    localPassword: '',
    hipIssuerUrl: '',
    hipClientId: '',
    hipRedirectUri: 'http://localhost:3001/api/auth/callback/hip',
    hipScopes: 'openid profile email',
    keycloakApi: '',
    keycloakTenantName: '',
    keycloakClientId: '',
    keycloakGrantType: 'password',
    mappingServiceApi: '',
    defaultEhrId: '',
    scriptAiBaseUrl: '',
    scriptAiApiKey: '',
    scriptAiModel: ''
  });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('http://localhost:3001/api/config', { credentials: 'include' })
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

  const connections: ConnectionDraft[] = Array.isArray(config.ehrbaseConnections) ? config.ehrbaseConnections : [];
  const updateConnection = (id: string, key: keyof ConnectionDraft, value: string) => {
    setConfig({ ...config, ehrbaseConnections: connections.map((connection) => connection.id === id ? { ...connection, [key]: value } : connection) });
  };
  const addConnection = () => {
    if (connections.length >= 2) return;
    const id = `ehrbase-${Date.now()}`;
    const connection: ConnectionDraft = { id, name: connections.length === 0 ? 'Testsystem' : 'Livesystem', url: '', authPlugin: 'none', subjectNamespace: 'default' };
    setConfig({ ...config, ehrbaseConnections: [...connections, connection], activeEhrbaseConnectionId: config.activeEhrbaseConnectionId || id });
  };
  const removeConnection = (id: string) => {
    if (connections.length <= 1) return;
    const remaining = connections.filter((connection) => connection.id !== id);
    setConfig({ ...config, ehrbaseConnections: remaining, activeEhrbaseConnectionId: config.activeEhrbaseConnectionId === id ? remaining[0].id : config.activeEhrbaseConnectionId });
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    setMessage('');
    setError('');

    fetch('http://localhost:3001/api/config', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
      })
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

        <div className="card">
          <h3 style={{ marginTop: 0, borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1.25rem', fontSize: '1.1rem' }}>Forms App Access</h3>
          <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>Choose local sign-in or HIP sign-in. Patient access remains with the HIP.</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
            <div>
              <label className="form-label">User authentication</label>
              <select name="userAuthMode" value={config.userAuthMode || 'local'} onChange={handleChange} className="form-input">
                <option value="local">Local login</option>
                <option value="hip">HIP login</option>
              </select>
            </div>
            {config.userAuthMode === 'local' && (
              <div>
                <label className="form-label">Local username</label>
                <input type="text" name="localUsername" value={config.localUsername || ''} onChange={handleChange} className="form-input" placeholder="Set via environment" />
              </div>
            )}
          </div>
          {config.userAuthMode === 'hip' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem', marginTop: '1.25rem' }}>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">HIP issuer URL</label>
                <input type="url" name="hipIssuerUrl" value={config.hipIssuerUrl || ''} onChange={handleChange} className="form-input" />
              </div>
              <div>
                <label className="form-label">Client ID</label>
                <input type="text" name="hipClientId" value={config.hipClientId || ''} onChange={handleChange} className="form-input" />
              </div>
              <div>
                <label className="form-label">Redirect URI</label>
                <input type="url" name="hipRedirectUri" value={config.hipRedirectUri || ''} onChange={handleChange} className="form-input" />
              </div>
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="form-label">Scopes</label>
                <input type="text" name="hipScopes" value={config.hipScopes || ''} onChange={handleChange} className="form-input" />
              </div>
            </div>
          )}
        </div>
      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h3 style={{ marginTop: 0, borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1.25rem', fontSize: '1.1rem' }}>Plugin Settings</h3>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>Plugins können hier ihre globalen Verbindungsdaten und Optionen registrieren.</p>
        <PluginSettingsHost title="Globale Plugin Settings" />
      </div>
      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

        <div className="card">
          <h3 style={{ marginTop: 0, borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1.25rem', fontSize: '1.1rem' }}>Form Script AI</h3>
          <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>
            Optional OpenAI-compatible code generation. Every proposal is checked server-side and shown as a diff before it can replace the visible TypeScript source.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.25rem' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Chat Completions Base URL</label>
              <input
                type="url"
                name="scriptAiBaseUrl"
                value={config.scriptAiBaseUrl || ''}
                onChange={handleChange}
                className="form-input"
                placeholder="https://api.openai.com/v1"
              />
            </div>
            <div>
              <label className="form-label">Model</label>
              <input
                type="text"
                name="scriptAiModel"
                value={config.scriptAiModel || ''}
                onChange={handleChange}
                className="form-input"
                placeholder="Provider model id"
              />
            </div>
            <div>
              <label className="form-label">API key</label>
              <input
                type="password"
                name="scriptAiApiKey"
                value={config.scriptAiApiKey || ''}
                className="form-input"
                readOnly
                placeholder="Set via environment"
              />
              <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Server-only via FORM_SCRIPT_AI_API_KEY or OPENAI_API_KEY; it is never persisted or sent to the browser.
              </span>
            </div>
          </div>
        </div>

        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', borderBottom: '1px solid var(--border)', paddingBottom: '0.75rem', marginBottom: '1.25rem' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.1rem' }}>EHRbase Connections</h3>
              <p style={{ color: 'var(--text-muted)', margin: '0.4rem 0 0' }}>Eine Verbindung ist aktiv. Formulare, AQLs und Patienten verwenden immer dieses System.</p>
            </div>
            <button type="button" className="btn secondary" onClick={addConnection} disabled={connections.length >= 2} title="Maximal zwei Systeme"><Plus size={16} /> System hinzufügen</button>
          </div>
          {connections.map((connection) => (
            <section key={connection.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '1rem', marginBottom: '1rem', background: connection.id === config.activeEhrbaseConnectionId ? 'var(--surface-hover)' : undefined }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
                <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontWeight: 600, cursor: 'pointer' }}>
                  <input type="radio" checked={connection.id === config.activeEhrbaseConnectionId} onChange={() => setConfig({ ...config, activeEhrbaseConnectionId: connection.id })} />
                  {connection.id === config.activeEhrbaseConnectionId ? 'Aktives System' : 'Dieses System aktivieren'}
                </label>
                <button type="button" className="btn secondary" onClick={() => removeConnection(connection.id)} disabled={connections.length <= 1} title="System entfernen"><Trash2 size={16} /> Entfernen</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div><label className="form-label">Name</label><input className="form-input" value={connection.name} onChange={(event) => updateConnection(connection.id, 'name', event.target.value)} placeholder="Testsystem" /></div>
                <div><label className="form-label">Authentisierungs-Plugin</label><select className="form-input" value={connection.authPlugin} onChange={(event) => updateConnection(connection.id, 'authPlugin', event.target.value)}><option value="none">Keine Authentisierung</option><option value="basic">HTTP Basic Auth</option><option value="hip-keycloak">HIP / Keycloak OAuth2</option></select></div>
                <div style={{ gridColumn: '1 / -1' }}><label className="form-label">EHRbase REST URL</label><input className="form-input" type="url" value={connection.url} onChange={(event) => updateConnection(connection.id, 'url', event.target.value)} placeholder="https://ehrbase.example/rest/openehr/v1" required /></div>
                <div><label className="form-label">Subject Namespace</label><input className="form-input" value={connection.subjectNamespace || ''} onChange={(event) => updateConnection(connection.id, 'subjectNamespace', event.target.value)} placeholder="default" /></div>
                <div><label className="form-label">Default EHR-ID (optional)</label><input className="form-input" value={connection.defaultEhrId || ''} onChange={(event) => updateConnection(connection.id, 'defaultEhrId', event.target.value)} placeholder="Für Test-Formulare" /></div>
                {connection.authPlugin === 'none' && <span style={{ gridColumn: '1 / -1', fontSize: '0.85rem', color: 'var(--text-muted)' }}>Für diese EHRbase wird nur die URL verwendet; es werden keine Credentials gesendet.</span>}
                {connection.authPlugin === 'basic' && <><div><label className="form-label">Username</label><input className="form-input" value={connection.username || ''} onChange={(event) => updateConnection(connection.id, 'username', event.target.value)} /></div><div><label className="form-label">Password</label><input className="form-input" type="password" value={connection.password || ''} onChange={(event) => updateConnection(connection.id, 'password', event.target.value)} placeholder="••••••••" /></div></>}
                {connection.authPlugin === 'hip-keycloak' && <><div style={{ gridColumn: '1 / -1' }}><label className="form-label">Keycloak Base URL</label><input className="form-input" type="url" value={connection.keycloakBaseUrl || ''} onChange={(event) => updateConnection(connection.id, 'keycloakBaseUrl', event.target.value)} placeholder="https://hip.example" /></div><div><label className="form-label">Realm</label><input className="form-input" value={connection.keycloakRealm || ''} onChange={(event) => updateConnection(connection.id, 'keycloakRealm', event.target.value)} /></div><div><label className="form-label">Client ID</label><input className="form-input" value={connection.keycloakClientId || ''} onChange={(event) => updateConnection(connection.id, 'keycloakClientId', event.target.value)} /></div><div><label className="form-label">Grant Type</label><input className="form-input" value={connection.keycloakGrantType || 'password'} onChange={(event) => updateConnection(connection.id, 'keycloakGrantType', event.target.value)} /></div><div><label className="form-label">Username</label><input className="form-input" value={connection.username || ''} onChange={(event) => updateConnection(connection.id, 'username', event.target.value)} /></div><div><label className="form-label">Password</label><input className="form-input" type="password" value={connection.password || ''} onChange={(event) => updateConnection(connection.id, 'password', event.target.value)} placeholder="••••••••" /></div></>}
              </div>
            </section>
          ))}
        </div>

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
