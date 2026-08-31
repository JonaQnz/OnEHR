import { useEffect, useState, type ReactNode } from 'react';
import { API_BASE_URL } from '../integration/apiBaseUrl';

interface PluginContribution {
  pluginId: string;
  extensionPoint: string;
  key: string;
  label?: string;
  propertySchema?: Record<string, unknown>;
  secretKeys?: string[];
  scope?: 'global' | 'form';
}
interface PluginSnapshot { contributions?: PluginContribution[] }
interface Entry { pluginId: string; contribution: PluginContribution; draft: Record<string, unknown>; saving: boolean; message?: string; error?: string }
const API = `${API_BASE_URL}/plugins`;
function asText(value: unknown): string { return value === undefined || value === null ? '' : String(value); }
function fields(contribution: PluginContribution): Record<string, Record<string, unknown>> {
  const properties = contribution.propertySchema?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties) ? properties as Record<string, Record<string, unknown>> : {};
}
function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function hydrate(properties: Record<string, Record<string, unknown>>, stored: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([key, descriptor]) => {
    if (descriptor.type === 'object') {
      const nested = descriptor.properties && typeof descriptor.properties === 'object' && !Array.isArray(descriptor.properties) ? descriptor.properties as Record<string, Record<string, unknown>> : {};
      return [key, hydrate(nested, objectValue(stored[key]))];
    }
    if (descriptor.type === 'boolean') return [key, typeof stored[key] === 'boolean' ? stored[key] : descriptor.default !== undefined ? descriptor.default : false];
    return [key, stored[key] ?? descriptor.default ?? ''];
  }));
}
function readPath(source: Record<string, unknown>, path: string): unknown { return path.split('.').reduce<unknown>((value, part) => objectValue(value)[part], source); }
function writePath(source: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const result = { ...source };
  const parts = path.split('.');
  let cursor = result;
  parts.slice(0, -1).forEach((part) => { cursor[part] = { ...objectValue(cursor[part]) }; cursor = cursor[part] as Record<string, unknown>; });
  cursor[parts[parts.length - 1]] = value;
  return result;
}
function renderFields(properties: Record<string, Record<string, unknown>>, draft: Record<string, unknown>, update: (path: string, value: unknown) => void, secretKeys: string[] = [], prefix = ''): ReactNode {
  return Object.entries(properties).map(([key, descriptor]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const title = asText(descriptor.title) || key;
    if (descriptor.type === 'object') {
      const nested = descriptor.properties && typeof descriptor.properties === 'object' && !Array.isArray(descriptor.properties) ? descriptor.properties as Record<string, Record<string, unknown>> : {};
      return <fieldset key={path} style={{ gridColumn: '1 / -1', border: '1px solid var(--border)', borderRadius: 8, padding: '0.75rem' }}><legend style={{ padding: '0 0.35rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>{title}</legend><div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.35rem' }}>{renderFields(nested, draft, update, secretKeys, path)}</div></fieldset>;
    }
    if (descriptor.type === 'boolean') {
      return <label key={path} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', minHeight: 38, padding: '0.35rem 0' }}><span>{title}</span><span style={{ position: 'relative', width: 42, height: 24, display: 'inline-flex' }}><input type="checkbox" checked={Boolean(readPath(draft, path))} onChange={(event) => update(path, event.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} /><span aria-hidden="true" style={{ position: 'absolute', inset: 0, borderRadius: 999, background: Boolean(readPath(draft, path)) ? '#2563eb' : '#cbd5e1', transition: 'background 0.15s', cursor: 'pointer' }}><span style={{ position: 'absolute', top: 3, left: Boolean(readPath(draft, path)) ? 21 : 3, width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.15s' }} /></span></span></label>;
    }
    const format = asText(descriptor.format);
    const secret = secretKeys.includes(key) || format === 'password';
    return <label key={path} className="form-label"><span>{title}</span><input className="form-input" type={secret ? 'password' : format === 'uri' ? 'url' : 'text'} value={asText(readPath(draft, path))} onChange={(event) => update(path, event.target.value)} placeholder={secret ? 'Leer lassen, um den bestehenden Wert zu behalten' : undefined} /></label>;
  });
}
export default function PluginSettingsHost({ title = 'Plugin Settings' }: { title?: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const snapshotResponse = await fetch(API, { credentials: 'include' });
        const snapshot = await snapshotResponse.json() as PluginSnapshot;
        if (!snapshotResponse.ok) throw new Error((snapshot as { error?: string }).error || 'Plugins konnten nicht geladen werden.');
        const contributions = (snapshot.contributions || []).filter((item) => item.extensionPoint === 'settings' && item.scope === 'global');
        const loaded = await Promise.all(contributions.map(async (contribution) => {
          const response = await fetch(`${API}/settings/${encodeURIComponent(contribution.pluginId)}`, { credentials: 'include' });
          const body = await response.json() as { settings?: Record<string, unknown>; error?: string };
          if (!response.ok) throw new Error(body.error || `${contribution.label || contribution.pluginId} konnte nicht geladen werden.`);
          const stored = body.settings || {};
          const draft = hydrate(fields(contribution), stored);
          return { pluginId: contribution.pluginId, contribution, draft, saving: false };
        }));
        if (active) setEntries(loaded);
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : 'Plugin Settings konnten nicht geladen werden.'); }
      finally { if (active) setLoading(false); }
    }
    void load();
    return () => { active = false; };
  }, []);
  const updateDraft = (pluginId: string, key: string, value: unknown) => setEntries((current) => current.map((entry) => entry.pluginId === pluginId ? { ...entry, draft: writePath(entry.draft, key, value), message: '', error: '' } : entry));
  const save = async (entry: Entry) => {
    setEntries((current) => current.map((item) => item.pluginId === entry.pluginId ? { ...item, saving: true, message: '', error: '' } : item));
    try {
      const response = await fetch(`${API}/settings/${encodeURIComponent(entry.pluginId)}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry.draft) });
      const body = await response.json() as { settings?: Record<string, unknown>; error?: string };
      if (!response.ok) throw new Error(body.error || 'Plugin Settings konnten nicht gespeichert werden.');
      const stored = body.settings || {};
      const draft = hydrate(fields(entry.contribution), stored);
      setEntries((current) => current.map((item) => item.pluginId === entry.pluginId ? { ...item, draft, saving: false, message: 'Gespeichert.' } : item));
    } catch (reason) {
      setEntries((current) => current.map((item) => item.pluginId === entry.pluginId ? { ...item, saving: false, error: reason instanceof Error ? reason.message : 'Speichern fehlgeschlagen.' } : item));
    }
  };
  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Plugin Settings werden geladen…</div>;
  if (error) return <div style={{ color: '#b91c1c', fontSize: '0.85rem' }}>{error}</div>;
  if (entries.length === 0) return <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Keine globalen Plugin Settings registriert.</div>;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
    <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{title} werden vom jeweiligen Plugin definiert und namespaced gespeichert.</div>
    {entries.map((entry) => <div key={`${entry.pluginId}:${entry.contribution.key}`} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '1rem' }}>
      <h4 style={{ margin: '0 0 0.25rem' }}>{entry.contribution.label || entry.pluginId}</h4>
      <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginBottom: '0.75rem' }}>{entry.pluginId}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        {renderFields(fields(entry.contribution), entry.draft, (path, value) => updateDraft(entry.pluginId, path, value), entry.contribution.secretKeys ? [...entry.contribution.secretKeys] : [])}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '1rem' }}><button className="btn btn-secondary" type="button" disabled={entry.saving} onClick={() => void save(entry)}>{entry.saving ? 'Speichert…' : 'Plugin Settings speichern'}</button>{entry.message && <span style={{ color: '#15803d', fontSize: '0.8rem' }}>{entry.message}</span>}{entry.error && <span style={{ color: '#b91c1c', fontSize: '0.8rem' }}>{entry.error}</span>}</div>
    </div>)}
  </div>;
}
