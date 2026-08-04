import { BrowserRouter as Router, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Settings, Puzzle, UserRound, Beaker, UsersRound, LogOut } from 'lucide-react';
import React from 'react';
import Dashboard from './pages/Dashboard';
import FormBuilder from './pages/FormBuilder';
import FormExport from './pages/FormExport';
import SessionRuntime from './pages/SessionRuntime';
import Config from './pages/Config';
import Login from './pages/Login';
import Plugins from './pages/Plugins';
import FunctionsAdmin from './pages/FunctionsAdmin';
import UsersAdmin from './pages/UsersAdmin';
import LiveForm from './pages/LiveForm';
import PatientList from './pages/patients/PatientList';
import PatientDetail from './pages/patients/PatientDetail';
import { FrontendPluginProvider } from './components/FrontendPluginRegistry';
import type { FrontendPluginRegistration } from 'plugin-api';
import { loadFrontendPluginRegistrations } from './plugins/frontendPluginCatalog';
import './App.css';

type AuthState = { loading: boolean; authenticated: boolean; mode: 'local' | 'hip' | 'disabled-development-only'; user?: { id: string; displayName: string; authSource: string; email?: string }; roles: string[]; permissions: string[]; reload: () => Promise<void> };
const AuthStateContext = React.createContext<AuthState | null>(null);
function useAuth(): AuthState { const state = React.useContext(AuthStateContext); if (!state) throw new Error('Auth state unavailable'); return state; }
function Can({ permission, children }: { permission: string; children: React.ReactNode }) { return useAuth().permissions.includes(permission) ? <>{children}</> : null; }
function Protected({ permission, children }: { permission: string; children: React.ReactNode }) { return useAuth().permissions.includes(permission) ? <>{children}</> : <Navigate to="/" replace />; }

function AuthGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<Omit<AuthState, 'reload'>>({ loading: true, authenticated: false, mode: 'local', roles: [], permissions: [] });
  const reload = React.useCallback(async () => {
    try { const response = await fetch('http://localhost:3001/api/auth/me', { credentials: 'include' }); const data = await response.json(); setState({ loading: false, authenticated: Boolean(data.authenticated), mode: data.mode === 'hip' || data.mode === 'disabled-development-only' ? data.mode : 'local', user: data.user || undefined, roles: Array.isArray(data.roles) ? data.roles : [], permissions: Array.isArray(data.permissions) ? data.permissions : [] }); }
    catch { setState((current) => ({ ...current, loading: false })); }
  }, []);
  React.useEffect(() => { void reload(); }, [reload]);
  if (state.loading) return <div style={{ padding: '2rem' }}>Loading…</div>;
  if (!state.authenticated) return <Login mode={state.mode === 'hip' ? 'hip' : 'local'} onAuthenticated={reload} />;
  return <AuthStateContext.Provider value={{ ...state, reload }}>{children}</AuthStateContext.Provider>;
}

function AppContent() {
  const location = useLocation(); const auth = useAuth(); const isBuilder = location.pathname.includes('/builder');
  const logout = async () => { await fetch('http://localhost:3001/api/auth/logout', { method: 'POST', credentials: 'include' }); await auth.reload(); };
  if (isBuilder) return <main style={{ width: '100vw', height: '100vh', overflow: 'hidden', padding: 0, margin: 0 }}><Routes><Route path="/forms/:id/builder" element={<Protected permission="form.design"><FormBuilder /></Protected>} /></Routes></main>;
  return <div className="app-container"><nav className="sidebar"><div className="sidebar-header"><h2>Clinical Form Builder</h2></div><ul className="sidebar-nav">
    <li><Link to="/" className={location.pathname === '/' ? 'active' : ''}><LayoutDashboard size={18} /><span>Dashboard</span></Link></li>
    <li><Link to="/patients" className={location.pathname.startsWith('/patients') ? 'active' : ''}><UserRound size={18} /><span>Patienten</span></Link></li>
    <Can permission="system.configure"><li><Link to="/config" className={location.pathname === '/config' ? 'active' : ''}><Settings size={18} /><span>Settings</span></Link></li></Can>
    <Can permission="plugin.configure"><li><Link to="/plugins" className={location.pathname === '/plugins' ? 'active' : ''}><Puzzle size={18} /><span>Plugins</span></Link></li></Can>
    <Can permission="form.design"><li><Link to="/functions" className={location.pathname === '/functions' ? 'active' : ''}><Beaker size={18} /><span>Functions</span></Link></li></Can>
    <Can permission="user.manage"><li><Link to="/admin/users" className={location.pathname === '/admin/users' ? 'active' : ''}><UsersRound size={18} /><span>Users</span></Link></li></Can>
  </ul><div style={{ marginTop: 'auto', padding: '1rem', borderTop: '1px solid var(--border)' }}><div style={{ fontSize: '.85rem', marginBottom: '.5rem' }}>{auth.user?.displayName}</div><button className="btn secondary" onClick={() => void logout()} style={{ width: '100%', justifyContent: 'center' }}><LogOut size={16} /> Logout</button></div></nav>
  <main className="main-content"><Routes><Route path="/" element={<Dashboard />} /><Route path="/patients" element={<PatientList />} /><Route path="/patients/:id" element={<PatientDetail />} /><Route path="/config" element={<Protected permission="system.configure"><Config /></Protected>} /><Route path="/plugins" element={<Protected permission="plugin.configure"><Plugins /></Protected>} /><Route path="/functions" element={<Protected permission="form.design"><FunctionsAdmin /></Protected>} /><Route path="/admin/users" element={<Protected permission="user.manage"><UsersAdmin /></Protected>} /><Route path="/forms/:id/export" element={<Protected permission="form.design"><FormExport /></Protected>} /><Route path="/forms/:id/runtime" element={<SessionRuntime />} /></Routes></main></div>;
}
function App() { const [frontendPlugins, setFrontendPlugins] = React.useState<FrontendPluginRegistration[]>([]); React.useEffect(() => { void loadFrontendPluginRegistrations().then(setFrontendPlugins).catch((error: unknown) => console.error('[PLUGIN] Failed to load frontend plugins', error)); }, []); return <Router><FrontendPluginProvider plugins={frontendPlugins}><AuthGate><Routes><Route path="/live/:parentId" element={<LiveForm />} /><Route path="/embed/forms/:parentId" element={<LiveForm />} /><Route path="*" element={<AppContent />} /></Routes></AuthGate></FrontendPluginProvider></Router>; }
export default App;
