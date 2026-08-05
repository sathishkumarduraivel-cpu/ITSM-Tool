import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Ticket,
  Boxes,
  BookOpen,
  Plug,
  Sparkles,
  LogOut,
  ShoppingBag,
  CheckSquare,
  Timer,
  FileText,
  BarChart3,
  Settings,
  Menu,
  X,
  ChevronsLeft,
  ChevronsRight,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import NotificationBell from './NotificationBell.jsx';
import WorkspaceSwitcher from './WorkspaceSwitcher.jsx';
import DarkModeToggle from './DarkModeToggle.jsx';
import GlobalSearch from './GlobalSearch.jsx';

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
      { to: '/sla', label: 'SLA Policies', icon: Timer, roles: ['admin'] },
      { to: '/integrations', label: 'Integrations', icon: Plug, roles: ['admin'] },
      { to: '/ai-settings', label: 'AI Settings', icon: Sparkles, roles: ['admin'] },
      { to: '/admin-settings', label: 'Admin Settings', icon: Settings, roles: ['admin'] },
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('itsm_sidebar_collapsed') === '1');
  const NAV_GROUPS = user?.role === 'requester' ? PORTAL_NAV_GROUPS : AGENT_NAV_GROUPS;

  useEffect(() => {
    localStorage.setItem('itsm_sidebar_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  return (
    <div className="h-screen flex p-0 lg:p-3 gap-0 lg:gap-3 overflow-hidden">
      {sidebarOpen && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-30 lg:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside
        className={`group/aside glass-panel shrink-0 rounded-none lg:rounded-3xl flex flex-col fixed inset-y-0 left-0 lg:static lg:inset-auto z-40 transition-[transform,width] duration-200 ease-out lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        } ${collapsed ? 'lg:w-[84px]' : 'w-72 lg:w-64'}`}
      >
        <div className={`h-16 flex items-center gap-2 border-b border-slate-900/[0.06] dark:border-white/[0.06] ${collapsed ? 'lg:justify-center px-2' : 'px-3'}`}>
          <div className={`flex-1 min-w-0 ${collapsed ? 'lg:hidden' : ''}`}>
            <WorkspaceSwitcher />
          </div>
          <div className={`hidden ${collapsed ? 'lg:block' : ''}`}>
            <WorkspaceSwitcher collapsed />
          </div>
          <button className="lg:hidden text-slate-400 hover:text-slate-600 shrink-0" onClick={() => setSidebarOpen(false)}>
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto overflow-x-hidden">
          {NAV_GROUPS.map((group, gi) => {
            const items = group.items.filter((item) => !item.roles || item.roles.includes(user?.role));
            if (!items.length) return null;
            return (
              <div key={gi}>
                {group.label && (
                  <div className={`px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 ${collapsed ? 'lg:hidden' : ''}`}>{group.label}</div>
                )}
                <div className="space-y-0.5">
                  {items.map(({ to, label, icon: Icon, end }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end={end}
                      onClick={() => setSidebarOpen(false)}
                      title={collapsed ? label : undefined}
                      className={({ isActive }) =>
                        `relative flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-150 ${collapsed ? 'lg:justify-center' : ''} ${
                          isActive
                            ? 'bg-gradient-to-b from-brand-500 to-brand-600 text-white shadow-glow-brand'
                            : 'text-slate-600 hover:bg-slate-900/[0.04] hover:text-slate-900 dark:text-slate-300 dark:hover:bg-white/[0.06] dark:hover:text-white'
                        }`
                      }
                    >
                      <Icon size={17} strokeWidth={2} className="shrink-0" />
                      <span className={collapsed ? 'lg:hidden' : ''}>{label}</span>
                    </NavLink>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        <button
          onClick={() => setCollapsed((c) => !c)}
          className="hidden lg:flex items-center justify-center gap-2 mx-3 mb-2 py-1.5 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-900/[0.04] dark:hover:bg-white/[0.06] dark:hover:text-slate-200 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>

        <div className="p-3 border-t border-slate-900/[0.06] dark:border-white/[0.06]">
          <div className={`flex items-center gap-2.5 px-2 py-2 rounded-xl ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}>
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0 shadow-raised"
              style={{ backgroundColor: user?.avatar_color || '#6366f1' }}
              title={collapsed ? user?.name : undefined}
            >
              {user?.name?.[0]?.toUpperCase() || '?'}
            </div>
            <div className={`min-w-0 flex-1 ${collapsed ? 'lg:hidden' : ''}`}>
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{user?.name}</div>
              <div className="text-[11px] text-slate-400 capitalize truncate">{user?.role}</div>
            </div>
            <button onClick={logout} className={`text-slate-400 hover:text-red-500 shrink-0 ${collapsed ? 'lg:hidden' : ''}`} title="Log out">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 gap-3 p-3 lg:p-0 overflow-hidden">
        <header className="glass-panel shrink-0 rounded-2xl h-16 sticky top-0 z-20 flex items-center px-4 sm:px-5 gap-3">
          <button className="lg:hidden text-slate-500 dark:text-slate-300" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="flex-1 min-w-0 max-w-md">
            <GlobalSearch />
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <DarkModeToggle />
            <NotificationBell />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto -mx-3 lg:mx-0 px-3 lg:px-0">
          <div className="max-w-7xl mx-auto pb-6 animate-fade-in">{children}</div>
        </main>
      </div>
    </div>
  );
}
