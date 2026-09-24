import { useEffect, useState } from 'react';
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  LayoutDashboard,
  Ticket,
  Boxes,
  BookOpen,
  Plug,
  Sparkles,
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
  ChevronDown,
  ChevronUp,
  GitPullRequest,
  Bug,
  UserPlus,
  Link2,
  TrendingUp,
  Siren,
  Code2,
  UserCog,
  LogOut,
  Network,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { hasPermission, hasAnyPermission } from '../lib/permissions.js';
import { useTranslation } from '../i18n/I18nContext.jsx';
import NotificationBell from './NotificationBell.jsx';
import UserMenu from './UserMenu.jsx';
import WorkspaceSwitcher from './WorkspaceSwitcher.jsx';
import DarkModeToggle from './DarkModeToggle.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import CommandHub from './CommandHub.jsx';
import PageTransition from './PageTransition.jsx';
import NeuralBackground from './NeuralBackground.jsx';

// `label` stays a real English string (used verbatim wherever no translation
// exists yet -- group headers and ticket-type sub-links); `labelKey`, where
// present, is looked up via t() at render time instead. Nav arrays are
// module-level (built once, not per-render) so they can't call a hook
// themselves -- resolving the key in the component is what lets this stay a
// plain constant instead of turning into a function rebuilt on every render.
const AGENT_NAV_GROUPS = [
  {
    label: null,
    items: [
      { to: '/', label: 'Dashboard', labelKey: 'nav.dashboard', icon: LayoutDashboard, end: true },
      {
        to: '/tickets', label: 'Tickets', labelKey: 'nav.tickets', icon: Ticket,
        children: [
          { label: 'Incidents', labelKey: 'nav.incidents', type: 'incident' },
          { label: 'Service Requests', labelKey: 'nav.serviceRequests', type: 'request' },
        ],
      },
      { to: '/changes', label: 'Change Management', labelKey: 'nav.changeManagement', icon: GitPullRequest },
      { to: '/problems', label: 'Problem Management', labelKey: 'nav.problemManagement', icon: Bug },
      { to: '/major-incidents', label: 'Major Incidents', labelKey: 'nav.majorIncidents', icon: Siren, roles: ['admin', 'agent'] },
      { to: '/approvals', label: 'Approvals', labelKey: 'nav.approvals', icon: CheckSquare },
    ],
  },
  {
    label: 'People',
    items: [
      { to: '/hr-cases', label: 'Onboarding / Offboarding', labelKey: 'nav.onboardingOffboarding', icon: UserPlus, roles: ['admin', 'agent'] },
    ],
  },
  {
    label: 'Service Desk',
    items: [
      { to: '/catalog', label: 'Service Catalog', labelKey: 'nav.serviceCatalog', icon: ShoppingBag },
      { to: '/knowledge-base', label: 'Knowledge Base', labelKey: 'nav.knowledgeBase', icon: BookOpen },
      { to: '/reports', label: 'Reports', labelKey: 'nav.reports', icon: BarChart3 },
    ],
  },
  {
    label: 'Assets & Procurement',
    items: [
      { to: '/assets', label: 'Assets', labelKey: 'nav.assetsCmdb', icon: Boxes },
      { to: '/cmdb', label: 'CMDB', labelKey: 'nav.cmdb', icon: Network },
      { to: '/procurement', label: 'Contracts & POs', labelKey: 'nav.contractsPOs', icon: FileText },
    ],
  },
  {
    label: 'Configuration',
    items: [
      { to: '/sla', label: 'SLA Policies', labelKey: 'nav.slaPolicies', icon: Timer, roles: ['admin'], permission: 'sla.manage' },
      { to: '/escalations', label: 'Escalation Rules', labelKey: 'nav.escalationRules', icon: TrendingUp, roles: ['admin'], permission: 'escalations.manage' },
      { to: '/integrations', label: 'Integrations', labelKey: 'nav.integrations', icon: Plug, roles: ['admin'], permission: 'integrations.manage' },
      { to: '/external-connections', label: 'External Connections', labelKey: 'nav.externalConnections', icon: Link2, roles: ['admin'], permission: 'integrations.manage' },
      { to: '/ai-settings', label: 'AI Settings', labelKey: 'nav.aiSettings', icon: Sparkles, roles: ['admin'] },
      { to: '/developer', label: 'Developer API', labelKey: 'nav.developerApi', icon: Code2, roles: ['admin'] },
      // Admin Settings bundles several delegable sections (Automations,
      // Business Rules, Lifecycles, Custom Fields, Groups, Ticket
      // Numbering) behind one hub -- anyone holding at least one delegated
      // permission needs a way in, even though the hub itself has no single
      // permission key. AdminSettings.jsx hides whichever cards they weren't
      // actually granted.
      { to: '/admin-settings', label: 'Admin Settings', labelKey: 'nav.adminSettings', icon: Settings, roles: ['admin'], anyPermission: true },
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
      { to: '/', label: 'My Tickets', labelKey: 'nav.myTickets', icon: LayoutDashboard, end: true },
      {
        to: '/tickets', label: 'All my tickets', labelKey: 'nav.allMyTickets', icon: Ticket,
        children: [
          { label: 'Incidents', labelKey: 'nav.incidents', type: 'incident' },
          { label: 'Service Requests', labelKey: 'nav.serviceRequests', type: 'request' },
        ],
      },
      { to: '/catalog', label: 'Service Catalog', labelKey: 'nav.serviceCatalog', icon: ShoppingBag },
      { to: '/knowledge-base', label: 'Knowledge Base', labelKey: 'nav.knowledgeBase', icon: BookOpen },
    ],
  },
];

// Persistent while an admin/impersonator is viewing as someone else --
// impersonated_by only ever appears on the token for that (see
// authTokens.js's sign()), so its presence alone is the signal, no separate
// "is impersonating" flag to keep in sync.
function ImpersonationBanner() {
  const { user, endImpersonation } = useAuth();
  const navigate = useNavigate();
  const [ending, setEnding] = useState(false);
  if (!user?.impersonated_by) return null;
  const end = async () => {
    setEnding(true);
    try {
      await endImpersonation();
      navigate('/');
    } finally {
      setEnding(false);
    }
  };
  return (
    <div className="shrink-0 flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium text-white bg-gradient-to-r from-amber-500 to-orange-500">
      <UserCog size={13} />
      Viewing as {user.name} — impersonated by {user.impersonated_by.name}
      <button onClick={end} disabled={ending} className="ml-2 inline-flex items-center gap-1 rounded-md bg-white/20 hover:bg-white/30 px-2 py-0.5 transition-colors">
        <LogOut size={11} /> {ending ? 'Returning…' : 'Return to admin'}
      </button>
    </div>
  );
}

export default function AppShell({ children }) {
  const { user } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('itsm_sidebar_collapsed') === '1');
  const NAV_GROUPS = user?.role === 'requester' ? PORTAL_NAV_GROUPS : AGENT_NAV_GROUPS;
  const [expandedNav, setExpandedNav] = useState(() => new Set());
  const activeType = new URLSearchParams(location.search).get('type') || '';

  useEffect(() => {
    localStorage.setItem('itsm_sidebar_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  // Landing directly on a nav item's own page (e.g. /tickets, including via
  // browser back/forward) should reveal its Incidents/Service Requests
  // sub-links even before anyone's touched the chevron -- but only adds the
  // key, never removes it, so a manual collapse while already on that page
  // sticks across sibling sub-link clicks (which only change the query
  // string, not the pathname this effect keys off of).
  useEffect(() => {
    const activeParent = [...AGENT_NAV_GROUPS, ...PORTAL_NAV_GROUPS]
      .flatMap((g) => g.items)
      .find((i) => i.children && i.to === location.pathname);
    if (activeParent) setExpandedNav((prev) => new Set(prev).add(activeParent.to));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Browser tab title, derived from the same nav data that drives the
  // sidebar -- one map, so a renamed/relabeled nav entry updates its tab
  // title for free instead of a second hardcoded title list drifting out of
  // sync with it. Only ever sets a title for an exact match against a known
  // top-level route; a route with no match here (a detail page like
  // /tickets/:id) is left alone entirely so that page's own usePageTitle()
  // call is never fought over who owns document.title.
  useEffect(() => {
    const match = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.to === location.pathname);
    if (match) document.title = `${match.labelKey ? t(match.labelKey) : match.label} · ITSM AI`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, NAV_GROUPS]);

  const toggleNav = (key) => setExpandedNav((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <ImpersonationBanner />
      <div className="flex-1 flex p-0 lg:p-3 gap-0 lg:gap-3 overflow-hidden min-h-0">
      {/* Ambient neural network, persistent behind the whole logged-in app
          (previously login-only) -- fixed+full-viewport, low z-index so the
          glass sidebar/header/cards blur it into a live bokeh backdrop
          instead of a static one. Toned down via `intensity` so it reads as
          atmosphere, not a distraction from real work. */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <NeuralBackground intensity={0.45} />
      </div>

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
            const items = group.items.filter((item) => {
              if (!item.roles) return true;
              if (item.roles.includes(user?.role)) return true;
              if (item.anyPermission) return hasAnyPermission(user);
              return item.permission && hasPermission(user, item.permission);
            });
            if (!items.length) return null;
            return (
              <div key={gi}>
                {group.label && (
                  <div className={`px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 ${collapsed ? 'lg:hidden' : ''}`}>{group.label}</div>
                )}
                <div className="space-y-0.5">
                  {items.map(({ to, label, labelKey, icon: Icon, end, children: subItems }) => {
                    const parentActive = location.pathname === to && !activeType;
                    const resolvedLabel = labelKey ? t(labelKey) : label;
                    return (
                      <div key={to}>
                        <div className="relative flex items-center">
                          <NavLink
                            to={to}
                            end={end}
                            onClick={() => setSidebarOpen(false)}
                            title={collapsed ? resolvedLabel : undefined}
                            className={`relative flex-1 flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${collapsed ? 'lg:justify-center' : ''} ${
                              parentActive
                                ? 'text-white'
                                : 'text-slate-600 hover:bg-brand-500/[0.08] hover:text-brand-700 hover:translate-x-0.5 hover:shadow-[0_0_16px_-6px_rgba(6,182,212,0.5)] dark:text-slate-300 dark:hover:bg-neon-400/[0.08] dark:hover:text-neon-300 dark:hover:shadow-[0_0_16px_-6px_rgba(47,151,255,0.4)]'
                            }`}
                          >
                            {parentActive && (
                              <motion.span
                                layoutId="nav-active-pill"
                                className="absolute inset-0 rounded-xl bg-gradient-to-b from-brand-500 to-brand-600 shadow-glow-brand"
                                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                              />
                            )}
                            <Icon size={17} strokeWidth={2} className="relative shrink-0" />
                            <span className={`relative ${collapsed ? 'lg:hidden' : ''}`}>{resolvedLabel}</span>
                          </NavLink>
                          {subItems && !collapsed && (
                            <button
                              type="button"
                              onClick={() => toggleNav(to)}
                              className="relative shrink-0 p-3 -m-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
                              title={expandedNav.has(to) ? 'Collapse' : 'Expand'}
                            >
                              {expandedNav.has(to) ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                            </button>
                          )}
                        </div>
                        {subItems && !collapsed && expandedNav.has(to) && (
                          <div className="ml-6 mt-0.5 space-y-0.5 border-l border-slate-200 dark:border-white/10 pl-2">
                            {subItems.map((child) => {
                              const childActive = location.pathname === to && activeType === child.type;
                              return (
                                <Link
                                  key={child.label}
                                  to={`${to}?type=${child.type}`}
                                  onClick={() => setSidebarOpen(false)}
                                  className={`block px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                    childActive
                                      ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400'
                                      : 'text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
                                  }`}
                                >
                                  {child.labelKey ? t(child.labelKey) : child.label}
                                </Link>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        <button
          onClick={() => setCollapsed((c) => !c)}
          className="hidden lg:flex items-center justify-center gap-2 mx-3 mb-3 py-1.5 rounded-xl text-slate-400 hover:text-slate-700 hover:bg-slate-900/[0.04] dark:hover:bg-white/[0.06] dark:hover:text-slate-200 transition-colors"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
      </aside>

      <div className="flex-1 flex flex-col min-w-0 gap-3 p-3 lg:p-0 overflow-hidden">
        <header className="glass-panel shrink-0 rounded-2xl h-16 sticky top-0 z-20 flex items-center px-4 sm:px-5 gap-3">
          <button className="lg:hidden text-slate-500 dark:text-slate-300" onClick={() => setSidebarOpen(true)}>
            <Menu size={20} />
          </button>
          <div className="flex-1 min-w-0 max-w-md">
            <GlobalSearch />
          </div>
          <div className="flex items-center gap-1 shrink-0 ml-auto">
            <DarkModeToggle />
            <NotificationBell />
            <span className="w-px h-6 bg-slate-200 dark:bg-slate-700 mx-1" />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto -mx-3 lg:mx-0 px-3 lg:px-0">
          <div className="max-w-7xl mx-auto pb-6">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
      </div>
      <CommandHub />
      </div>
    </div>
  );
}
