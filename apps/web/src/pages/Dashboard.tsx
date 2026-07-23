import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Search, Plus, FileEdit, Download, Copy, UploadCloud, FolderOpen } from 'lucide-react';

export default function Dashboard() {
  const [forms, setForms] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'draft' | 'published'>('all');
  const navigate = useNavigate();

  useEffect(() => {
    fetchForms();
  }, []);

  const fetchForms = () => {
    fetch('http://localhost:3001/api/forms')
      .then(res => res.json())
      .then(data => setForms(data));
  };

  const handleCreateForm = () => {
    const name = prompt('Enter form name:', 'New Clinical Form');
    if (!name) return;

    fetch('http://localhost:3001/api/forms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    })
      .then(res => res.json())
      .then(data => {
        if (data.form) {
          navigate(`/forms/${data.form.id}/builder`);
        }
      });
  };

  const handlePublish = (id: string) => {
    if (!confirm('Are you sure you want to publish this form? This will create a new version.')) return;
    fetch(`http://localhost:3001/api/forms/${id}/publish`, { method: 'POST' })
      .then(res => res.json())
      .then(() => fetchForms());
  };

  const handleCreateDraft = (id: string) => {
    fetch(`http://localhost:3001/api/forms/${id}/create-draft`, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (data.form) {
          navigate(`/forms/${data.form.id}/builder`);
        }
      });
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

  const filteredForms = displayForms.filter(f => {
    if (filter !== 'all' && f.status !== filter) return false;
    if (searchQuery && !f.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, margin: '0 0 0.5rem 0', letterSpacing: '-0.02em' }}>Dashboard</h1>
          <p style={{ margin: 0, color: 'var(--text-muted)' }}>Manage and version your clinical forms.</p>
        </div>
        <button className="btn" onClick={handleCreateForm}>
          <Plus size={18} /> Create New Form
        </button>
      </div>

      <div className="card" style={{ display: 'flex', gap: '1rem', padding: '1rem 1.5rem', marginBottom: '1.5rem', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input 
            type="text" 
            placeholder="Search forms..." 
            className="form-input" 
            style={{ paddingLeft: '2.5rem' }}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
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
      </div>

      <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', padding: 0 }}>
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Existing Forms</h3>
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
              {filteredForms.map((f: any) => (
                <li key={f.id} style={{ padding: '1.25rem 0', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', transition: 'background-color 0.2s', borderRadius: '8px' }}
                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(0,0,0,0.02)'}
                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                >
                  <div style={{ paddingLeft: '0.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                      <strong style={{ fontSize: '1.05rem', color: 'var(--text-main)' }}>{f.name}</strong>
                      <span className={`badge ${f.status === 'published' ? 'badge-published' : 'badge-draft'}`}>
                        {f.status}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                      <span>Version: <span style={{ fontWeight: 600 }}>v{f.version}</span></span>
                      <span>•</span>
                      <span>Last updated: {new Date(f.updatedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', paddingRight: '0.5rem' }}>
                    {f.status === 'draft' ? (
                      <>
                        <Link to={`/forms/${f.id}/builder`} className="btn btn-secondary btn-icon" title="Edit Draft">
                          <FileEdit size={16} /> Edit
                        </Link>
                        <button className="btn btn-icon" onClick={() => handlePublish(f.id)} title="Publish Form">
                          <UploadCloud size={16} /> Publish
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="btn btn-secondary btn-icon" onClick={() => handleCreateDraft(f.id)} title="Create New Draft from Published">
                          <Copy size={16} /> New Draft
                        </button>
                      </>
                    )}
                    <Link to={`/forms/${f.id}/export`} className="btn btn-secondary btn-icon" title="Export Form">
                      <Download size={16} />
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
