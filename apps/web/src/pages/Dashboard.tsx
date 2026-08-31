import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, Plus, FileEdit, Download, Copy, UploadCloud, FolderOpen, ExternalLink, Archive, RotateCcw, ChevronDown, ChevronRight, Trash2, LayoutPanelTop, BarChart3 } from 'lucide-react';
import { CreateFormModal } from '../components/CreateFormModal';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { API_BASE_URL } from '../integration/apiBaseUrl';

type LibraryTab = 'forms' | 'sections' | 'widgets';

const TABS: Array<{ id: LibraryTab; label: string }> = [
  { id: 'forms', label: 'Forms' },
  { id: 'sections', label: 'Form Sections' },
  { id: 'widgets', label: 'Widget Segments' },
];

type WidgetSegment = { id: string; name: string; description: string; enabled: boolean; configuration: { display: string; packageName?: string } };

export default function Dashboard() {
  useDocumentTitle('Bibliothek');
  const [activeTab, setActiveTab] = useState<LibraryTab>('forms');
  const [forms, setForms] = useState<any[]>([]);
  const [loadError, setLoadError] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'draft' | 'published'>('all');
  const [viewDeleted, setViewDeleted] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [createModalKind, setCreateModalKind] = useState<'form' | 'composition' | null>(null);
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [remoteTemplates, setRemoteTemplates] = useState<any[]>([]);

  const [widgetSegments, setWidgetSegments] = useState<WidgetSegment[]>([]);
  const [widgetsLoadError, setWidgetsLoadError] = useState('');
  const [widgetsLoading, setWidgetsLoading] = useState(true);

  useEffect(() => {
    void fetchForms();
    fetch(`${API_BASE_URL}/templates/remote`)
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) setRemoteTemplates(data);
      })
      .catch(err => console.error(err));
  }, []);

  useEffect(() => {
    if (activeTab !== 'widgets' || widgetSegments.length > 0) return;
    void fetchWidgetSegments();
  }, [activeTab]);

  const fetchForms = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/forms`);
      const data: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error('Formulare konnten nicht geladen werden.');
      if (!Array.isArray(data)) throw new Error('Die API hat keine Formularliste zurückgegeben.');
      setForms(data);
      setLoadError('');
    } catch (error) {
      console.error('Failed to load forms:', error);
      setForms([]);
      setLoadError(error instanceof Error ? error.message : 'Formulare konnten nicht geladen werden.');
    }
  };

  const fetchWidgetSegments = async () => {
    setWidgetsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/widgets`, { credentials: 'include' });
      const data: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error('Widget Segments konnten nicht geladen werden.');
      const list = Array.isArray(data) ? data : Array.isArray((data as any)?.widgets) ? (data as any).widgets : [];
      setWidgetSegments(list);
      setWidgetsLoadError('');
    } catch (error) {
      console.error('Failed to load widget segments:', error);
      setWidgetSegments([]);
      setWidgetsLoadError(error instanceof Error ? error.message : 'Widget Segments konnten nicht geladen werden.');
    } finally {
      setWidgetsLoading(false);
    }
  };

  const handleFormCreated = (form: any) => {
    setCreateModalKind(null);
    const isComposition = Boolean(form.canonical_json?.extensions?.['watehr.composition']);
    navigate(isComposition ? `/compositions/${form.id}/builder` : `/forms/${form.id}/builder`);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        const res = await fetch(`${API_BASE_URL}/forms/import/full`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(json)
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          alert(`Import failed: ${errData.error || errData.message || 'Unknown error'}`);
          return;
        }

        const data = await res.json();
        alert('Form imported successfully!');
        fetchForms();
        if (data.form) {
          navigate(`/forms/${data.form.id}/builder`);
        }
      } catch (err) {
        alert('Failed to parse JSON file or invalid JSON structure.');
      }
    };
    reader.readAsText(file);

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handlePublish = (id: string) => {
    if (!confirm('Are you sure you want to publish this form? This will create a new version.')) return;
    fetch(`${API_BASE_URL}/forms/${id}/publish`, { method: 'POST' })
      .then(res => res.json())
      .then(() => fetchForms());
  };

  const handleCreateDraft = (id: string, isComposition: boolean) => {
    fetch(`${API_BASE_URL}/forms/${id}/create-draft`, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (data.form) {
          navigate(isComposition ? `/compositions/${data.form.id}/builder` : `/forms/${data.form.id}/builder`);
        }
      });
  };

  const handleArchive = (id: string) => {
    if (!confirm('Are you sure you want to archive/shut off this version? It will no longer be active.')) return;
    fetch(`${API_BASE_URL}/forms/${id}/archive`, { method: 'POST' })
      .then(() => fetchForms());
  };

  const handleRestore = (id: string, isComposition: boolean) => {
    if (!confirm('Are you sure you want to restore this version? It will create a new draft from this layout.')) return;
    fetch(`${API_BASE_URL}/forms/${id}/restore`, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (data.form) {
          navigate(isComposition ? `/compositions/${data.form.id}/builder` : `/forms/${data.form.id}/builder`);
        }
      });
  };

  const handleDelete = (id: string) => {
    if (!confirm('Are you sure you want to delete this form?')) return;
    fetch(`${API_BASE_URL}/forms/${id}/delete`, { method: 'POST' })
      .then(() => fetchForms());
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  // Grouping logic: group by parent_id or id if parent_id is null.
  // Within a group, we sort by creation date desc to find the "latest".
  const groupedForms = forms.reduce((acc, form) => {
    const groupId = form.parent_id || form.id;
    if (!acc[groupId]) {
      acc[groupId] = [];
    }
    acc[groupId].push(form);
    return acc;
  }, {} as Record<string, any[]>);

  // Get the latest form for each group for display
  const displayForms = (Object.values(groupedForms) as any[]).map(group => {
    return group.sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
  });

  // Tab 1 (Forms) shows compositions - the page/block assemblies. Tab 2
  // (Form Sections) shows everything else - the atomic, single-archetype
  // building blocks. Same underlying /api/forms records either way, split
  // purely by the watehr.composition extension's presence.
  const filteredForms = displayForms.filter(f => {
    const isComposition = Boolean(f.canonical_json?.extensions?.['watehr.composition']);
    if (activeTab === 'forms' && !isComposition) return false;
    if (activeTab === 'sections' && isComposition) return false;
    if (viewDeleted) {
      if (f.status !== 'deleted') return false;
    } else {
      if (f.status === 'deleted') return false;
      if (filter !== 'all' && f.status !== filter) return false;
    }
    if (searchQuery && !f.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const filteredWidgetSegments = widgetSegments.filter(w => !searchQuery || w.name.toLowerCase().includes(searchQuery.toLowerCase()));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, margin: '0 0 0.5rem 0', letterSpacing: '-0.02em' }}>Bibliothek</h1>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>Forms, Form Sections und Widget Segments verwalten und versionieren.</p>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          {activeTab !== 'widgets' && (
            <>
              <input
                type="file"
                ref={fileInputRef}
                style={{ display: 'none' }}
                accept=".json"
                onChange={handleFileChange}
              />
              <button className="btn btn-secondary" onClick={handleImportClick}>
                <UploadCloud size={18} /> Import Form
              </button>
            </>
          )}
          {activeTab === 'forms' && (
            <button className="btn" onClick={() => setCreateModalKind('composition')}>
              <LayoutPanelTop size={18} /> Neue Form
            </button>
          )}
          {activeTab === 'sections' && (
            <button className="btn" onClick={() => setCreateModalKind('form')}>
              <Plus size={18} /> Neue Form Section
            </button>
          )}
          {activeTab === 'widgets' && (
            <Link className="btn" to="/widgets">
              <BarChart3 size={18} /> Neues Widget Segment
            </Link>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.35rem', marginBottom: '1.5rem', borderBottom: '1px solid var(--border)' }}>
        {TABS.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--primary)' : '2px solid transparent',
              color: activeTab === tab.id ? 'var(--text-main)' : 'var(--text-muted)',
              fontWeight: activeTab === tab.id ? 600 : 500,
              fontSize: '0.95rem',
              padding: '0.7rem 1rem',
              cursor: 'pointer',
              marginBottom: '-1px',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {loadError && activeTab !== 'widgets' && (
        <div className="card" style={{ marginBottom: '1.5rem', color: 'var(--danger-hover)', borderColor: '#fecaca' }}>
          {loadError}
        </div>
      )}
      {widgetsLoadError && activeTab === 'widgets' && (
        <div className="card" style={{ marginBottom: '1.5rem', color: 'var(--danger-hover)', borderColor: '#fecaca' }}>
          {widgetsLoadError}
        </div>
      )}

      <div className="card" style={{ display: 'flex', gap: '1rem', padding: '1rem 1.5rem', marginBottom: '1.5rem', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            type="text"
            placeholder={activeTab === 'widgets' ? 'Search widget segments...' : 'Search forms...'}
            className="form-input"
            style={{ paddingLeft: '2.5rem' }}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        {activeTab !== 'widgets' && !viewDeleted && (
          <select
            className="form-input"
            style={{ width: 'auto', minWidth: '150px' }}
            value={filter}
            onChange={e => setFilter(e.target.value as any)}
          >
            <option value="all">All Statuses</option>
            <option value="draft">Drafts</option>
            <option value="published">Published</option>
          </select>
        )}
        {activeTab !== 'widgets' && (
          <button
            className={`btn ${viewDeleted ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setViewDeleted(!viewDeleted)}
          >
            <Trash2 size={18} /> {viewDeleted ? 'Back to Forms' : 'Deleted Forms'}
          </button>
        )}
      </div>

      {activeTab === 'widgets' ? (
        <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
          <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border)' }}>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Widget Segments</h3>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 1.5rem 1.5rem 1.5rem' }}>
            {widgetsLoading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>Lädt…</div>
            ) : filteredWidgetSegments.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem 2rem', color: 'var(--text-muted)' }}>
                <BarChart3 size={48} style={{ opacity: 0.5, marginBottom: '1rem' }} />
                <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', color: 'var(--text-main)' }}>Noch keine Widget Segments</h4>
                <p style={{ margin: '0 0 1rem', textAlign: 'center', maxWidth: 420 }}>
                  Widget Segments sind wiederverwendbare klinische Datenkarten (Kennzahl, Tabelle, Diagramm), die in Forms
                  eingebettet werden können. Die Erstellung als eigenständiger Baustein hier in der Bibliothek folgt bald -
                  bis dahin über die Widgets-Verwaltung anlegen.
                </p>
                <Link className="btn" to="/widgets"><BarChart3 size={16} /> Zu den Widgets</Link>
              </div>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {filteredWidgetSegments.map(w => (
                  <li key={w.id} style={{ borderBottom: '1px solid var(--border)', padding: '1.25rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                        <strong style={{ fontSize: '1.05rem', color: 'var(--text-main)' }}>{w.name}</strong>
                        <span className={`badge ${w.enabled ? 'badge-published' : 'badge-archived'}`}>{w.enabled ? 'enabled' : 'disabled'}</span>
                        <span className="badge" style={{ background: '#eef2ff', color: '#4338ca' }}>{w.configuration?.display}</span>
                      </div>
                      {w.description && <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{w.description}</div>}
                    </div>
                    <Link to="/widgets" className="btn btn-secondary btn-icon" title="In Widgets-Verwaltung öffnen">
                      <FileEdit size={16} /> Bearbeiten
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
      <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>
            {viewDeleted ? 'Deleted Forms (Papierkorb)' : activeTab === 'forms' ? 'Existing Forms' : 'Existing Form Sections'}
          </h3>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 1.5rem 1.5rem 1.5rem' }}>
          {filteredForms.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '4rem 2rem', color: 'var(--text-muted)' }}>
              <FolderOpen size={48} style={{ opacity: 0.5, marginBottom: '1rem' }} />
              <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem', color: 'var(--text-main)' }}>No forms found</h4>
              <p style={{ margin: 0, textAlign: 'center' }}>Create a new form or adjust your search filters to see results.</p>
            </div>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {filteredForms.map((f: any) => {
                const groupId = f.parent_id || f.id;
                const isExpanded = expandedGroups[groupId];
                const history = groupedForms[groupId].filter((v: any) => v.id !== f.id).sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

                const tpl = f.canonical_json?.sourceTemplates?.[0];
                const templateId = tpl ? tpl.id : f.canonical_json?.templateId;
                const isTemplateOnServer = templateId ? remoteTemplates.some((t: any) => t.template_id === templateId) : false;
                const isComposition = Boolean(f.canonical_json?.extensions?.['watehr.composition']);

                return (
                  <li key={groupId} style={{ borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: '1.25rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', transition: 'background-color 0.2s', borderRadius: '8px' }}
                        onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.02)'}
                        onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                    >
                      <div style={{ paddingLeft: '0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        {history.length > 0 ? (
                          <button onClick={() => toggleGroup(groupId)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}>
                            {isExpanded ? <ChevronDown size={20} /> : <ChevronRight size={20} />}
                          </button>
                        ) : (
                          <div style={{ width: 20 }}></div>
                        )}
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                            <strong style={{ fontSize: '1.05rem', color: 'var(--text-main)' }}>{f.name}</strong>
                            {isComposition && <span className="badge badge-published" style={{ background: '#eef2ff', color: '#4338ca' }}>form</span>}
                            <span className={`badge ${f.status === 'published' ? 'badge-published' : f.status === 'archived' ? 'badge-archived' : f.status === 'deleted' ? 'badge-archived' : 'badge-draft'}`}>
                              {f.status}
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                            <span>Version: <span style={{ fontWeight: 600 }}>v{f.version}</span></span>
                            <span>•</span>
                            <span>Last updated: {new Date(f.updatedAt).toLocaleDateString()}</span>
                            {templateId && (
                              <>
                                <span>•</span>
                                <span>
                                  Template: <span style={{ fontFamily: 'monospace' }}>{templateId}</span>
                                  {remoteTemplates.length > 0 && (
                                    isTemplateOnServer
                                      ? <span style={{ color: '#16a34a', marginLeft: '0.35rem', fontWeight: 600 }} title="Template is available on the server">✓ Active</span>
                                      : <span style={{ color: '#dc2626', marginLeft: '0.35rem', fontWeight: 600 }} title="Template NOT found on server">⚠️ Missing on Server</span>
                                  )}
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', paddingRight: '0.5rem' }}>
                        {f.status === 'draft' && (
                          <>
                            <Link to={isComposition ? `/compositions/${f.id}/builder` : `/forms/${f.id}/builder`} className="btn btn-secondary btn-icon" title="Edit Draft">
                              <FileEdit size={16} /> Edit
                            </Link>
                            <button className="btn btn-icon" onClick={() => handlePublish(f.id)} title="Publish Form">
                              <UploadCloud size={16} /> Publish
                            </button>
                            <button className="btn btn-secondary btn-icon" onClick={() => handleDelete(f.id)} title="Delete Form" style={{ color: '#b91c1c' }}>
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                        {f.status === 'published' && (
                          <>
                            <Link to={isComposition ? `/compositions/${f.id}` : `/live/${groupId}`} target="_blank" className="btn btn-secondary btn-icon" title="Open Live Form">
                              <ExternalLink size={16} /> Live
                            </Link>
                            <button className="btn btn-secondary btn-icon" onClick={() => handleCreateDraft(f.id, isComposition)} title="Create New Draft from Published">
                              <Copy size={16} /> New Draft
                            </button>
                            <button className="btn btn-secondary btn-icon" onClick={() => handleArchive(f.id)} title="Archive / Shut Off">
                              <Archive size={16} />
                            </button>
                            <button className="btn btn-secondary btn-icon" onClick={() => handleDelete(f.id)} title="Delete Form" style={{ color: '#b91c1c' }}>
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                        {f.status === 'archived' && (
                          <>
                            <button className="btn btn-secondary btn-icon" onClick={() => handleRestore(f.id, isComposition)} title="Restore as Draft">
                              <RotateCcw size={16} /> Restore
                            </button>
                            <button className="btn btn-secondary btn-icon" onClick={() => handleDelete(f.id)} title="Delete Form" style={{ color: '#b91c1c' }}>
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                        {f.status === 'deleted' && (
                          <button className="btn btn-secondary btn-icon" onClick={() => handleRestore(f.id, isComposition)} title="Restore as Draft">
                            <RotateCcw size={16} /> Restore
                          </button>
                        )}
                        <Link to={`/forms/${f.id}/export`} className="btn btn-secondary btn-icon" title="Export Form">
                          <Download size={16} />
                        </Link>
                      </div>
                    </div>

                    {isExpanded && history.length > 0 && (
                      <div style={{ padding: '0 0 1rem 3.5rem' }}>
                        <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.9rem', color: 'var(--text-muted)' }}>Version History</h4>
                        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                          {history.map((v: any) => (
                            <li key={v.id} style={{ padding: '0.75rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px dashed var(--border)' }}>
                              <div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                                  <span style={{ fontSize: '0.95rem' }}>v{v.version}</span>
                                  <span className={`badge ${v.status === 'published' ? 'badge-published' : v.status === 'archived' ? 'badge-archived' : v.status === 'deleted' ? 'badge-archived' : 'badge-draft'}`} style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem' }}>
                                    {v.status}
                                  </span>
                                </div>
                                <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                                  {new Date(v.createdAt).toLocaleDateString()} {new Date(v.createdAt).toLocaleTimeString()}
                                </div>
                              </div>
                              <div style={{ display: 'flex', gap: '0.5rem' }}>
                                {v.status === 'published' && (
                                  <button className="btn btn-secondary btn-icon" onClick={() => handleArchive(v.id)} title="Archive">
                                    <Archive size={14} />
                                  </button>
                                )}
                                {v.status !== 'deleted' && (
                                  <>
                                    <button className="btn btn-secondary btn-icon" onClick={() => handleRestore(v.id, isComposition)} title="Restore to new Draft">
                                      <RotateCcw size={16} />
                                    </button>
                                    <button className="btn btn-secondary btn-icon" onClick={() => handleDelete(v.id)} title="Delete Form" style={{ color: '#b91c1c' }}>
                                      <Trash2 size={14} />
                                    </button>
                                  </>
                                )}
                                {v.status === 'deleted' && (
                                  <button className="btn btn-secondary btn-icon" onClick={() => handleRestore(v.id, isComposition)} title="Restore to new Draft">
                                    <RotateCcw size={16} />
                                  </button>
                                )}
                                <Link to={`/forms/${v.id}/export`} className="btn btn-secondary btn-icon" title="Export">
                                  <Download size={14} />
                                </Link>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
      )}

      {createModalKind && (
        <CreateFormModal
          kind={createModalKind}
          onClose={() => setCreateModalKind(null)}
          onCreated={handleFormCreated}
        />
      )}
    </div>
  );
}
