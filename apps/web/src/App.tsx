import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Settings, Puzzle } from 'lucide-react';
import React from 'react';
import Dashboard from './pages/Dashboard';
import FormBuilder from './pages/FormBuilder';
import FormExport from './pages/FormExport';
import SessionRuntime from './pages/SessionRuntime';
import Config from './pages/Config';
import Login from './pages/Login';
import Plugins from './pages/Plugins';
import { FrontendPluginProvider } from './components/FrontendPluginRegistry';
import { registerFrontendPlugin as registerAqlPlugin } from 'formbuilder-plugin-aql-prefill';

function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{ loading: boolean; required: boolean; authenticated: boolean; mode: 'local' | 'hip' }>({ loading: true, required: false, authenticated: false, mode: 'local' });

  const load = React.useCallback(async () => {
    try {
      const response = await fetch('http://localhost:3001/api/auth/me', { credentials: 'include' });
      const data = await response.json();
      setState({ loading: false, required: Boolean(data.authRequired), authenticated: Boolean(data.authenticated), mode: data.mode === 'hip' ? 'hip' : 'local' });
    } catch {
      setState((current) => ({ ...current, loading: false }));
    }
  }, []);

  React.useEffect(() => { void load(); }, [load]);
  if (state.loading) return <div style={{ padding: '2rem' }}>Loading…</div>;
  if (state.required && !state.authenticated) return <Login mode={state.mode} onAuthenticated={() => void load()} />;
  return <>{children}</>;
}
import './App.css';

function AppContent() {
  const location = useLocation();
  const isBuilder = location.pathname.includes('/builder');

  if (isBuilder) {
    return (
      <main style={{ width: '100vw', height: '100vh', overflow: 'hidden', padding: 0, margin: 0 }}>
        <Routes>
          <Route path="/forms/:id/builder" element={<FormBuilder />} />
        </Routes>
      </main>
    );
  }

  return (
    <div className="app-container">
      <nav className="sidebar">
        <div className="sidebar-header">
          <h2>Clinical Form Builder</h2>
        </div>
        <ul className="sidebar-nav">
          <li>
            <Link to="/" className={location.pathname === '/' ? 'active' : ''}>
              <LayoutDashboard size={18} />
              <span>Dashboard</span>
            </Link>
          </li>
          <li>
            <Link to="/config" className={location.pathname === '/config' ? 'active' : ''}>
              <Settings size={18} />
              <span>Settings</span>
            </Link>
          </li>
          <li>
            <Link to="/plugins" className={location.pathname === '/plugins' ? 'active' : ''}>
              <Puzzle size={18} />
              <span>Plugins</span>
            </Link>
          </li>
        </ul>
      </nav>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/config" element={<Config />} />
          <Route path="/plugins" element={<Plugins />} />
          <Route path="/forms/:id/export" element={<FormExport />} />
          <Route path="/forms/:id/runtime" element={<SessionRuntime />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  return (
    <Router>
      <FrontendPluginProvider plugins={[registerAqlPlugin]}>
        <AuthGate><AppContent /></AuthGate>
      </FrontendPluginProvider>
    </Router>
  );
}

export default App;
