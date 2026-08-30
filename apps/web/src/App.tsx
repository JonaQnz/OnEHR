import { BrowserRouter as Router, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import { LayoutDashboard, Settings, Puzzle, UserRound, Beaker, UsersRound, LogOut, BarChart3 } from 'lucide-react';
import React from 'react';
import Login from './pages/Login';
// Every other page is route-level code-split: each pulls its own bundle in on
// first visit instead of all of them loading upfront. FormBuilder and
// CompositionBuilder in particular drag in react-form-builder2 (draft-js,
// react-datepicker, react-select, ...), which was most of the single ~2.3MB
// startup chunk this app used to ship for every route, including the ones
// nobody but a form designer ever opens.
const Dashboard = React.lazy(() => import('./pages/Dashboard'));
const FormBuilder = React.lazy(() => import('./pages/FormBuilder'));
const FormExport = React.lazy(() => import('./pages/FormExport'));
const SessionRuntime = React.lazy(() => import('./pages/SessionRuntime'));
const Config = React.lazy(() => import('./pages/Config'));
const Plugins = React.lazy(() => import('./pages/Plugins'));
const FunctionsAdmin = React.lazy(() => import('./pages/FunctionsAdmin'));
const WidgetsAdmin = React.lazy(() => import('./pages/WidgetsAdmin'));
const UsersAdmin = React.lazy(() => import('./pages/UsersAdmin'));
const LiveForm = React.lazy(() => import('./pages/LiveForm'));
const CompositionBuilder = React.lazy(() => import('./pages/CompositionBuilder'));
const CompositionRuntime = React.lazy(() => import('./pages/CompositionRuntime'));
const PatientList = React.lazy(() => import('./pages/patients/PatientList'));
const PatientDetail = React.lazy(() => import('./pages/patients/PatientDetail'));
import { FrontendPluginProvider } from './components/FrontendPluginRegistry';
import type { FrontendPluginRegistration } from 'plugin-api';
import { loadFrontendPluginRegistrations } from './plugins/frontendPluginCatalog';
import './App.css';

type AuthState = { loading: boolean; authenticated: boolean; mode: 'local' | 'hip' | 'disabled-development-only'; user?: { id: string; displayName: string; authSource: string; email?: string }; roles: string[]; permissions: string[]; reload: () => Promise<void> };
const AuthStateContext = React.createContext<AuthState | null>(null);
function useAuth(): AuthState { const state = React.useContext(AuthStateContext); if (!state) throw new Error('Auth state unavailable'); return state; }
function Can({ permission, children }: { permission: string; children: React.ReactNode }) { return useAuth().permissions.includes(permission) ? <>{children}</> : null; }
function Protected({ permission, children }: { permission: string; children: React.ReactNode }) { return useAuth().permissions.includes(permission) ? <>{children}</> : <Navigate to="/" replace />; }
// Exported so a page that embeds another routed page's component directly
// (e.g. PatientDetail embedding CompositionRuntime for the Klinisches-
// Cockpit tab) can check the same permission the standalone route enforces
// via <Protected> - gating whether to show that content at all, rather
// than rendering it and having <Protected>'s own <Navigate> yank the whole
// app away from a page it's merely embedded in.
export { useAuth };

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
  if (isBuilder || location.pathname.includes('/composition-builder')) return <main style={{ width: '100vw', height: '100vh', overflow: 'auto', padding: 0, margin: 0 }}><React.Suspense fallback={<div style={{ padding: '2rem' }}>Loading…</div>}><Routes><Route path="/forms/:id/builder" element={<Protected permission="form.design"><FormBuilder /></Protected>} /><Route path="/compositions/:id/builder" element={<Protected permission="form.design"><CompositionBuilder /></Protected>} /></Routes></React.Suspense></main>;
  return <div className="app-container"><nav className="sidebar"><div className="sidebar-header"><img src="/onehr-logo.png" alt="OnEHR" style={{ width: '100%', maxWidth: 170, height: 'auto' }} /></div><ul className="sidebar-nav">
    <li><Link to="/" className={location.pathname === '/' ? 'active' : ''}><LayoutDashboard size={18} /><span>Bibliothek</span></Link></li>
    <li><Link to="/patients" className={location.pathname.startsWith('/patients') ? 'active' : ''}><UserRound size={18} /><span>Patienten</span></Link></li>
    <Can permission="system.configure"><li><Link to="/config" className={location.pathname === '/config' ? 'active' : ''}><Settings size={18} /><span>Settings</span></Link></li></Can>
    <Can permission="plugin.configure"><li><Link to="/plugins" className={location.pathname === '/plugins' ? 'active' : ''}><Puzzle size={18} /><span>Plugins</span></Link></li></Can>
    <Can permission="form.design"><li><Link to="/functions" className={location.pathname === '/functions' ? 'active' : ''}><Beaker size={18} /><span>Functions</span></Link></li></Can>
    <Can permission="form.design"><li><Link to="/widgets" className={location.pathname === '/widgets' ? 'active' : ''}><BarChart3 size={18} /><span>Widgets</span></Link></li></Can>
    <Can permission="user.manage"><li><Link to="/admin/users" className={location.pathname === '/admin/users' ? 'active' : ''}><UsersRound size={18} /><span>Users</span></Link></li></Can>
  </ul><div style={{ marginTop: 'auto', padding: '1rem', borderTop: '1px solid var(--border)' }}><div style={{ fontSize: '.85rem', marginBottom: '.5rem' }}>{auth.user?.displayName}</div><button className="btn secondary" onClick={() => void logout()} style={{ width: '100%', justifyContent: 'center' }}><LogOut size={16} /> Logout</button></div></nav>
  <main className="main-content"><React.Suspense fallback={<div style={{ padding: '2rem' }}>Loading…</div>}><Routes><Route path="/" element={<Dashboard />} /><Route path="/patients" element={<PatientList />} /><Route path="/patients/:id" element={<PatientDetail />} /><Route path="/config" element={<Protected permission="system.configure"><Config /></Protected>} /><Route path="/plugins" element={<Protected permission="plugin.configure"><Plugins /></Protected>} /><Route path="/functions" element={<Protected permission="form.design"><FunctionsAdmin /></Protected>} /><Route path="/widgets" element={<Protected permission="form.design"><WidgetsAdmin /></Protected>} /><Route path="/admin/users" element={<Protected permission="user.manage"><UsersAdmin /></Protected>} /><Route path="/forms/:id/export" element={<Protected permission="form.design"><FormExport /></Protected>} /><Route path="/forms/:id/runtime" element={<SessionRuntime />} /><Route path="/compositions/:id" element={<Protected permission="form.execute"><CompositionRuntime /></Protected>} /></Routes></React.Suspense></main></div>;
}
function App() { const [frontendPlugins, setFrontendPlugins] = React.useState<FrontendPluginRegistration[]>([]); React.useEffect(() => { void loadFrontendPluginRegistrations().then(setFrontendPlugins).catch((error: unknown) => console.error('[PLUGIN] Failed to load frontend plugins', error)); }, []); return <Router><FrontendPluginProvider plugins={frontendPlugins}><AuthGate><React.Suspense fallback={<div style={{ padding: '2rem' }}>Loading…</div>}><Routes><Route path="/live/:parentId" element={<LiveForm />} /><Route path="/embed/forms/:parentId" element={<LiveForm />} /><Route path="*" element={<AppContent />} /></Routes></React.Suspense></AuthGate></FrontendPluginProvider></Router>; }
export default App;
