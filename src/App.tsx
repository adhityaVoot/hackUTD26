import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useSpacetimeDB, useTable } from 'spacetimedb/react';
import { tables } from './module_bindings/index.ts';
import { ToastProvider } from './lib/toast.tsx';
import { LiveProvider } from './kitchen/live.tsx';
import KitchenTable from './kitchen/KitchenTable.jsx';
import { JoinScreen } from './screens/Join.tsx';
import { SetupScreen } from './screens/Setup.tsx';
import { PrivacyScreen } from './screens/Privacy.tsx';
import { VitalsScreen } from './screens/Vitals.tsx';
import './styles/app.css';

const OPEN_PATHS = new Set(['/join', '/setup']);

function Shell() {
  const location = useLocation();
  const { isActive } = useSpacetimeDB();
  const [members, membersReady] = useTable(tables.myMember);
  const me = members[0];
  const open = OPEN_PATHS.has(location.pathname);

  if (!isActive || !membersReady) {
    return (
      <main className="app">
        <p className="muted">Connecting…</p>
      </main>
    );
  }
  if (!me && !open) return <Navigate to="/join" replace />;
  if (!me) {
    return (
      <Routes>
        <Route path="/join" element={<JoinScreen />} />
        <Route path="/setup" element={<SetupScreen />} />
        <Route path="*" element={<Navigate to="/join" replace />} />
      </Routes>
    );
  }
  return (
    <LiveProvider>
      <nav className="kitchen-links" aria-label="More">
        <Link to="/">Kitchen Table</Link>
        <Link to="/vitals">Vitals</Link>
        <Link to="/privacy">Privacy</Link>
      </nav>
      <Routes>
        <Route path="/vitals" element={<VitalsScreen />} />
        <Route path="/privacy" element={<PrivacyScreen />} />
        <Route path="/setup" element={<SetupScreen />} />
        <Route path="*" element={<KitchenTable />} />
      </Routes>
    </LiveProvider>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <Shell />
      </BrowserRouter>
    </ToastProvider>
  );
}
