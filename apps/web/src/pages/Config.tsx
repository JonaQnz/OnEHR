import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Plus, Save, Trash2 } from 'lucide-react';
import PluginSettingsHost from '../components/PluginSettingsHost';

type ConnectionDraft = {
  id: string; name: string; url: string; authPlugin: 'none' | 'basic' | 'hip-keycloak';
  username?: string; password?: string; keycloakBaseUrl?: string; keycloakRealm?: string;
  keycloakClientId?: string; keycloakGrantType?: string; subjectNamespace?: string; defaultEhrId?: string;
};

export default function Config() {
  const [config, setConfig] = useState<any>({ ehrbaseConnections: [], activeEhrbaseConnectionId: '', userAuthMode: 'local', localUsername: '', mappingServiceApi: '', scriptAiBaseUrl: '', scriptAiApiKey: '', scriptAiModel: '' });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { fetch('http://localhost:3001/api/config', { credentials: 'include' }).then((res) => res.json()).then((data) => setConfig(data)).catch(() => setError('Configuration could not be loaded.')).finally(() => setLoading(false)); }, []);
  const change = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setConfig({ ...config, [event.target.name]: event.target.value });
  const connections: ConnectionDraft[] = Array.isArray(config.ehrbaseConnections) ? config.ehrbaseConnections : [];
  const updateConnection = (id: string, key: keyof ConnectionDraft, value: string) => setConfig({ ...config, ehrbaseConnections: connections.map((item) => item.id === id ? { ...item, [key]: value } : item) });
  const addConnection = () => {
    if (connections.length >= 2) return;
    const id = `ehrbase-${Date.now()}`;
    setConfig({ ...config, ehrbaseConnections: [...connections, { id, name: connections.length ? 'Livesystem' : 'Testsystem', url: '', authPlugin: 'none', subjectNamespace: 'default' }], activeEhrbaseConnectionId: config.activeEhrbaseConnectionId || id });
  };
  const removeConnection = (id: string) => {
    if (connections.length <= 1) return;
    const remaining = connections.filter((item) => item.id !== id);
    setConfig({ ...config, ehrbaseConnections: remaining, activeEhrbaseConnectionId: config.activeEhrbaseConnectionId === id ? remaining[0].id : config.activeEhrbaseConnectionId });
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); setError(''); setMessage('');
    try {
      const response = await fetch('http://localhost:3001/api/config', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setConfig(data.config); setMessage('Configuration saved successfully!');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Configuration could not be saved.'); }
  };
  if (loading) return <div style={{ padding: '2rem' }}>Loading Configuration...</div>;

  return <div style={{ maxWidth: '800px', margin: '0 auto' }}>
    <div style={{ marginBottom: '2rem' }}><h1 style={{ fontSize: '2rem', margin: '0 0 .5rem' }}>System Settings</h1><p style={{ margin: 0, color: 'var(--text-muted)' }}>Configure Forms access and the connected EHRbase systems.</p></div>
    {message && <div className="card" style={{ color: 'var(--success-hover)', marginBottom: '1rem' }}><CheckCircle2 size={18} /> {message}</div>}
    {error && <div className="card" style={{ color: 'var(--danger-hover)', marginBottom: '1rem' }}><AlertCircle size={18} /> {error}</div>}

    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <h3 style={{ marginTop: 0 }}>Forms App Access</h3>
      <p style={{ color: 'var(--text-muted)' }}>Local login uses Forms accounts. HIP login uses the active connection's HIP / Keycloak plugin; no separate issuer, callback or discovery configuration is needed.</p>
      <label className="form-label">User authentication</label>
      <select name="userAuthMode" value={config.userAuthMode || 'local'} onChange={change} className="form-input"><option value="local">Local login</option><option value="hip">HIP / Keycloak login</option></select>
      {config.userAuthMode === 'local' && <><label className="form-label" style={{ marginTop: '1rem' }}>Local username (legacy bootstrap only)</label><input name="localUsername" value={config.localUsername || ''} onChange={change} className="form-input" placeholder="Set via environment" /></>}
      {config.userAuthMode === 'hip' && <p style={{ color: 'var(--text-muted)', marginBottom: 0 }}>At sign-in, Forms sends the entered username and password to the active HIP / Keycloak plugin. A Keycloak token must be returned; it is then discarded.</p>}
    </div>

    <div className="card" style={{ marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center' }}><div><h3 style={{ margin: 0 }}>EHRbase Connections</h3><p style={{ color: 'var(--text-muted)', marginBottom: 0 }}>AQL, forms and HIP login use the selected system. Up to two systems can be stored.</p></div><button type="button" className="btn secondary" onClick={addConnection} disabled={connections.length >= 2}><Plus size={16} /> System hinzufügen</button></div>
      <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1rem' }}>
        {connections.map((connection) => <section key={connection.id} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '1rem', background: connection.id === config.activeEhrbaseConnectionId ? 'var(--surface-hover)' : undefined }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}><label><input type="radio" checked={connection.id === config.activeEhrbaseConnectionId} onChange={() => setConfig({ ...config, activeEhrbaseConnectionId: connection.id })} /> {connection.id === config.activeEhrbaseConnectionId ? 'Aktives System' : 'Dieses System aktivieren'}</label><button type="button" className="btn secondary" onClick={() => removeConnection(connection.id)} disabled={connections.length <= 1}><Trash2 size={16} /> Entfernen</button></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div><label className="form-label">Name</label><input className="form-input" value={connection.name} onChange={(event) => updateConnection(connection.id, 'name', event.target.value)} /></div>
            <div><label className="form-label">Authentication plugin</label><select className="form-input" value={connection.authPlugin} onChange={(event) => updateConnection(connection.id, 'authPlugin', event.target.value)}><option value="none">No authentication</option><option value="basic">HTTP Basic Auth</option><option value="hip-keycloak">HIP / Keycloak OAuth2</option></select></div>
            <div style={{ gridColumn: '1 / -1' }}><label className="form-label">EHRbase REST URL</label><input className="form-input" type="url" value={connection.url} onChange={(event) => updateConnection(connection.id, 'url', event.target.value)} required /></div>
            <div><label className="form-label">Subject namespace</label><input className="form-input" value={connection.subjectNamespace || ''} onChange={(event) => updateConnection(connection.id, 'subjectNamespace', event.target.value)} placeholder="default" /></div>
            <div><label className="form-label">Default EHR-ID</label><input className="form-input" value={connection.defaultEhrId || ''} onChange={(event) => updateConnection(connection.id, 'defaultEhrId', event.target.value)} /></div>
            {connection.authPlugin === 'basic' && <><div><label className="form-label">Service username</label><input className="form-input" value={connection.username || ''} onChange={(event) => updateConnection(connection.id, 'username', event.target.value)} /></div><div><label className="form-label">Service password</label><input className="form-input" type="password" value={connection.password || ''} onChange={(event) => updateConnection(connection.id, 'password', event.target.value)} /></div></>}
            {connection.authPlugin === 'hip-keycloak' && <><div style={{ gridColumn: '1 / -1' }}><label className="form-label">Keycloak Base URL</label><input className="form-input" type="url" value={connection.keycloakBaseUrl || ''} onChange={(event) => updateConnection(connection.id, 'keycloakBaseUrl', event.target.value)} required /></div><div><label className="form-label">Realm</label><input className="form-input" value={connection.keycloakRealm || ''} onChange={(event) => updateConnection(connection.id, 'keycloakRealm', event.target.value)} required /></div><div><label className="form-label">Client ID</label><input className="form-input" value={connection.keycloakClientId || ''} onChange={(event) => updateConnection(connection.id, 'keycloakClientId', event.target.value)} required /></div><div><label className="form-label">Grant type</label><input className="form-input" value={connection.keycloakGrantType || 'password'} onChange={(event) => updateConnection(connection.id, 'keycloakGrantType', event.target.value)} /></div><div><label className="form-label">EHRbase service username</label><input className="form-input" value={connection.username || ''} onChange={(event) => updateConnection(connection.id, 'username', event.target.value)} placeholder="Used for server-to-EHRbase calls" /></div><div style={{ gridColumn: '1 / -1' }}><label className="form-label">EHRbase service password</label><input className="form-input" type="password" value={connection.password || ''} onChange={(event) => updateConnection(connection.id, 'password', event.target.value)} placeholder="Used for server-to-EHRbase calls" /></div></>}
          </div>
        </section>)}
        <div><label className="form-label">Mapping Service API</label><input name="mappingServiceApi" value={config.mappingServiceApi || ''} onChange={change} className="form-input" /></div>
        <div><label className="form-label">Form Script AI base URL</label><input name="scriptAiBaseUrl" value={config.scriptAiBaseUrl || ''} onChange={change} className="form-input" placeholder="Optional" /></div>
        <div><label className="form-label">Form Script AI model</label><input name="scriptAiModel" value={config.scriptAiModel || ''} onChange={change} className="form-input" placeholder="Optional" /></div>
        <button type="submit" className="btn" style={{ alignSelf: 'flex-end' }}><Save size={18} /> Save Configuration</button>
      </form>
    </div>
    <div className="card"><h3 style={{ marginTop: 0 }}>Plugin Settings</h3><PluginSettingsHost title="Globale Plugin Settings" /></div>
  </div>;
}
