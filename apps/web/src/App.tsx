import { BrowserRouter as Router, Routes, Route, Link, useLocation } from 'react-router-dom';
import { LayoutDashboard, Settings } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import FormBuilder from './pages/FormBuilder';
import FormExport from './pages/FormExport';
import Config from './pages/Config';
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
        </ul>
      </nav>
      <main className="main-content">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/config" element={<Config />} />
          <Route path="/forms/:id/export" element={<FormExport />} />
        </Routes>
      </main>
    </div>
  );
}

function App() {
  return (
    <Router>
      <AppContent />
    </Router>
  );
}

export default App;
