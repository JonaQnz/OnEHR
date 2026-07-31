import { Beaker, Book, Info, Code } from 'lucide-react';
import { registeredFunctions } from '../scripting/runtime/registeredFunctions';

export default function FunctionsAdmin() {
  const functionsList = Object.values(registeredFunctions).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      <header style={{ marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Beaker size={32} color="var(--primary)" />
        <div>
          <h1 style={{ margin: 0 }}>Function Library</h1>
          <p style={{ margin: '0.25rem 0 0 0', color: 'var(--text-muted)' }}>
            Overview of all reusable functions registered in the system. These can be used inside Form Scripts via the global <code>functions</code> object.
          </p>
        </div>
      </header>

      {functionsList.length === 0 ? (
        <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          <Info size={48} style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
          <p>No functions registered in the system yet.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '1.5rem' }}>
          {functionsList.map((func) => (
            <div key={func.name} className="card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border)', background: 'var(--surface-sunken)' }}>
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontFamily: 'monospace', color: 'var(--primary)' }}>
                  <Code size={20} />
                  functions.{func.name}
                </h3>
                {func.description && (
                  <p style={{ margin: '0.5rem 0 0 0', color: 'var(--text-muted)' }}>{func.description}</p>
                )}
              </div>
              
              <div style={{ padding: '1.5rem', display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 300px' }}>
                  <h4 style={{ margin: '0 0 1rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Book size={16} /> Parameters
                  </h4>
                  {Object.keys(func.parameters).length > 0 ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                          <th style={{ padding: '0.5rem' }}>Name</th>
                          <th style={{ padding: '0.5rem' }}>Type</th>
                        </tr>
                      </thead>
                      <tbody>
                        {Object.entries(func.parameters).map(([pName, pType]) => (
                          <tr key={pName} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '0.5rem', fontWeight: 500 }}>{pName}</td>
                            <td style={{ padding: '0.5rem', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{String(pType)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No parameters</span>
                  )}
                </div>
                
                <div style={{ flex: '0 0 200px' }}>
                  <h4 style={{ margin: '0 0 1rem 0', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    Returns
                  </h4>
                  <div style={{ 
                    display: 'inline-block', 
                    padding: '0.25rem 0.75rem', 
                    background: 'var(--surface-sunken)', 
                    borderRadius: '4px',
                    fontFamily: 'monospace',
                    border: '1px solid var(--border)'
                  }}>
                    {func.returns}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
