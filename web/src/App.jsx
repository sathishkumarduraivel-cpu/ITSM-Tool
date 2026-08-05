import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import AppShell from './components/AppShell.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Dashboard from './pages/Dashboard.jsx';
import PortalHome from './pages/PortalHome.jsx';
import Tickets from './pages/Tickets.jsx';
import TicketDetail from './pages/TicketDetail.jsx';
import Assets from './pages/Assets.jsx';
import KnowledgeBase from './pages/KnowledgeBase.jsx';
import Integrations from './pages/Integrations.jsx';
import AISettings from './pages/AISettings.jsx';
import Catalog from './pages/Catalog.jsx';
import Approvals from './pages/Approvals.jsx';
import SlaPolicies from './pages/SlaPolicies.jsx';
import Procurement from './pages/Procurement.jsx';
import Reports from './pages/Reports.jsx';
import AdminSettings from './pages/AdminSettings.jsx';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center text-slate-400 text-sm">
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function RequireRole({ role, children }) {
  const { user } = useAuth();
  if (user?.role !== role) return <Navigate to="/" replace />;
  return children;
}

function Home() {
  const { user } = useAuth();
  return user?.role === 'requester' ? <PortalHome /> : <Dashboard />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        path="/*"
        element={
          <PrivateRoute>
            <AppShell>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/tickets" element={<Tickets />} />
                <Route path="/tickets/:id" element={<TicketDetail />} />
                <Route path="/assets" element={<Assets />} />
                <Route path="/knowledge-base" element={<KnowledgeBase />} />
                <Route path="/integrations" element={<Integrations />} />
                <Route path="/ai-settings" element={<AISettings />} />
                <Route path="/catalog" element={<Catalog />} />
                <Route path="/approvals" element={<Approvals />} />
                <Route path="/sla" element={<SlaPolicies />} />
                <Route path="/procurement" element={<Procurement />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/admin-settings" element={<RequireRole role="admin"><AdminSettings /></RequireRole>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AppShell>
          </PrivateRoute>
        }
      />
    </Routes>
  );
}
