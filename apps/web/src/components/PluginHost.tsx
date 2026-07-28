import { useEffect, useMemo, useState, type ReactNode } from 'react';

export type PluginSlotName = 'settings' | 'designer' | 'runtime' | 'form' | 'dataProvider';

export interface PluginActionContext {
  formId?: string;
  patientId?: string;
  sessionId?: string;
  form?: Record<string, unknown>;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface PluginContribution {
  pluginId: string;
  extensionPoint: string;
  key: string;
  label?: string;
  actionId?: string;
  panelId?: string;
  providerId?: string;
  capabilities?: string[];
  placement?: string;
  propertySchema?: Record<string, unknown>;
  scope?: 'global' | 'form';
  formSettingsPath?: string;
}

interface PluginSnapshot {
  contributions: PluginContribution[];
  host?: { apiVersion: string; extensionPoints: string[]; permissions: string[] };
}

interface PluginSlotProps {
  slot: PluginSlotName;
  context?: PluginActionContext;
  title?: string;
  scope?: 'global' | 'form';
  onResult?: (result: { data?: Record<string, unknown>; message?: string; messages?: Array<{ severity: 'info' | 'warning' | 'error'; code?: string; path?: string; message: string }>; stop?: boolean }) => void;
  disabled?: boolean;
}

function objectValue(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function readPath(source: Record<string, unknown>, path: string): unknown { return path.split('.').reduce<unknown>((value, part) => objectValue(value)[part], source); }
function writePath(source: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const result = { ...source };
  const parts = path.split('.');
  let cursor = result;
  parts.slice(0, -1).forEach((part) => { cursor[part] = { ...objectValue(cursor[part]) }; cursor = cursor[part] as Record<string, unknown>; });
  cursor[parts[parts.length - 1]] = value;
  return result;
}
function schemaProperties(schema?: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const properties = schema?.properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties) ? properties as Record<string, Record<string, unknown>> : {};
}
function formSettingsDraft(context: PluginActionContext, contribution: PluginContribution): Record<string, unknown> {
  const stored = objectValue(readPath(context.form || {}, contribution.formSettingsPath || ''));
  return Object.fromEntries(Object.entries(schemaProperties(contribution.propertySchema)).map(([key, descriptor]) => [key, typeof stored[key] === 'boolean' ? stored[key] : descriptor.default !== undefined ? descriptor.default : true]));
}
function formSettingsFields(properties: Record<string, Record<string, unknown>>, draft: Record<string, unknown>, update: (key: string, value: boolean) => void, visibleKeys?: Set<string>): ReactNode {
  return Object.entries(properties).filter(([key, descriptor]) => descriptor.type === 'boolean' && (!visibleKeys || visibleKeys.has(key))).map(([key, descriptor]) => <label key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', padding: '0.3rem 0' }}><span>{String(descriptor.title || key)}</span><span style={{ position: 'relative', width: 42, height: 24, display: 'inline-flex' }}><input type="checkbox" checked={Boolean(draft[key])} onChange={(event) => update(key, event.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} /><span aria-hidden="true" style={{ position: 'absolute', inset: 0, borderRadius: 999, background: Boolean(draft[key]) ? '#2563eb' : '#cbd5e1', cursor: 'pointer' }}><span style={{ position: 'absolute', top: 3, left: Boolean(draft[key]) ? 21 : 3, width: 18, height: 18, borderRadius: '50%', background: '#fff' }} /></span></span></label>);
}
function FormSettingsEditor({ context, contribution, onResult, disabled, visibleKeys }: { context: PluginActionContext; contribution: PluginContribution; onResult?: PluginSlotProps['onResult']; disabled: boolean; visibleKeys?: Set<string> }) {
  const path = contribution.formSettingsPath;
  const [draft, setDraft] = useState<Record<string, unknown>>(() => formSettingsDraft(context, contribution));
  useEffect(() => { setDraft(formSettingsDraft(context, contribution)); }, [context.form, contribution]);
  if (!path) return null;
  const apply = () => {
    const form = { ...(context.form || {}) };
    const updated = writePath(form, path, draft);
    onResult?.({ data: updated, message: 'Form-Webhook-Einstellungen übernommen.' });
  };
  return <div style={{ margin: '0.5rem 0', padding: '0.65rem', border: '1px solid #dbeafe', borderRadius: 6, background: '#fff' }}><div style={{ fontSize: '0.72rem', color: '#475569', marginBottom: '0.35rem' }}>Webhook-Einstellungen für dieses Formular</div><div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '0.25rem' }}>{visibleKeys && visibleKeys.size === 0 ? <div style={{ color: '#64748b', fontSize: '0.78rem' }}>Keine global aktivierten n8n Webhooks.</div> : formSettingsFields(schemaProperties(contribution.propertySchema), draft, (key, value) => setDraft((current) => ({ ...current, [key]: value })), visibleKeys)}</div><button className="btn btn-secondary" type="button" disabled={disabled} onClick={apply} style={{ marginTop: '0.5rem' }}>Form-Einstellungen übernehmen</button></div>;
}

const API = 'http://localhost:3001/api/plugins';

function slotLabel(slot: PluginSlotName): string {
  if (slot === 'designer') return 'Plugin Designer';
  if (slot === 'runtime') return 'Plugin-Aktionen';
  if (slot === 'form') return 'Formular-Aktionen';
  if (slot === 'dataProvider') return 'Datenanbieter';
  return 'Plugin Settings';
}

export default function PluginHost({ slot, context = {}, title, scope, onResult, disabled = false }: PluginSlotProps) {
  const [snapshot, setSnapshot] = useState<PluginSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [globalWebhookKeys, setGlobalWebhookKeys] = useState<Set<string> | undefined>(undefined);

  useEffect(() => {
    let active = true;
    fetch(API, { credentials: 'include' })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Plugins konnten nicht geladen werden.');
        return body as PluginSnapshot;
      })
      .then((body) => { if (active) setSnapshot(body); })
      .catch((reason: Error) => { if (active) setError(reason.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (slot !== 'settings' || scope !== 'form' || !snapshot) {
      setGlobalWebhookKeys(slot === 'settings' && scope === 'form' ? new Set<string>() : undefined);
      return;
    }
    let active = true;
    const pluginIds = Array.from(new Set(snapshot.contributions.filter((item) => item.extensionPoint === 'settings' && item.scope === 'form').map((item) => item.pluginId)));
    async function loadGlobalSettings() {
      const responses = await Promise.all(pluginIds.map(async (pluginId) => {
        const response = await fetch(`${API}/settings/${encodeURIComponent(pluginId)}`, { credentials: 'include' });
        if (!response.ok) return {};
        const body = await response.json() as { settings?: Record<string, unknown> };
        return body.settings || {};
      }));
      const keys = new Set<string>();
      responses.forEach((settings) => { const webhooks = objectValue(settings.webhooks); Object.entries(webhooks).forEach(([key, value]) => { if (value === true) keys.add(key); }); });
      if (active) setGlobalWebhookKeys(keys);
    }
    void loadGlobalSettings().catch(() => { if (active) setGlobalWebhookKeys(new Set<string>()); });
    return () => { active = false; };
  }, [snapshot, slot, scope]);
  const contributions = useMemo(() => (snapshot?.contributions || []).filter((item) => item.extensionPoint === slot && (!scope || item.scope === scope || (scope === 'form' && !item.scope))), [snapshot, slot, scope]);
  const submission = objectValue(readPath(context.form || {}, 'settings.submission'));
  const isN8nForm = submission.mode === 'workflow' && submission.providerId === 'n8n';

  const execute = async (contribution: PluginContribution) => {
    if (!contribution.actionId) return;
    setBusy(contribution.key);
    setMessage('');
    setError('');
    try {
      const response = await fetch(`${API}/actions/${encodeURIComponent(contribution.pluginId)}/${encodeURIComponent(contribution.actionId)}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(context),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || result.errors?.map((item: { message: string }) => item.message).join(', ') || 'Plugin-Aktion fehlgeschlagen.');
      const messages = [...(Array.isArray(result.notices) ? result.notices : []), ...(Array.isArray(result.warnings) ? result.warnings : []), ...(Array.isArray(result.errors) ? result.errors.map((item: { message: string; path?: string }) => ({ ...item, severity: 'error' as const })) : [])];
      if (result.stop === true && !messages.some((item: { severity: string }) => item.severity === 'error')) messages.push({ severity: 'error', message: result.stopMessage || 'Plugin hat den Vorgang angehalten.' });
      if (result.data || messages.length > 0 || result.message) onResult?.({ data: result.data, message: result.message, messages, stop: result.stop === true });
      setMessage(result.message || 'Plugin-Aktion ausgeführt.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Plugin-Aktion fehlgeschlagen.');
    } finally {
      setBusy('');
    }
  };

  if (loading || error || contributions.length === 0) {
    if (error) return <div style={{ color: '#b91c1c', fontSize: '0.78rem', padding: '0.5rem 0' }}>{error}</div>;
    return null;
  }

  return (
    <section className="plugin-host-slot" style={{ margin: '0.75rem 0', padding: '0.75rem', border: '1px solid #dbeafe', borderRadius: '8px', background: '#f8fbff' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <strong style={{ fontSize: '0.78rem', color: '#1e3a8a' }}>{title || slotLabel(slot)}</strong>
        {snapshot?.host && <span style={{ fontSize: '0.68rem', color: '#64748b' }}>Host API {snapshot.host.apiVersion}</span>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.45rem' }}>
        {contributions.map((contribution) => {
          const action = Boolean(contribution.actionId) && ['settings', 'runtime', 'form'].includes(slot);
          return <div key={contribution.key} style={{ flex: '1 1 100%' }}>
            {slot === 'settings' && contribution.scope === 'form' && contribution.formSettingsPath && isN8nForm && <FormSettingsEditor context={context} contribution={contribution} visibleKeys={globalWebhookKeys} onResult={onResult} disabled={disabled || Boolean(busy)} />}
            {action ? <button className="btn btn-secondary" type="button" disabled={Boolean(busy) || disabled} onClick={() => void execute(contribution)}>
              {busy === contribution.key ? 'Wird ausgeführt…' : contribution.label || contribution.key}
            </button> : <span className="badge badge-draft" title={contribution.propertySchema ? JSON.stringify(contribution.propertySchema) : contribution.key}>
              {contribution.label || contribution.panelId || contribution.providerId || contribution.key}
            </span>}
          </div>;
        })}
      </div>
      {message && <div style={{ color: '#15803d', fontSize: '0.75rem', marginTop: '0.5rem' }}>{message}</div>}
      {error && <div style={{ color: '#b91c1c', fontSize: '0.75rem', marginTop: '0.5rem' }}>{error}</div>}
    </section>
  );
}
