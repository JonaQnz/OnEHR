import { useEffect, useState } from 'react';
import { Tags, Plus, Trash2, Send, Archive } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { API_BASE_URL } from '../integration/apiBaseUrl';
import { useAuth } from '../App';

interface TerminologyProviderSummary { id: string; displayName: string; capabilities: string[]; }
interface CustomTerminologySummary {
  terminologyId: string; bindingId: string; bindingVersion?: string; label: string;
  namespace?: string; status: 'draft' | 'published' | 'retired'; conceptCount?: number; revision: string;
}
interface TerminologyConcept { namespace: string; namespaceVersion?: string; code: string; display?: string; definition?: string; active?: boolean; }

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body as T;
}

const emptyDraft = { code: '', display: '', definition: '' };

/**
 * "Eigene Terminologien" management screen - CRUD + lifecycle (draft →
 * published → retired) for self-authored code lists, talking exclusively to
 * the generic, provider-agnostic `/api/terminology/manage/*` routes
 * (apps/api/src/routes/terminologyRoutes.ts). Deliberately imports nothing
 * HAPI/FHIR-specific: which providers show up here (only ones whose
 * `capabilities` include `'manage'`) and what a terminology's identity
 * looks like (`CustomTerminologySummary` - packages/core/terminology) is
 * entirely provider-supplied. See TerminologyBindingEditor in
 * FormBuilder.tsx for how a field then gets bound to one of these.
 */
export default function TerminologyAdmin() {
  useDocumentTitle('Terminologien');
  const { permissions } = useAuth();
  const canPublish = permissions.includes('terminology.publish');

  const [providers, setProviders] = useState<TerminologyProviderSummary[]>([]);
  const [providerId, setProviderId] = useState('');
  const [terminologies, setTerminologies] = useState<CustomTerminologySummary[]>([]);
  const [selected, setSelected] = useState<CustomTerminologySummary | null>(null);
  const [concepts, setConcepts] = useState<TerminologyConcept[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const manageProviders = providers.filter((provider) => provider.capabilities.includes('manage'));

  useEffect(() => {
    request<TerminologyProviderSummary[]>('/terminology/providers')
      .then(setProviders)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  useEffect(() => {
    if (!providerId && manageProviders.length > 0) setProviderId(manageProviders[0].id);
  }, [providers]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadTerminologies = async (pid: string): Promise<CustomTerminologySummary[]> => {
    try {
      const list = await request<CustomTerminologySummary[]>(`/terminology/manage/terminologies?provider=${encodeURIComponent(pid)}`);
      setTerminologies(list);
      return list;
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return []; }
  };
  useEffect(() => { if (providerId) void loadTerminologies(providerId); }, [providerId]);

  const selectTerminology = async (summary: CustomTerminologySummary) => {
    setSelected(summary); setError(''); setNotice(''); setDraft(emptyDraft);
    try { setConcepts(await request<TerminologyConcept[]>(`/terminology/manage/terminologies/${encodeURIComponent(summary.terminologyId)}/concepts?provider=${encodeURIComponent(providerId)}`)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };

  /**
   * Reloads the sidebar list and re-selects `terminologyId` from that fresh
   * response, rather than patching the previous `selected` object by hand -
   * found live (2026-09-04): `upsertConcept`/`removeConcept`'s PUT/DELETE
   * responses are only `{ revision }` (see TerminologyProvider.manage's own
   * contract, packages/core/src/terminology/index.ts), never a full
   * CustomTerminologySummary. Editing a concept on an already-published/
   * retired version implicitly opens a new draft version server-side
   * (resolveMutableDraft in manage.ts) - patching just `revision` onto the
   * stale `selected` silently kept its old, now-wrong `status`/
   * `bindingVersion`/`conceptCount` on screen even though the concepts
   * table itself (fetched fresh) already showed the new version's data, a
   * real split-brain confirmed live. `publish`/`retire` don't need this -
   * their own POST responses already are full, fresh summaries.
   */
  const refreshSelected = async (terminologyId: string) => {
    const list = await loadTerminologies(providerId);
    const fresh = list.find((item) => item.terminologyId === terminologyId);
    if (fresh) await selectTerminology(fresh);
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const createTerminology = () => run(async () => {
    if (!newId.trim() || !newLabel.trim()) { setError('Id und Anzeigename sind erforderlich.'); return; }
    const summary = await request<CustomTerminologySummary>(`/terminology/manage/terminologies?provider=${encodeURIComponent(providerId)}`, { method: 'POST', body: JSON.stringify({ id: newId, label: newLabel }) });
    setNewId(''); setNewLabel('');
    await loadTerminologies(providerId);
    await selectTerminology(summary);
    setNotice(`Terminologie "${summary.label}" angelegt (Draft).`);
  });

  const saveConcept = () => run(async () => {
    if (!selected || !draft.code.trim()) return;
    const terminologyId = selected.terminologyId;
    await request<{ revision: string }>(`/terminology/manage/terminologies/${encodeURIComponent(terminologyId)}/concepts?provider=${encodeURIComponent(providerId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        concept: { namespace: selected.namespace || '', code: draft.code.trim(), display: draft.display.trim() || undefined, definition: draft.definition.trim() || undefined },
        expectedRevision: selected.revision,
      }),
    });
    setDraft(emptyDraft);
    await refreshSelected(terminologyId);
    setNotice(`Konzept "${draft.code}" gespeichert.`);
  });

  const removeConcept = (code: string) => run(async () => {
    if (!selected) return;
    const terminologyId = selected.terminologyId;
    await request<{ revision: string }>(`/terminology/manage/terminologies/${encodeURIComponent(terminologyId)}/concepts/${encodeURIComponent(code)}?provider=${encodeURIComponent(providerId)}&expectedRevision=${encodeURIComponent(selected.revision)}`, { method: 'DELETE' });
    await refreshSelected(terminologyId);
  });

  const publish = () => run(async () => {
    if (!selected) return;
    const summary = await request<CustomTerminologySummary>(`/terminology/manage/terminologies/${encodeURIComponent(selected.terminologyId)}/publish?provider=${encodeURIComponent(providerId)}`, { method: 'POST' });
    await loadTerminologies(providerId);
    // selectTerminology (not just setSelected) - found live (2026-09-04):
    // publish/retire can change which version is now "current"
    // (currentVersion() in manage.ts falls back to a different resource
    // once none is left in draft), and the previously loaded `concepts`
    // array belongs to whatever version was selected before this call. Not
    // refetching left the concepts table silently showing a stale/wrong
    // version's concepts under the new version's own label - confirmed via
    // a real retire (v2 -> back to v1) showing v2's 3 concepts mislabeled
    // as v1's, which only has 2.
    await selectTerminology(summary);
    setNotice(`Version ${summary.bindingVersion} veröffentlicht - ab jetzt unveränderlich. Weitere Bearbeitung öffnet automatisch eine neue Draft-Version.`);
  });

  const retire = () => run(async () => {
    if (!selected || !selected.bindingVersion) return;
    const summary = await request<CustomTerminologySummary>(`/terminology/manage/terminologies/${encodeURIComponent(selected.terminologyId)}/retire?provider=${encodeURIComponent(providerId)}`, { method: 'POST', body: JSON.stringify({ version: selected.bindingVersion }) });
    await loadTerminologies(providerId);
    // See the matching comment in publish() above - same stale-concepts bug.
    await selectTerminology(summary);
    setNotice('Version zurückgezogen - bleibt für bereits gebundene Formulare lesbar, aber nicht mehr neu wählbar.');
  });

  const isDraft = selected?.status === 'draft';

  return (
    <div style={{ padding: '1.5rem', maxWidth: '1100px', margin: '0 auto' }}>
      <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', margin: '0 0 0.3rem' }}><Tags size={22} /> Terminologien</h1>
      <p style={{ color: '#64748b', fontSize: '0.88rem', margin: '0 0 1.25rem' }}>
        Eigene Code-Listen für Dropdown-/Suche-Felder - liegen als versionierte CodeSystem/ValueSet-Ressourcen auf demselben
        Terminologie-Server wie extern importierte Terminologien (ICD-10-GM, SNOMED CT, LOINC, …), siehe die
        Provider-Anbindung im Feld-Konfigurationspanel eines Formulars.
      </p>

      {manageProviders.length === 0 && (
        <div className="card" style={{ padding: '1rem', color: '#64748b' }}>
          Kein Terminologie-Provider mit Verwaltungsfähigkeit ("manage") registriert - ist ein Terminologie-Plugin (z. B. HAPI Terminologie-Server) installiert und aktiviert?
        </div>
      )}

      {manageProviders.length > 0 && (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', fontSize: '0.85rem', marginBottom: '1rem', maxWidth: '24rem' }}>
            Provider
            <select className="form-input" value={providerId} onChange={(e) => { setProviderId(e.target.value); setSelected(null); setConcepts([]); }}>
              {manageProviders.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
            </select>
          </label>

          {error && <div className="card" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', color: '#b91c1c', background: '#fee2e2', border: '1px solid #fecaca' }}>{error}</div>}
          {notice && <div className="card" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', color: '#166534', background: '#f0fdf4', border: '1px solid #bbf7d0' }}>{notice}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: '18rem 1fr', gap: '1.25rem', alignItems: 'start' }}>
            <div className="card" style={{ padding: '1rem' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.6rem' }}>Eigene Terminologien</div>
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {terminologies.map((item) => (
                  <li key={item.terminologyId}>
                    <button
                      type="button"
                      onClick={() => void selectTerminology(item)}
                      style={{
                        width: '100%', textAlign: 'left', padding: '0.45rem 0.6rem', borderRadius: '6px', border: '1px solid transparent',
                        background: selected?.terminologyId === item.terminologyId ? '#eef2ff' : 'transparent', cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontWeight: 500 }}>{item.label}</div>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                        {item.status === 'draft' ? 'Draft' : item.status === 'published' ? `Veröffentlicht · v${item.bindingVersion}` : `Zurückgezogen · v${item.bindingVersion}`}
                        {typeof item.conceptCount === 'number' ? ` · ${item.conceptCount} Konzepte` : ''}
                      </div>
                    </button>
                  </li>
                ))}
                {terminologies.length === 0 && <li style={{ color: '#94a3b8', fontSize: '0.82rem', padding: '0.3rem 0.6rem' }}>Noch keine eigenen Terminologien.</li>}
              </ul>
              <div style={{ borderTop: '1px solid #e2e8f0', marginTop: '0.75rem', paddingTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <input className="form-input" placeholder="id, z. B. interne-medikamentenliste" value={newId} onChange={(e) => setNewId(e.target.value)} />
                <input className="form-input" placeholder="Anzeigename" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void createTerminology()} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'center' }}>
                  <Plus size={16} /> Neue Terminologie
                </button>
              </div>
            </div>

            <div className="card" style={{ padding: '1rem', minHeight: '20rem' }}>
              {!selected && <div style={{ color: '#94a3b8' }}>Terminologie auswählen oder neu anlegen.</div>}
              {selected && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '1.05rem' }}>{selected.label}</div>
                      <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
                        <code>{selected.bindingId}</code> · {selected.status === 'draft' ? 'Draft (bearbeitbar)' : selected.status === 'published' ? `Veröffentlicht, unveränderlich (v${selected.bindingVersion})` : `Zurückgezogen (v${selected.bindingVersion})`}
                      </div>
                    </div>
                    {canPublish && isDraft && (
                      <button type="button" className="btn" disabled={busy || concepts.length === 0} onClick={() => void publish()} title={concepts.length === 0 ? 'Mindestens ein Konzept erforderlich' : undefined} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <Send size={15} /> Veröffentlichen
                      </button>
                    )}
                    {canPublish && selected.status === 'published' && (
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void retire()} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <Archive size={15} /> Zurückziehen
                      </button>
                    )}
                  </div>

                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', borderBottom: '1px solid #e2e8f0', color: '#64748b' }}>
                        <th style={{ padding: '0.35rem' }}>Code</th>
                        <th style={{ padding: '0.35rem' }}>Anzeigetext</th>
                        <th style={{ padding: '0.35rem' }}>Definition</th>
                        <th style={{ padding: '0.35rem' }} />
                      </tr>
                    </thead>
                    <tbody>
                      {concepts.map((concept) => (
                        <tr key={concept.code} style={{ borderBottom: '1px solid #f1f5f9', opacity: concept.active === false ? 0.6 : 1 }}>
                          <td style={{ padding: '0.35rem', fontFamily: 'monospace' }}>{concept.code}{concept.active === false ? ' (inaktiv)' : ''}</td>
                          <td style={{ padding: '0.35rem' }}>{concept.display}</td>
                          <td style={{ padding: '0.35rem', color: '#64748b' }}>{concept.definition}</td>
                          <td style={{ padding: '0.35rem' }}>
                            <button type="button" title="Konzept entfernen" disabled={busy} onClick={() => void removeConcept(concept.code)} style={{ border: 0, background: 'transparent', color: '#b91c1c', cursor: 'pointer' }}><Trash2 size={15} /></button>
                          </td>
                        </tr>
                      ))}
                      {concepts.length === 0 && <tr><td colSpan={4} style={{ padding: '0.5rem', color: '#94a3b8' }}>Noch keine Konzepte.</td></tr>}
                    </tbody>
                  </table>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '0.4rem', marginTop: '0.75rem' }}>
                    <input className="form-input" placeholder="Code" value={draft.code} onChange={(e) => setDraft({ ...draft, code: e.target.value })} />
                    <input className="form-input" placeholder="Anzeigetext" value={draft.display} onChange={(e) => setDraft({ ...draft, display: e.target.value })} />
                    <input className="form-input" placeholder="Definition (optional)" value={draft.definition} onChange={(e) => setDraft({ ...draft, definition: e.target.value })} />
                    <button type="button" className="btn" disabled={busy || !draft.code.trim()} onClick={() => void saveConcept()}>+ Konzept</button>
                  </div>
                  {!isDraft && (
                    <p style={{ marginTop: '0.4rem', fontSize: '0.78rem', color: '#94a3b8' }}>
                      {selected.status === 'published'
                        ? 'Diese Version ist bereits veröffentlicht und unveränderlich - das Speichern eines Konzepts öffnet automatisch eine neue Draft-Version darauf, statt sie zu überschreiben.'
                        : 'Diese Version ist zurückgezogen - das Speichern eines Konzepts öffnet automatisch eine neue Draft-Version.'}
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
