import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Package, Power, RefreshCw } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { API_BASE_URL } from '../integration/apiBaseUrl';

interface PluginManifest {
  id: string;
  version: string;
  name: string;
  description?: string;
  extensionPoints: string[];
  permissions?: string[];
}

interface PluginPackageStatus {
  packageName: string;
  enabled: boolean;
  manifest?: PluginManifest;
  error?: string;
}

interface PluginContribution {
  pluginId: string;
  extensionPoint: string;
  key: string;
  label?: string;
}

interface PluginResponse {
  packages: PluginPackageStatus[];
  contributions: PluginContribution[];
  host?: {
    apiVersion: string;
    extensionPoints: string[];
    permissions: string[];
  };
}

const API = `${API_BASE_URL}/plugins`;

export default function Plugins() {
  useDocumentTitle('Plugins');
  const [packageName, setPackageName] = useState('formbuilder-example-vitals-plugin');
  const [data, setData] = useState<PluginResponse>({ packages: [], contributions: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadOverview = () => {
    setLoading(true);
    fetch(API, { credentials: 'include' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load plugins');
        return body as PluginResponse;
      })
      .then(setData)
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  };

  useEffect(loadOverview, []);

  const enabledCount = useMemo(() => data.packages.filter((item) => item.enabled).length, [data.packages]);

  const loadPackage = (event: React.FormEvent) => {
    event.preventDefault();
    const requested = packageName.trim();
    if (!requested) return;
    setBusy(requested);
    setMessage('');
    setError('');
    fetch(`${API}/load`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageName: requested }),
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load plugin');
        return body;
      })
      .then((body) => {
        setMessage(`${body.manifest.name} wurde geladen.`);
        setData({ host: body.host, packages: body.packages, contributions: body.contributions });
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setBusy(''));
  };

  const unloadPackage = (name: string) => {
    setBusy(name);
    setMessage('');
    setError('');
    fetch(`${API}/unload`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packageName: name }),
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to unload plugin');
        return body;
      })
      .then((body) => {
        setMessage(`${name} wurde deaktiviert.`);
        setData({ host: body.host, packages: body.packages, contributions: body.contributions });
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setBusy(''));
  };

  return (
    <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, margin: '0 0 0.5rem' }}>Plugins</h1>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>Installierte und aktivierte Erweiterungen für den Form Builder.</p>
          {data.host && <div style={{ marginTop: '0.5rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>Host API {data.host.apiVersion} / {data.host.extensionPoints.length} Extension-Points / {data.host.permissions.length} Berechtigungen</div>}
        </div>
        <button className="btn btn-secondary" type="button" onClick={loadOverview} disabled={loading}>
          <RefreshCw size={16} /> Aktualisieren
        </button>
      </div>

      {message && <div className="card" style={{ color: 'var(--success-hover)', background: 'var(--success-light)', display: 'flex', gap: '0.5rem', alignItems: 'center' }}><CheckCircle2 size={18} />{message}</div>}
      {error && <div className="card" style={{ color: 'var(--danger-hover)', background: 'var(--danger-light)', display: 'flex', gap: '0.5rem', alignItems: 'center' }}><AlertCircle size={18} />{error}</div>}

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Plugin laden</h2>
        <p style={{ color: 'var(--text-muted)', marginTop: 0 }}>Gib den npm-Paketnamen eines im Selfhosted-Deployment installierten Plugins ein.</p>
        <form onSubmit={loadPackage} style={{ display: 'flex', gap: '0.75rem' }}>
          <input className="form-input" value={packageName} onChange={(event) => setPackageName(event.target.value)} placeholder="formbuilder-example-vitals-plugin" />
          <button className="btn" type="submit" disabled={Boolean(busy)}><Package size={16} /> Laden</button>
        </form>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0, fontSize: '1.1rem' }}>Verfügbare Plugin-Pakete ({enabledCount} aktiv)</h2>
        {loading && <p>Plugins werden geladen…</p>}
        {!loading && data.packages.length === 0 && <p style={{ color: 'var(--text-muted)' }}>Noch kein Plugin konfiguriert.</p>}
        <div style={{ display: 'grid', gap: '1rem' }}>
          {data.packages.map((item) => {
            const contributions = data.contributions.filter((entry) => entry.pluginId === item.manifest?.id);
            return <div key={item.packageName} style={{ border: '1px solid var(--border)', borderRadius: '10px', padding: '1rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
                <div>
                  <strong>{item.manifest?.name || item.packageName}</strong>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.25rem' }}>{item.packageName}{item.manifest ? ` · ${item.manifest.version}` : ''}</div>
                  {item.manifest?.description && <p style={{ margin: '0.6rem 0 0', color: 'var(--text-muted)' }}>{item.manifest.description}</p>}
                  {item.error && <p style={{ margin: '0.6rem 0 0', color: 'var(--danger-hover)' }}>Fehler: {item.error}</p>}
                </div>
                <button className="btn btn-secondary" type="button" onClick={() => unloadPackage(item.packageName)} disabled={!item.enabled || Boolean(busy)}><Power size={15} /> Deaktivieren</button>
              </div>
              {item.manifest && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.8rem' }}>{item.manifest.extensionPoints.map((point) => <span key={point} className="badge badge-draft">{point}</span>)}</div>}
              {contributions.length > 0 && <div style={{ marginTop: '0.8rem', fontSize: '0.85rem' }}><strong>Registrierungen:</strong> {contributions.map((entry) => `${entry.extensionPoint}:${entry.key}`).join(', ')}</div>}
              {item.manifest?.permissions && item.manifest.permissions.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.5rem' }}>{item.manifest.permissions.map((permission) => <span key={permission} className="badge badge-draft">Berechtigung: {permission}</span>)}</div>}
            </div>;
          })}
        </div>
      </div>
    </div>
  );
}
