import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext.jsx';
import { hasPermission, hasAnyPermission } from './lib/permissions.js';
import { RealtimeProvider } from './context/RealtimeContext.jsx';
import { I18nProvider } from './i18n/I18nContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import AppShell from './components/AppShell.jsx';
import Login from './pages/Login.jsx';
import Register from './pages/Register.jsx';
import Dashboard from './pages/Dashboard.jsx';
import PortalHome from './pages/PortalHome.jsx';
import Tickets from './pages/Tickets.jsx';
import TicketDetail from './pages/TicketDetail.jsx';
import ChangeManagement from './pages/ChangeManagement.jsx';
import ProblemManagement from './pages/ProblemManagement.jsx';
import Assets from './pages/Assets.jsx';
import KnowledgeBase from './pages/KnowledgeBase.jsx';
import Integrations from './pages/Integrations.jsx';
import AISettings from './pages/AISettings.jsx';
import Catalog from './pages/Catalog.jsx';
import Approvals from './pages/Approvals.jsx';
import SlaPolicies from './pages/SlaPolicies.jsx';
import EscalationRules from './pages/EscalationRules.jsx';
import Procurement from './pages/Procurement.jsx';
import Reports from './pages/Reports.jsx';
import AdminSettings from './pages/AdminSettings.jsx';
import WorkflowBuilder from './pages/WorkflowBuilder.jsx';
import HrCases from './pages/HrCases.jsx';
import HrCaseDetail from './pages/HrCaseDetail.jsx';
import ExternalConnections from './pages/ExternalConnections.jsx';
import MajorIncidents from './pages/MajorIncidents.jsx';
import MajorIncidentDetail from './pages/MajorIncidentDetail.jsx';
import SsoCallback from './pages/SsoCallback.jsx';
import PrivacyPolicy from './pages/PrivacyPolicy.jsx';
import PrintReport from './pages/PrintReport.jsx';
import DeveloperDocs from './pages/DeveloperDocs.jsx';
import NotFound from './pages/NotFound.jsx';

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

function RequireRole({ role, roles, permission, anyPermission, children }) {
  const { user } = useAuth();
  const allowed = roles || [role];
  if (allowed.includes(user?.role)) return children;
  if (anyPermission && hasAnyPermission(user)) return children;
  if (permission && hasPermission(user, permission)) return children;
  return <Navigate to="/" replace />;
}

function Home() {
  const { user } = useAuth();
  return user?.role === 'requester' ? <PortalHome /> : <Dashboard />;
}

// Wraps the whole app (login screen included, so an unauthenticated visitor
// still gets the interface in their browser's language) -- once signed in,
// the account's saved preference (users.language) takes over, and any
// change here is written back to it so it follows them to their next
// session or device instead of resetting.
function AppI18nProvider({ children }) {
  const { user, updateProfile } = useAuth();
  const persist = (lang) => { if (user) updateProfile({ language: lang }).catch(() => {}); };
  return <I18nProvider userLanguage={user?.language} onPersist={persist}>{children}</I18nProvider>;
}

export default function App() {
  return (
    <>
    <div className="grain-overlay" />
    <ToastProvider>
    <AppI18nProvider>
    <RealtimeProvider>
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/sso-callback" element={<SsoCallback />} />
      <Route path="/privacy" element={<PrivacyPolicy />} />
      <Route path="/reports/print" element={<PrivateRoute><PrintReport /></PrivateRoute>} />
      <Route
        path="/*"
        element={
          <PrivateRoute>
            <AppShell>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/tickets" element={<Tickets />} />
                <Route path="/tickets/:id" element={<TicketDetail />} />
                <Route path="/changes" element={<RequireRole roles={['admin', 'agent']}><ChangeManagement /></RequireRole>} />
                <Route path="/problems" element={<RequireRole roles={['admin', 'agent']}><ProblemManagement /></RequireRole>} />
                <Route path="/major-incidents" element={<RequireRole roles={['admin', 'agent']}><MajorIncidents /></RequireRole>} />
                <Route path="/major-incidents/:id" element={<RequireRole roles={['admin', 'agent']}><MajorIncidentDetail /></RequireRole>} />
                <Route path="/assets" element={<Assets module="assets" />} />
                <Route path="/cmdb" element={<Assets module="cmdb" />} />
                <Route path="/knowledge-base" element={<KnowledgeBase />} />
                <Route path="/integrations" element={<Integrations />} />
                <Route path="/external-connections" element={<RequireRole role="admin" permission="integrations.manage"><ExternalConnections /></RequireRole>} />
                <Route path="/ai-settings" element={<AISettings />} />
                <Route path="/developer" element={<RequireRole role="admin"><DeveloperDocs /></RequireRole>} />
                <Route path="/catalog" element={<Catalog />} />
                <Route path="/approvals" element={<Approvals />} />
                <Route path="/sla" element={<SlaPolicies />} />
                <Route path="/escalations" element={<EscalationRules />} />
                <Route path="/procurement" element={<Procurement />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/admin-settings" element={<RequireRole role="admin" anyPermission><AdminSettings /></RequireRole>} />
                <Route path="/automations/:id" element={<RequireRole role="admin" permission="automations.manage"><WorkflowBuilder /></RequireRole>} />
                <Route path="/hr-cases" element={<RequireRole roles={['admin', 'agent']}><HrCases /></RequireRole>} />
                <Route path="/hr-cases/:id" element={<RequireRole roles={['admin', 'agent']}><HrCaseDetail /></RequireRole>} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </AppShell>
          </PrivateRoute>
        }
      />
    </Routes>
    </RealtimeProvider>
    </AppI18nProvider>
    </ToastProvider>
    </>
  );
}
