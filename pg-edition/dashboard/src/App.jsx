import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, getToken, setToken } from './api.js';
import { AuthCtx, Loading } from './components/ui.jsx';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Machines from './pages/Machines.jsx';
import MachineDetail from './pages/MachineDetail.jsx';
import AddMachine from './pages/AddMachine.jsx';
import Employees from './pages/Employees.jsx';
import Screenshots from './pages/Screenshots.jsx';
import Activity from './pages/Activity.jsx';
import Rules from './pages/Rules.jsx';
import Policy from './pages/Policy.jsx';
import System from './pages/System.jsx';
import Settings from './pages/Settings.jsx';

export const OrgCtx = createContext({ timezone: 'UTC', name: '' });
export const useOrg = () => useContext(OrgCtx);

const NAV = [
  { section: 'Monitor' },
  { to: '/', label: 'Overview', icon: '◎', end: true },
  { to: '/activity', label: 'Activity & reports', icon: '▤' },
  { to: '/screenshots', label: 'Screenshots', icon: '▣' },
  { section: 'Manage' },
  { to: '/machines', label: 'Machines', icon: '▭' },
  { to: '/employees', label: 'Employees', icon: '◉' },
  { to: '/policy', label: 'Monitoring policy', icon: '⚙' },
  { to: '/rules', label: 'Productivity rules', icon: '✓' },
  { section: 'Admin' },
  { to: '/system', label: 'Database & system', icon: '⛁' },
  { to: '/settings', label: 'Settings', icon: '☰' },
];

export default function App() {
  const [admin, setAdmin] = useState(null);
  const [checking, setChecking] = useState(!!getToken());
  const [org, setOrg] = useState({ timezone: 'UTC', name: '' });
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  useEffect(() => {
    const onLogout = () => setAdmin(null);
    window.addEventListener('em:logout', onLogout);
    if (getToken()) {
      api('/auth/me').then((r) => setAdmin(r.admin)).catch(() => setToken(null)).finally(() => setChecking(false));
    }
    return () => window.removeEventListener('em:logout', onLogout);
  }, []);

  useEffect(() => {
    if (admin) api('/settings').then((s) => setOrg(s.org)).catch(() => {});
  }, [admin]);

  if (checking) return <Loading />;
  if (!admin) return <Login onLogin={(a) => setAdmin(a)} />;

  const logout = () => { setToken(null); setAdmin(null); };

  return (
    <AuthCtx.Provider value={{ admin, logout }}>
      <OrgCtx.Provider value={{ ...org, setOrg }}>
        <div className="mobile-bar">
          <button className="ghost" aria-label="Menu" onClick={() => setMenuOpen((o) => !o)}>☰</button>
          <b>EmpMonitor</b>
        </div>
        <div className="app">
          <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
            <div className="brand"><img src="/favicon.svg" alt="" />EmpMonitor</div>
            <nav className="nav">
              {NAV.map((n) => (n.section
                ? <div key={n.section} className="section">{n.section}</div>
                : (
                  <NavLink key={n.to} to={n.to} end={n.end}>
                    <span aria-hidden style={{ width: 16, textAlign: 'center' }}>{n.icon}</span>{n.label}
                  </NavLink>
                )))}
            </nav>
            <div className="foot">
              <div style={{ color: 'var(--text)', fontWeight: 500 }}>{admin.name || admin.email}</div>
              <div className="row between">
                <span>{admin.role === 'admin' ? 'Administrator' : 'Viewer'}</span>
                <button className="ghost sm" onClick={logout}>Sign out</button>
              </div>
            </div>
          </aside>
          <main className="main">
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/screenshots" element={<Screenshots />} />
              <Route path="/machines" element={<Machines />} />
              <Route path="/machines/add" element={<AddMachine />} />
              <Route path="/machines/:id" element={<MachineDetail />} />
              <Route path="/employees" element={<Employees />} />
              <Route path="/policy" element={<Policy />} />
              <Route path="/rules" element={<Rules />} />
              <Route path="/system" element={<System />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </main>
        </div>
      </OrgCtx.Provider>
    </AuthCtx.Provider>
  );
}
