import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Ticket,
  Boxes,
  BookOpen,
  Workflow,
  Plug,
  Sparkles,
  LogOut,
  ShoppingBag,
  CheckSquare,
  Timer,
  FileText,
  BarChart3,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import NotificationBell from './NotificationBell.jsx';

const AGENT_NAV_GROUPS = [
  {
    label: null,
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
      { to: '/tickets', label: 'Tickets', icon: Ticket },
      { to: '/approvals', label: 'Approvals', icon: CheckSquare },
    ],
  },
  {
    label: 'Service Desk',
    items: [
      { to: '/catalog', label: 'Service Catalog', icon: ShoppingBag },
      { to: '/knowledge-base', label: 'Knowledge Base', icon: BookOpen },
      { to: '/reports', label: 'Reports', icon: BarChart3 },
    ],
  },
  {
    label: 'Assets & Procurement',
    items: [
      { to: '/assets', label: 'Assets / CMDB', icon: Boxes },
      { to: '/procurement', label: 'Contracts & POs', icon: FileText },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/automations', label: 'Automation', icon: Workflow },
      { to: '/sla', label: 'SLA Policies', icon: Timer },
      { to: '/integrations', label: 'Integrations', icon: Plug },
      { to: '/ai-settings', label: 'AI Settings', icon: Sparkles },
    ],
  },
];

// Requesters get a deliberately smaller, self-service-only nav — this is the
// "portal" experience: submit/track my own tickets, browse the catalog & KB.
// No admin config, no cross-user ticket queue, no automation/AI settings.
const PORTAL_NAV_GROUPS = [
  {
    label: null,
    items: [
      { to: '/', label: 'My Tickets', icon: LayoutDashboard, end: true },
      { to: '/tickets', label: 'All my tickets', icon: Ticket },
      { to: '/catalog', label: 'Service Catalog', icon: ShoppingBag },
      { to: '/knowledge-base', label: 'Knowledge Base', icon: BookOpen },
    ],
  },
];

export default function AppShell({ children }) {
  const { user, logout } = useAuth();
  const NAV_GROUPS = user?.role === 'requester' ? PORTAL_NAV_GROUPS : AGENT_NAV_GROUPS;

  return (
    <div className="h-screen flex bg-slate-50">
      <aside className="w-64 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        <div className="h-16 flex items-center gap-2 px-5 border-b border-slate-100">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center text-white font-bold text-sm">
            IT
          </div>
          <div className="leading-tight">
            <div className="font-semibold text-slate-800 text-sm">ITSM AI</div>
            <div className="text-[11px] text-slate-400">Service Desk Platform</div>
          </div>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
          {NAV_GROUPS.map((group, gi) => (
            <div key={gi}>
              {group.label && (
                <div className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">{group.label}</div>
              )}
              <div className="space-y-0.5">
                {group.items.map(({ to, label, icon: Icon, end }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={end}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                        isActive
                          ? 'bg-brand-50 text-brand-700'
                          : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                      }`
                    }
                  >
                    <Icon size={17} strokeWidth={2} />
                    {label}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-slate-100">
          <div className="flex items-center gap-2.5 px-2 py-2 rounded-lg">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
              style={{ backgroundColor: user?.avatar_color || '#6366f1' }}
            >
              {user?.name?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-800 truncate">{user?.name}</div>
              <div className="text-[11px] text-slate-400 capitalize truncate">{user?.role}</div>
            </div>
            <button onClick={logout} className="text-slate-400 hover:text-red-500 shrink-0" title="Log out">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 shrink-0 border-b border-slate-200 bg-white flex items-center justify-end px-6 gap-3">
          <NotificationBell />
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="max-w-7xl mx-auto px-6 py-6 animate-fade-in">{children}</div>
        </main>
      </div>
    </div>
  );
}
