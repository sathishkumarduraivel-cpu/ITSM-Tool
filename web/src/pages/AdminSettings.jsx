import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  Loader2, Save, UserPlus, Users, ListChecks, UsersRound, Layers,
  Workflow, ArrowLeft, ChevronRight, Plus, Trash2, ChevronDown, ChevronUp, X,
  AlertTriangle, Inbox, Search, GitBranch, Pencil, ShieldCheck, ShieldOff,
  Milestone, ToggleLeft, ToggleRight, RefreshCw, ArrowUp, ArrowDown, FileStack, Hash, KeyRound,
  History, Download, Filter, LogIn, Copy, Check, Webhook, AlertOctagon, UserCog, Server, Mail,
  DatabaseBackup, FileJson, HardDrive, Bug, Siren, CalendarClock, Target, Radar, Boxes,
} from 'lucide-react';
import { api, getStoredToken } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { hasPermission } from '../lib/permissions.js';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { RevealGroup, RevealItem } from '../components/Reveal.jsx';
import Select from '../components/Select.jsx';
import Automations from './Automations.jsx';
import HrCaseTemplatesTab from '../components/hr-cases/HrCaseTemplatesTab.jsx';
import EmailConfigTab from '../components/admin/EmailConfigTab.jsx';
import AlertManagementTab from '../components/admin/AlertManagementTab.jsx';
import OnCallScheduleTab from '../components/admin/OnCallScheduleTab.jsx';
import AssignmentPolicyTab from '../components/admin/AssignmentPolicyTab.jsx';
import TicketFieldManagerTab from '../components/admin/TicketFieldManagerTab.jsx';
import ChangeConfigTab from '../components/admin/ChangeConfigTab.jsx';
import CmdbConfigTab from '../components/admin/CmdbConfigTab.jsx';

// A section with no `permission` is admin-only and never delegable — user
// management, workspace management, HR templates, and role definition itself
// (granting permissions is a privilege-granting action) stay hard-admin.
// Everything else can be handed to a specific agent via a custom role.
const SECTIONS = [
  { key: 'users', label: 'Users', description: 'Manage agent & requester accounts, roles and status', icon: Users },
  { key: 'groups', label: 'Groups', description: 'Organize agents into groups, e.g. Network, Facilities, Service Desk', icon: UsersRound, permission: 'groups.manage' },
  { key: 'roles', label: 'Roles & Permissions', description: 'Delegate specific admin areas — SLA, automations, catalog and more — to agents without making them full admins', icon: KeyRound },
  { key: 'sso', label: 'Single Sign-On', description: 'Let people sign in with their company Google or Microsoft account instead of a separate password', icon: LogIn },
  { key: 'directory', label: 'Directory Sync', description: 'Provision accounts from Active Directory (LDAP) or Microsoft Graph, and auto-deactivate anyone removed there', icon: Server },
  { key: 'workflows', label: 'Workflows & Automation', description: 'Trigger → conditions → actions, including built-in AI steps', icon: Workflow, permission: 'automations.manage' },
  { key: 'emailConfig', label: 'Email Configuration', description: 'SMTP settings, requester/agent/admin/approval email templates, canned responses and delivery log', icon: Mail, permission: 'notifications.manage' },
  { key: 'businessRules', label: 'Business Rules', description: 'Conditional visibility, required and validation logic per ticket type', icon: ShieldCheck, permission: 'business_rules.manage' },
  { key: 'lifecycles', label: 'Lifecycles', description: 'Stage-by-stage workflows per ticket type, with role-restricted and condition-gated transitions enforced server-side', icon: Milestone, permission: 'lifecycles.manage' },
  { key: 'fieldManager', label: 'Field Manager', description: 'Every field on a ticket form, built-in and custom — categories, subcategories, priority, impact, risk and your own fields, with editable options, labels and colours', icon: ListChecks, permission: 'custom_fields.manage' },
  { key: 'workspaces', label: 'Workspaces', description: 'Add, rename or remove workspaces you belong to', icon: Layers },
  { key: 'changeConfig', label: 'Change Management', description: 'Change types, standard templates, risk scoring, freeze windows and CAB approval routing', icon: GitBranch, permission: 'change.manage' },
  { key: 'cmdbConfig', label: 'CMDB Configuration', description: 'CI classes and their typed fields, relationship types, identification rules that stop duplicates, and the discovery sources allowed to write', icon: Boxes, permission: 'cmdb.manage' },
  { key: 'ticketNumbering', label: 'Ticket Numbering', description: 'Customize the id prefix each ticket type gets — INC, REQ, PRB, CHG, or your own', icon: Hash, permission: 'ticket_numbering.manage' },
  { key: 'hrCaseTemplates', label: 'Onboarding/Offboarding Templates', description: 'Reusable department checklists for the Onboarding & Offboarding module', icon: FileStack },
  { key: 'alertManagement', label: 'Alert Management', description: 'Take in alerts from monitoring tools and your own service desk data, collapse repeats, and turn the ones that matter into incidents', icon: Siren, permission: 'alerts.manage' },
  { key: 'onCallSchedules', label: 'On-Call Schedules', description: 'Rotations with stacked layers, overrides and escalation steps — so "who is responsible at 3am" is always answerable', icon: CalendarClock, permission: 'oncall.manage' },
  { key: 'assignmentPolicies', label: 'Assignment Policies', description: 'Route tickets to a genuinely available agent by on-call, capacity, time off and presence — with Sona picking the best fit', icon: Target, permission: 'assignment.manage' },
  { key: 'auditLog', label: 'Audit Log', description: 'Every administrative change in this workspace — who did what, when — with CSV export for compliance reporting', icon: History, permission: 'audit_log.view' },
  { key: 'apiKeys', label: 'API Keys', description: 'Issue scoped credentials so other company systems can connect directly to the public developer API', icon: Webhook },
  { key: 'backups', label: 'Backups & Export', description: 'Download a full copy of your workspace data, or (super-admin) the entire underlying database', icon: DatabaseBackup },
  { key: 'errorMonitoring', label: 'Error Monitoring', description: 'Unhandled server errors across this instance, for platform operators (super-admin only)', icon: Bug },
];

// Groups the flat SECTIONS list above into the categories rendered on the
// hub page — purely a presentation grouping (SECTIONS stays the single
// source of truth for each section's own key/label/icon/permission; a
// group just lists which keys belong under it and lends them a shared
// accent color), so adding a new admin section still only ever means one
// new SECTIONS entry plus naming which group it falls under here.
const SECTION_GROUPS = [
  {
    key: 'people', label: 'People & Access', icon: Users, accent: 'from-brand-400 to-brand-600',
    description: 'Who can sign in, what they can do, and where their account comes from',
    sectionKeys: ['users', 'groups', 'roles', 'sso', 'directory'],
  },
  {
    key: 'automation', label: 'Process & Automation', icon: Workflow, accent: 'from-violet-400 to-violet-600',
    description: 'How tickets behave — workflows, conditional logic, stage gates and custom fields',
    sectionKeys: ['workflows', 'emailConfig', 'businessRules', 'lifecycles', 'fieldManager', 'changeConfig', 'cmdbConfig'],
  },
  {
    key: 'workspace', label: 'Workspace Settings', icon: Layers, accent: 'from-amber-400 to-amber-600',
    description: 'Organization-wide configuration that isn’t specific to any one process',
    sectionKeys: ['workspaces', 'ticketNumbering'],
  },
  {
    key: 'modules', label: 'Modules', icon: FileStack, accent: 'from-teal-400 to-teal-600',
    description: 'Configuration for optional, feature-specific modules',
    sectionKeys: ['hrCaseTemplates'],
  },
  {
    key: 'operations', label: 'Operations & Routing', icon: Radar, accent: 'from-red-400 to-red-600',
    description: 'Who gets told when something breaks, who is on the hook out of hours, and who the work lands on',
    sectionKeys: ['alertManagement', 'onCallSchedules', 'assignmentPolicies'],
  },
  {
    key: 'security', label: 'Security & Compliance', icon: ShieldCheck, accent: 'from-rose-400 to-rose-600',
    description: 'Audit trails and credentials for anything connecting to this workspace',
    sectionKeys: ['auditLog', 'apiKeys', 'backups', 'errorMonitoring'],
  },
];

function canSeeSection(user, section) {
  if (user?.role === 'admin') return true;
  return section.permission ? hasPermission(user, section.permission) : false;
}

// Shared by every tab below's initial `load()` failure path. Without this,
// a tab whose load() had no try/catch left its gating state (e.g. `users`,
// `groups`, `data`) null forever on any failed request -- the tab stuck
// permanently on "Loading…" with no error shown and no way to recover short
// of leaving and re-entering Admin Settings.
function LoadErrorState({ error, onRetry }) {
  return (
    <div className="text-sm text-center py-10 space-y-2">
      <p className="text-red-600 dark:text-red-400">{error}</p>
      <button onClick={onRetry} className="btn-secondary text-xs mx-auto">Retry</button>
    </div>
  );
}

function AddUserModal({ onClose, onSaved, groups }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('agent');
  const [groupId, setGroupId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { id } = await api.post('/auth/users', { email, name, password, role });
      if (groupId) await api.post(`/groups/${groupId}/members`, { user_id: id });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add user" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Name</label>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label">Temporary password</label>
          <input className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">Role</label>
            <Select value={role} onChange={setRole} options={[{ value: 'requester', label: 'Requester' }, { value: 'agent', label: 'Agent' }, { value: 'admin', label: 'Admin' }]} />
          </div>
          <div>
            <label className="label">Group (optional)</label>
            <Select value={groupId} onChange={setGroupId} options={[{ value: '', label: 'None' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} Add
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SortableHeader({ label, sortKey, sort, onSort }) {
  const active = sort.key === sortKey;
  return (
    <th className="text-left px-3 py-2.5 font-medium select-none">
      <button type="button" onClick={() => onSort(sortKey)} className="inline-flex items-center gap-1 hover:text-slate-700 dark:hover:text-slate-200">
        {label}
        {active ? (sort.dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : <ArrowUp size={11} className="opacity-25" />}
      </button>
    </th>
  );
}

function UsersBulkActionBar({ selectedUsers, currentUserId, groups, onClear, onDone }) {
  const [bulk, setBulk] = useState({ role: '', team: '', active: '' });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const hasEdits = Object.values(bulk).some((v) => v !== '');
  // Bulk changes never touch the caller's own row -- same self-protection
  // already established for role/status/super-admin edits elsewhere in this
  // tab, just applied across a selection instead of one row at a time.
  const targetable = selectedUsers.filter((u) => u.id !== currentUserId);
  const skippedSelf = selectedUsers.length !== targetable.length;

  const apply = async () => {
    const updates = {};
    if (bulk.role) updates.role = bulk.role;
    if (bulk.team) updates.team = bulk.team;
    if (bulk.active !== '') updates.active = bulk.active === 'active';
    if (!Object.keys(updates).length || !targetable.length) return;
    setApplying(true);
    setError('');
    try {
      const result = await api.post('/auth/users/bulk-update', { user_ids: targetable.map((u) => u.id), updates });
      if (result.failed?.length) {
        setError(`${result.succeeded.length} updated, ${result.failed.length} failed — ${result.failed.map((f) => f.error).join('; ')}`);
      }
      setBulk({ role: '', team: '', active: '' });
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="card p-3 bg-brand-50/60 dark:bg-brand-500/5 border-brand-200 dark:border-brand-500/20 space-y-2 animate-fade-in">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-brand-700 dark:text-brand-400">
          {selectedUsers.length} selected{skippedSelf ? ' (your own account is skipped in bulk changes)' : ''}
        </span>
        <button onClick={onClear} className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex items-center gap-1 py-1.5 px-1 -m-1"><X size={12} /> Clear</button>
      </div>
      {error && <div className="text-xs text-red-600 bg-red-50 dark:bg-red-500/10 rounded-md px-2 py-1.5">{error}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm" className="w-auto min-w-[130px]" placeholder="Set role…"
          value={bulk.role} onChange={(v) => setBulk({ ...bulk, role: v })}
          options={[{ value: 'requester', label: 'Requester' }, { value: 'agent', label: 'Agent' }, { value: 'admin', label: 'Admin' }]}
        />
        <Select
          size="sm" className="w-auto min-w-[140px]" placeholder="Set team…"
          value={bulk.team} onChange={(v) => setBulk({ ...bulk, team: v })}
          options={groups.map((g) => ({ value: g.name, label: g.name }))}
        />
        <Select
          size="sm" className="w-auto min-w-[130px]" placeholder="Set status…"
          value={bulk.active} onChange={(v) => setBulk({ ...bulk, active: v })}
          options={[{ value: 'active', label: 'Active' }, { value: 'inactive', label: 'Deactivated' }]}
        />
        <button onClick={apply} disabled={applying || !hasEdits || !targetable.length} className="btn-primary text-xs">
          {applying ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Apply to {targetable.length}
        </button>
      </div>
    </div>
  );
}

function UserDrawer({ target, currentUser, users, roles, catalog, groupsFor, onClose, onUpdate, onToggleActive, onToggleSuperAdmin, onRemove, onImpersonate, impersonating, canImpersonate }) {
  const isSelf = target.id === currentUser.id;
  const memberOf = groupsFor(target.id);
  const customRole = roles.find((r) => r.id === target.custom_role_id);
  const permissionLabel = (key) => catalog.find((p) => p.key === key)?.label || key;

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[1px] animate-fade-in" onClick={onClose} />
      <div className="relative w-full max-w-md h-full bg-white dark:bg-slate-900 shadow-2xl overflow-y-auto animate-slide-in-right">
        <div className="sticky top-0 bg-white dark:bg-slate-900 border-b border-slate-100 dark:border-slate-800 px-5 py-4 flex items-center gap-3 z-10">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0"
            style={{ backgroundColor: target.avatar_color || '#6366f1' }}
          >
            {target.name?.[0]?.toUpperCase() || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{target.name}</div>
            <div className="text-xs text-slate-500 truncate">{target.email}</div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 shrink-0"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-5">
          {target.directory_provider_name && (
            <div className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" title="Name, email and team are overwritten on this directory's next sync">
              <Server size={10} /> Synced from {target.directory_provider_name}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <div className="text-xs text-slate-400 mb-1">Joined</div>
              <div className="text-slate-700 dark:text-slate-200">{target.created_at ? new Date(target.created_at).toLocaleDateString() : '—'}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400 mb-1">Status</div>
              <button
                onClick={onToggleActive} disabled={isSelf}
                className={`text-xs px-2 py-1 rounded-md disabled:opacity-60 disabled:cursor-not-allowed ${target.active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}
              >
                {target.active ? 'Active' : 'Deactivated'}
              </button>
            </div>
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-1">Role</div>
            <Select
              size="sm" value={target.role} onChange={(v) => onUpdate({ role: v })} disabled={isSelf}
              options={[{ value: 'requester', label: 'Requester' }, { value: 'agent', label: 'Agent' }, { value: 'admin', label: 'Admin' }]}
            />
          </div>

          {currentUser.is_super_admin && (
            <div>
              <div className="text-xs text-slate-400 mb-1">Super admin</div>
              <button
                onClick={onToggleSuperAdmin}
                disabled={isSelf}
                title={isSelf ? "You can't revoke your own super-admin access" : 'Cross-workspace access: full database backup + error log. Reserve for platform operators.'}
                className={`text-xs px-2 py-1 rounded-md inline-flex items-center gap-1 disabled:opacity-60 disabled:cursor-not-allowed ${target.is_super_admin ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}
              >
                {target.is_super_admin ? <ShieldCheck size={12} /> : <ShieldOff size={12} />}
                {target.is_super_admin ? 'On' : 'Off'}
              </button>
            </div>
          )}

          <div>
            <div className="text-xs text-slate-400 mb-1">Employee ID</div>
            <input
              className="input text-sm w-full"
              defaultValue={target.employee_id || ''}
              placeholder="Not set"
              onBlur={(e) => { if (e.target.value !== (target.employee_id || '')) onUpdate({ employee_id: e.target.value }); }}
            />
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-1">Manager</div>
            <Select
              size="sm" value={target.manager_id || ''} onChange={(v) => onUpdate({ manager_id: v })}
              options={[{ value: '', label: 'Not set' }, ...users.filter((x) => x.id !== target.id).map((x) => ({ value: x.id, label: x.name }))]}
            />
          </div>

          <div>
            <div className="text-xs text-slate-400 mb-1">Groups</div>
            {memberOf.length ? (
              <div className="flex flex-wrap gap-1">
                {memberOf.map((g) => <span key={g.id} className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{g.name}</span>)}
              </div>
            ) : <span className="text-slate-400 text-sm">none</span>}
          </div>

          {target.role !== 'admin' && (
            <div>
              <div className="text-xs text-slate-400 mb-1 flex items-center justify-between">
                <span>Delegated role</span>
                {customRole && <span>{(customRole.permissions || []).length} permission{(customRole.permissions || []).length === 1 ? '' : 's'}</span>}
              </div>
              <Select
                size="sm" value={target.custom_role_id || ''} onChange={(v) => onUpdate({ custom_role_id: v })}
                options={[{ value: '', label: `None — base ${target.role} permissions only` }, ...roles.map((r) => ({ value: r.id, label: r.name }))]}
              />
              {customRole && (
                <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-2.5 py-2">
                  Grants: {(customRole.permissions || []).length ? customRole.permissions.map(permissionLabel).join(', ') : 'no permissions selected on this role'}
                </div>
              )}
            </div>
          )}

          <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
            {canImpersonate && !isSelf && target.active && (
              <button onClick={onImpersonate} disabled={impersonating} className="btn-secondary text-xs flex-1">
                {impersonating ? <Loader2 size={13} className="animate-spin" /> : <UserCog size={13} />} Log in as {target.name.split(' ')[0]}
              </button>
            )}
            <button onClick={onRemove} disabled={isSelf} className="btn-secondary text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-40 flex-1">
              <Trash2 size={13} /> Remove from workspace
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function UsersTab() {
  const { user, impersonate } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState(null);
  const [groups, setGroups] = useState([]);
  const [roles, setRoles] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [impersonating, setImpersonating] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [drawerUserId, setDrawerUserId] = useState(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' });

  const startImpersonating = async (u) => {
    setImpersonating(u.id);
    try {
      await impersonate(u.id);
      navigate('/');
    } catch (e) {
      alert(e.message);
    } finally {
      setImpersonating('');
    }
  };

  const load = async () => {
    setLoadError('');
    try {
      const [usersRes, groupsRes, rolesRes] = await Promise.all([api.get('/auth/users/all'), api.get('/groups'), api.get('/custom-roles')]);
      setUsers(usersRes.users);
      setGroups(groupsRes.groups);
      setRoles(rolesRes.roles);
      setCatalog(rolesRes.catalog || []);
    } catch (e) {
      // Without this catch, a failed request left `users` null forever --
      // the whole tab stuck on "Loading…" with no error and no way out.
      setLoadError(e.message);
    }
  };

  useEffect(() => { load(); }, []);

  const updateProfile = async (userId, patch) => {
    await api.patch(`/auth/users/${userId}`, patch);
    load();
  };

  const toggleActive = async (u) => {
    await api.patch(`/auth/users/${u.id}`, { active: !u.active });
    load();
  };

  const removeUser = async (u) => {
    if (!confirm(`Remove ${u.name} from this workspace? They will lose access entirely.`)) return;
    await api.del(`/auth/users/${u.id}`);
    setDrawerUserId(null);
    load();
  };

  const toggleSuperAdmin = async (u) => {
    const turningOn = !u.is_super_admin;
    if (turningOn && !confirm(`Grant ${u.name} super-admin access? This gives them the full cross-workspace database backup and error log (with stack traces) — reserve it for platform operators, not regular workspace admins.`)) return;
    try {
      await api.patch(`/admin/users/${u.id}/super-admin`, { is_super_admin: turningOn });
      load();
    } catch (e) {
      alert(e.message);
    }
  };

  const groupsFor = (userId) => groups.filter((g) => g.members.some((m) => m.id === userId));
  const roleById = (id) => roles.find((r) => r.id === id);

  if (loadError && !users) return <LoadErrorState error={loadError} onRetry={load} />;
  if (!users) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  // Drawer target is looked up fresh from `users` every render (by id, not a
  // stored snapshot) so an edit made inside the drawer -- which reloads
  // `users` -- is reflected immediately instead of showing stale data.
  const drawerUser = drawerUserId ? users.find((u) => u.id === drawerUserId) : null;

  const filtered = users.filter((u) => {
    if (roleFilter && u.role !== roleFilter) return false;
    if (statusFilter === 'active' && !u.active) return false;
    if (statusFilter === 'inactive' && u.active) return false;
    if (search) {
      const q = search.trim().toLowerCase();
      if (!u.name?.toLowerCase().includes(q) && !u.email?.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const av = sort.key === 'joined' ? (a.created_at || '') : (a[sort.key] || '');
    const bv = sort.key === 'joined' ? (b.created_at || '') : (b[sort.key] || '');
    const cmp = String(av).localeCompare(String(bv));
    return sort.dir === 'asc' ? cmp : -cmp;
  });

  const toggleSort = (key) => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));
  const toggleOne = (id) => setSelectedIds((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelectedIds((s) => (s.size === sorted.length ? new Set() : new Set(sorted.map((u) => u.id))));
  const clearSelection = () => setSelectedIds(new Set());
  const selectedUsers = sorted.filter((u) => selectedIds.has(u.id));

  const exportCsv = () => {
    const headers = ['Name', 'Email', 'Role', 'Team', 'Delegated role', 'Status', 'Joined'];
    const rows = sorted.map((u) => [
      u.name, u.email, u.role, u.team || '', roleById(u.custom_role_id)?.name || '',
      u.active ? 'Active' : 'Deactivated', u.created_at ? new Date(u.created_at).toLocaleDateString() : '',
    ]);
    const csv = [headers, ...rows].map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `users-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap items-center gap-2 flex-1 min-w-0">
          <div className="relative w-full sm:w-56">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              className="input pl-8 text-sm w-full" placeholder="Search name or email…"
              value={search} onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Select
            size="sm" className="w-auto" value={roleFilter} onChange={setRoleFilter}
            options={[{ value: '', label: 'All roles' }, { value: 'requester', label: 'Requester' }, { value: 'agent', label: 'Agent' }, { value: 'admin', label: 'Admin' }]}
          />
          <Select
            size="sm" className="w-auto" value={statusFilter} onChange={setStatusFilter}
            options={[{ value: '', label: 'All statuses' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Deactivated' }]}
          />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={exportCsv} disabled={!sorted.length} className="btn-secondary text-xs"><Download size={14} /> Export CSV</button>
          <button onClick={() => setShowAdd(true)} className="btn-primary"><UserPlus size={14} /> Add user</button>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <UsersBulkActionBar selectedUsers={selectedUsers} currentUserId={user.id} groups={groups} onClear={clearSelection} onDone={() => { clearSelection(); load(); }} />
      )}

      {sorted.length === 0 ? (
        <EmptyState icon={Users} title={users.length === 0 ? 'No users yet' : 'No users match your filters'} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 dark:border-slate-800 text-xs text-slate-400">
                <th className="text-left px-4 py-2.5 font-medium w-8">
                  <input type="checkbox" checked={selectedIds.size > 0 && selectedIds.size === sorted.length} onChange={toggleAll} />
                </th>
                <SortableHeader label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Role" sortKey="role" sort={sort} onSort={toggleSort} />
                <th className="text-left px-3 py-2.5 font-medium">Delegated role</th>
                <th className="text-left px-3 py-2.5 font-medium">Team</th>
                <th className="text-left px-3 py-2.5 font-medium">Status</th>
                <SortableHeader label="Joined" sortKey="joined" sort={sort} onSort={toggleSort} />
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {sorted.map((u) => {
                const memberOf = groupsFor(u.id);
                const customRole = roleById(u.custom_role_id);
                return (
                  <tr key={u.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer" onClick={() => setDrawerUserId(u.id)}>
                    <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedIds.has(u.id)} onChange={() => toggleOne(u.id)} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className="w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                          style={{ backgroundColor: u.avatar_color || '#6366f1' }}
                        >
                          {u.name?.[0]?.toUpperCase() || '?'}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate flex items-center gap-1.5">
                            {u.name}
                            {!!u.is_super_admin && <ShieldCheck size={12} className="text-amber-500 shrink-0" />}
                            {u.directory_provider_name && (
                              <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 shrink-0" title="Name, email and team are overwritten on this directory's next sync">
                                <Server size={10} /> {u.directory_provider_name}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 truncate">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 dark:text-slate-300 capitalize">{u.role}</td>
                    <td className="px-3 py-2.5">
                      {customRole ? (
                        <span
                          className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400"
                          title={`Grants: ${(customRole.permissions || []).map((k) => catalog.find((p) => p.key === k)?.label || k).join(', ') || 'no permissions'}`}
                        >
                          {customRole.name} · {(customRole.permissions || []).length}
                        </span>
                      ) : <span className="text-slate-400 text-xs">—</span>}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 dark:text-slate-300">{u.team || '—'}{memberOf.length ? ` +${memberOf.length}` : ''}</td>
                    <td className="px-3 py-2.5">
                      <span className={`text-xs px-2 py-0.5 rounded-md ${u.active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>
                        {u.active ? 'Active' : 'Deactivated'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-slate-500 text-xs">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</td>
                    <td className="px-3 py-2.5"><ChevronRight size={15} className="text-slate-300" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <AddUserModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} groups={groups} />
      )}

      {drawerUser && (
        <UserDrawer
          target={drawerUser}
          currentUser={user}
          users={users}
          roles={roles}
          catalog={catalog}
          groupsFor={groupsFor}
          onClose={() => setDrawerUserId(null)}
          onUpdate={(patch) => updateProfile(drawerUser.id, patch)}
          onToggleActive={() => toggleActive(drawerUser)}
          onToggleSuperAdmin={() => toggleSuperAdmin(drawerUser)}
          onRemove={() => removeUser(drawerUser)}
          onImpersonate={() => startImpersonating(drawerUser)}
          impersonating={impersonating === drawerUser.id}
          canImpersonate={hasPermission(user, 'users.impersonate')}
        />
      )}
    </div>
  );
}

const NUMBER_PREFIX_TYPES = [
  { key: 'incident', label: 'Incident', sample: '1042' },
  { key: 'request', label: 'Request', sample: '1043' },
  { key: 'problem', label: 'Problem', sample: '1044' },
  { key: 'change', label: 'Change', sample: '1045' },
];

function TicketNumberingTab() {
  const [prefixes, setPrefixes] = useState(null);
  const [draft, setDraft] = useState({});
  const [savingType, setSavingType] = useState('');
  const [error, setError] = useState('');
  const [savedType, setSavedType] = useState('');

  const load = async () => {
    try {
      const { prefixes } = await api.get('/ticket-numbering');
      setPrefixes(prefixes);
      setDraft(prefixes);
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => { load(); }, []);

  const save = async (type) => {
    setSavingType(type);
    setError('');
    setSavedType('');
    try {
      const { prefixes: updated } = await api.patch('/ticket-numbering', { type, prefix: draft[type] });
      setPrefixes(updated);
      setDraft(updated);
      setSavedType(type);
      setTimeout(() => setSavedType(''), 1500);
    } catch (e) {
      setError(e.message);
    } finally {
      setSavingType('');
    }
  };

  if (!prefixes && error) return <LoadErrorState error={error} onRetry={load} />;
  if (!prefixes) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
        A prefix change only applies to tickets created from that point forward — existing ticket numbers are never rewritten, since they may already be referenced in emails, external system links, or audit trails.
      </p>
      {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

      <div className="card divide-y divide-slate-100 dark:divide-slate-800">
        {NUMBER_PREFIX_TYPES.map((t) => {
          const dirty = draft[t.key] !== prefixes[t.key];
          return (
            <div key={t.key} className="flex items-center gap-3 px-4 py-3">
              <div className="w-24 shrink-0 text-sm font-medium text-slate-700 dark:text-slate-200">{t.label}</div>
              <input
                className="input w-32"
                value={draft[t.key] || ''}
                maxLength={10}
                onChange={(e) => setDraft({ ...draft, [t.key]: e.target.value.toUpperCase() })}
              />
              <div className="text-xs text-slate-400 font-mono flex-1">e.g. {(draft[t.key] || '—').toUpperCase()}-{t.sample}</div>
              {savedType === t.key && <Save size={14} className="text-emerald-500 shrink-0" />}
              <button
                onClick={() => save(t.key)}
                disabled={!dirty || savingType === t.key}
                className="btn-secondary text-xs shrink-0"
              >
                {savingType === t.key ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoleModal({ initial, catalog, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [permissions, setPermissions] = useState(initial?.permissions || []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const groups = [...new Set(catalog.map((p) => p.group))];
  const toggle = (key) => setPermissions((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);

  const submit = async (e) => {
    e.preventDefault();
    if (!permissions.length) { setError('Grant at least one permission — a role with none does nothing.'); return; }
    setSaving(true);
    setError('');
    try {
      if (initial?.id) await api.patch(`/custom-roles/${initial.id}`, { name, description, permissions });
      else await api.post('/custom-roles', { name, description, permissions });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit role' : 'New role'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Role name</label>
          <input className="input" required placeholder="e.g. SLA Administrator" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Description (optional)</label>
          <input className="input" placeholder="What this role is for" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label className="label">Permissions</label>
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800 max-h-80 overflow-y-auto">
            {groups.map((g) => (
              <div key={g} className="p-3">
                <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-1.5">{g}</div>
                <div className="space-y-1.5">
                  {catalog.filter((p) => p.group === g).map((p) => (
                    <label key={p.key} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 cursor-pointer">
                      <input type="checkbox" checked={permissions.includes(p.key)} onChange={() => toggle(p.key)} />
                      {p.label}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RolesTab() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [modal, setModal] = useState(null); // null | {} | {id,...}

  const load = async () => {
    try {
      setData(await api.get('/custom-roles'));
    } catch (e) {
      setLoadError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const remove = async (r) => {
    if (!confirm(`Delete "${r.name}"? Members holding it will fall back to their base role permissions.`)) return;
    await api.del(`/custom-roles/${r.id}`);
    load();
  };

  if (loadError && !data) return <LoadErrorState error={loadError} onRetry={load} />;
  if (!data) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;
  const { roles, catalog } = data;

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
        Assign a role to an agent in the Users tab to grant them exactly the configuration areas you pick, without making them a full admin. Admins already have every permission and never need one.
      </p>
      <div className="flex justify-end">
        <button onClick={() => setModal({})} className="btn-primary"><Plus size={14} /> New role</button>
      </div>

      {roles.length === 0 ? (
        <EmptyState icon={KeyRound} title="No custom roles yet" description="Create one to delegate specific admin areas to trusted agents." />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {roles.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{r.name}</div>
                <div className="text-xs text-slate-500 truncate">
                  {r.description || 'No description'} · {r.permissions.length} permission{r.permissions.length === 1 ? '' : 's'} · {r.member_count} member{r.member_count === 1 ? '' : 's'}
                </div>
              </div>
              <button onClick={() => setModal(r)} className="text-slate-400 hover:text-slate-600" title="Edit"><Pencil size={15} /></button>
              <button onClick={() => remove(r)} className="text-slate-400 hover:text-red-500" title="Delete"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <RoleModal initial={modal.id ? modal : null} catalog={catalog} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}

function formatAction(action) {
  if (!action) return '—';
  const [entity, verb] = action.split('.');
  const titleCase = (s) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return verb ? `${titleCase(entity)} ${titleCase(verb)}` : titleCase(entity);
}

function AuditLogTab() {
  const [entries, setEntries] = useState(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ actions: [], actors: [] });
  const [filters, setFilters] = useState({ q: '', action: '', actor_id: '', from: '', to: '' });
  const [expanded, setExpanded] = useState(null);
  const [loadError, setLoadError] = useState('');
  const pageSize = 50;

  useEffect(() => { api.get('/audit-log/meta').then(setMeta); }, []);

  const load = async () => {
    setEntries(null);
    setLoadError('');
    try {
      const params = new URLSearchParams({ page: String(page) });
      for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
      const data = await api.get(`/audit-log?${params.toString()}`);
      setEntries(data.entries);
      setTotal(data.total);
    } catch (e) {
      setLoadError(e.message);
    }
  };

  useEffect(() => { load(); }, [page]);
  // Any filter change resets to page 1. If we're already there, changing
  // `page` to the same value wouldn't re-trigger the effect above, so reload
  // directly in that case instead.
  useEffect(() => { if (page === 1) load(); else setPage(1); }, [filters.q, filters.action, filters.actor_id, filters.from, filters.to]);

  const exportCsv = async () => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    const resp = await fetch(`/api/audit-log/export?${params.toString()}`, {
      headers: { authorization: `Bearer ${getStoredToken()}` },
    });
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap items-center gap-2">
        <Filter size={14} className="text-slate-400 shrink-0" />
        <input
          className="input w-auto flex-1 min-w-[160px] py-1.5 text-sm"
          placeholder="Search actor, entity or action…"
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
        />
        <Select
          size="sm" className="w-auto min-w-[140px]" placeholder="All actions" value={filters.action} onChange={(v) => setFilters({ ...filters, action: v })}
          options={meta.actions.map((a) => ({ value: a, label: formatAction(a) }))}
        />
        <Select
          size="sm" className="w-auto min-w-[130px]" placeholder="All people" value={filters.actor_id} onChange={(v) => setFilters({ ...filters, actor_id: v })}
          options={meta.actors.map((a) => ({ value: a.actor_id, label: a.actor_name }))}
        />
        <input type="date" className="input w-auto py-1.5 text-sm" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        <span className="text-slate-400 text-xs">to</span>
        <input type="date" className="input w-auto py-1.5 text-sm" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        <button onClick={exportCsv} className="btn-secondary text-xs ml-auto"><Download size={13} /> Export CSV</button>
      </div>

      {entries === null && loadError ? (
        <LoadErrorState error={loadError} onRetry={load} />
      ) : entries === null ? (
        <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>
      ) : entries.length === 0 ? (
        <EmptyState icon={History} title="No matching activity" description="Nothing recorded yet for these filters." />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {entries.map((e) => {
            const isOpen = expanded === e.id;
            return (
              <div key={e.id}>
                <button type="button" onClick={() => setExpanded(isOpen ? null : e.id)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <div className="text-xs text-slate-400 w-36 shrink-0 font-mono">{new Date(e.created_at).toLocaleString()}</div>
                  <div className="w-36 shrink-0 truncate">
                    <span className="text-sm text-slate-700 dark:text-slate-200">{e.actor_name || 'System'}</span>
                    {e.actor_role && <span className="text-xs text-slate-400"> · {e.actor_role}</span>}
                  </div>
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 shrink-0">{formatAction(e.action)}</span>
                    {e.entity_label && <span className="text-sm text-slate-500 truncate">{e.entity_label}</span>}
                  </div>
                  {e.details && (isOpen ? <ChevronUp size={15} className="text-slate-400 shrink-0" /> : <ChevronDown size={15} className="text-slate-400 shrink-0" />)}
                </button>
                {isOpen && e.details && (
                  <pre className="mx-4 mb-3 -mt-1 text-xs bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3 overflow-x-auto text-slate-600 dark:text-slate-300">
                    {JSON.stringify(e.details, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      )}

      {total > pageSize && (
        <div className="flex items-center justify-between text-xs text-slate-500">
          <span>{total} total entries</span>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="btn-secondary text-xs disabled:opacity-40">Previous</button>
            <span>Page {page} of {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} className="btn-secondary text-xs disabled:opacity-40">Next</button>
          </div>
        </div>
      )}
    </div>
  );
}

const PROVIDER_ICON_COLOR = { google: 'text-amber-500', microsoft: 'text-sky-500' };
const PROVIDERS_META = { google: { label: 'Google' }, microsoft: { label: 'Microsoft' } };

function RedirectUriBox({ provider }) {
  const [copied, setCopied] = useState(false);
  // Best guess at the deployment's public origin -- correct whenever the
  // frontend and backend share one origin (the common case in production).
  // If they don't (e.g. this dev environment's frontend/backend run on
  // different ports), the admin adjusts the host to match wherever the
  // backend is actually reachable; the path itself never changes.
  const uri = `${window.location.origin}/api/auth/sso/callback/${provider}`;
  const copy = () => {
    navigator.clipboard?.writeText(uri);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <label className="label">Redirect URI — paste this into your {PROVIDERS_META[provider]?.label} app's allowed redirect URIs</label>
      <div className="flex items-center gap-1.5">
        <code className="input flex-1 text-xs overflow-x-auto whitespace-nowrap">{uri}</code>
        <button type="button" onClick={copy} className="btn-secondary text-xs shrink-0">
          {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
        </button>
      </div>
      <p className="text-xs text-slate-400 mt-1">Register your OAuth app there first — you'll get a client ID and secret to paste below.</p>
    </div>
  );
}

function SsoProviderModal({ initial, availableProviders, onClose, onSaved }) {
  const [provider, setProvider] = useState(initial?.provider || availableProviders[0] || 'google');
  const [clientId, setClientId] = useState(initial?.client_id || '');
  const [clientSecret, setClientSecret] = useState('');
  const [tenantId, setTenantId] = useState(initial?.tenant_id || '');
  const [allowedDomain, setAllowedDomain] = useState(initial?.allowed_domain || '');
  const [autoRole, setAutoRole] = useState(initial?.auto_provision_role || 'requester');
  const [enabled, setEnabled] = useState(initial?.enabled !== undefined ? !!initial.enabled : true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!clientId.trim() || (!initial && !clientSecret.trim())) { setError('Client ID and secret are required.'); return; }
    setSaving(true);
    setError('');
    const body = { client_id: clientId.trim(), tenant_id: tenantId.trim(), allowed_domain: allowedDomain.trim(), auto_provision_role: autoRole, enabled };
    if (clientSecret.trim()) body.client_secret = clientSecret.trim();
    try {
      if (initial?.id) await api.patch(`/auth/sso/${initial.id}`, body);
      else await api.post('/auth/sso', { ...body, provider });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? `Edit ${PROVIDERS_META[provider]?.label}` : 'Connect a sign-in provider'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

        {!initial && (
          <div>
            <label className="label">Provider</label>
            <Select value={provider} onChange={setProvider} options={availableProviders.map((p) => ({ value: p, label: PROVIDERS_META[p]?.label || p }))} />
          </div>
        )}

        <RedirectUriBox provider={provider} />

        <div>
          <label className="label">Client ID</label>
          <input className="input" required value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </div>
        <div>
          <label className="label">Client secret {initial && <span className="text-slate-400 font-normal">(leave blank to keep the current one)</span>}</label>
          <input className="input" type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={initial ? '••••••••' : ''} />
        </div>
        {provider === 'microsoft' && (
          <div>
            <label className="label">Tenant ID <span className="text-slate-400 font-normal">(optional — blank allows any Microsoft account)</span></label>
            <input className="input" value={tenantId} onChange={(e) => setTenantId(e.target.value)} placeholder="common" />
          </div>
        )}
        <div>
          <label className="label">Restrict to email domain <span className="text-slate-400 font-normal">(strongly recommended)</span></label>
          <input className="input" value={allowedDomain} onChange={(e) => setAllowedDomain(e.target.value)} placeholder="e.g. yourcompany.com" />
          <p className="text-xs text-slate-400 mt-1">Without this, anyone with a {PROVIDERS_META[provider]?.label} account can sign themselves into this workspace.</p>
        </div>
        <div>
          <label className="label">New sign-ins get the role</label>
          <Select value={autoRole} onChange={setAutoRole} options={[{ value: 'requester', label: 'Requester' }, { value: 'agent', label: 'Agent' }]} />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled — shown as a sign-in option
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SsoTab() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [modal, setModal] = useState(null); // null | {} | {id,...}

  const load = async () => {
    try {
      setData(await api.get('/auth/sso'));
    } catch (e) {
      setLoadError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const toggle = async (p) => { await api.patch(`/auth/sso/${p.id}`, { enabled: !p.enabled }); load(); };
  const remove = async (p) => {
    if (!confirm(`Disconnect ${PROVIDERS_META[p.provider]?.label}? Anyone who signs in with it won't be able to until it's reconnected.`)) return;
    await api.del(`/auth/sso/${p.id}`);
    load();
  };

  if (loadError && !data) return <LoadErrorState error={loadError} onRetry={load} />;
  if (!data) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;
  const { providers } = data;
  const configuredKeys = new Set(providers.map((p) => p.provider));
  const availableToAdd = Object.keys(PROVIDERS_META).filter((k) => !configuredKeys.has(k));

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
        Each provider is your own OAuth app registration (a Google Cloud project or a Microsoft Entra app) — nothing is shared across workspaces or with anyone else.
      </p>

      {providers.length === 0 ? (
        <EmptyState icon={LogIn} title="No sign-in providers connected" description="Connect Google or Microsoft so people can sign in with their company account." />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {providers.map((p) => (
            <div key={p.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <LogIn size={16} className={`shrink-0 ${PROVIDER_ICON_COLOR[p.provider]}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{PROVIDERS_META[p.provider]?.label}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {p.allowed_domain ? `@${p.allowed_domain} only` : 'Any account (no domain restriction)'} · new sign-ins become {p.auto_provision_role}
                  </div>
                </div>
                <button onClick={() => toggle(p)} className={`text-xs px-2 py-1 rounded-md shrink-0 ${p.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>
                  {p.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button onClick={() => setModal(p)} className="text-slate-400 hover:text-brand-600 shrink-0" title="Edit"><Pencil size={15} /></button>
                <button onClick={() => remove(p)} className="text-slate-400 hover:text-red-500 shrink-0" title="Disconnect"><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {availableToAdd.length > 0 && (
        <div className="flex gap-2">
          {availableToAdd.map((key) => (
            <button key={key} onClick={() => setModal({ provider: key })} className="btn-secondary text-xs">
              <Plus size={12} /> Connect {PROVIDERS_META[key].label}
            </button>
          ))}
        </div>
      )}

      {modal && (
        <SsoProviderModal
          initial={modal.id ? modal : null}
          availableProviders={modal.id ? [modal.provider] : availableToAdd}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}

const DIRECTORY_TYPE_META = { ldap: { label: 'LDAP / Active Directory' }, microsoft_graph: { label: 'Microsoft Graph (Azure AD / Entra ID)' } };
const DEFAULT_LDAP_ATTR_MAP = { email: 'mail', name: 'displayName', employeeId: 'employeeID', department: 'department', title: 'title', manager: 'manager', office: 'physicalDeliveryOfficeName' };

function DirectoryProviderModal({ initial, customRoles, onClose, onSaved }) {
  const [type, setType] = useState(initial?.type || 'ldap');
  const [name, setName] = useState(initial?.name || '');
  const [syncInterval, setSyncInterval] = useState(initial?.sync_interval_minutes ?? 0);
  const [autoRole, setAutoRole] = useState(initial?.auto_provision_role || 'requester');
  const [defaultRoleId, setDefaultRoleId] = useState(initial?.default_custom_role_id || '');
  const [defaultTeam, setDefaultTeam] = useState(initial?.default_team || '');
  const [enabled, setEnabled] = useState(initial?.enabled !== undefined ? !!initial.enabled : true);

  const cfg = initial?.config || {};
  const [url, setUrl] = useState(cfg.url || '');
  const [bindDN, setBindDN] = useState(cfg.bindDN || '');
  const [bindPassword, setBindPassword] = useState('');
  const [baseDN, setBaseDN] = useState(cfg.baseDN || '');
  const [userFilter, setUserFilter] = useState(cfg.userFilter || '(objectClass=user)');
  const [loginAttribute, setLoginAttribute] = useState(cfg.loginAttribute || 'userPrincipalName');
  const [attrMap, setAttrMap] = useState({ ...DEFAULT_LDAP_ATTR_MAP, ...(cfg.attributeMap || {}) });

  const [tenantId, setTenantId] = useState(cfg.tenant_id || '');
  const [clientId, setClientId] = useState(cfg.client_id || '');
  const [clientSecret, setClientSecret] = useState('');

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [error, setError] = useState('');

  const buildConfig = () => (
    type === 'ldap'
      ? { url, bindDN, baseDN, userFilter, loginAttribute, attributeMap: attrMap, ...(bindPassword ? { bindPassword } : {}) }
      : { tenant_id: tenantId, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) }
  );

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        name, config: buildConfig(), sync_interval_minutes: Number(syncInterval) || 0,
        auto_provision_role: autoRole, default_custom_role_id: defaultRoleId || null, default_team: defaultTeam || null, enabled,
      };
      if (initial?.id) await api.patch(`/directory/${initial.id}`, body);
      else await api.post('/directory', { ...body, type });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Test what's on the form right now, not what's saved -- lets an
      // admin check credentials before committing them. If this is a new
      // (unsaved) provider, save-then-test isn't possible yet, so this
      // tests via a throwaway POST-less path: the same /:id/test route,
      // but only once the provider already exists. For a brand-new
      // provider, save first, then use the row's own Test button.
      if (!initial?.id) { setError('Save the provider first, then use Test from the list.'); return; }
      const result = await api.post(`/directory/${initial.id}/test`, {});
      setTestResult(result);
    } catch (e) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Modal title={initial?.id ? `Edit ${name}` : 'Connect a directory'} onClose={onClose} maxWidth="max-w-xl">
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Type</label>
            <Select disabled={!!initial?.id} value={type} onChange={setType} options={Object.entries(DIRECTORY_TYPE_META).map(([v, m]) => ({ value: v, label: m.label }))} />
          </div>
          <div>
            <label className="label">Name</label>
            <input className="input" required placeholder="e.g. Corporate AD" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>

        {type === 'ldap' ? (
          <div className="space-y-3">
            <div>
              <label className="label">Server URL</label>
              <input className="input" required placeholder="ldaps://dc.company.local:636" value={url} onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Service bind DN</label>
                <input className="input" required placeholder="cn=svc-itsm,ou=Service Accounts,dc=company,dc=local" value={bindDN} onChange={(e) => setBindDN(e.target.value)} />
              </div>
              <div>
                <label className="label">Service bind password {initial && <span className="text-slate-400 font-normal">(leave blank to keep)</span>}</label>
                <input className="input" type="password" required={!initial} value={bindPassword} onChange={(e) => setBindPassword(e.target.value)} placeholder={initial ? '••••••••' : ''} />
              </div>
            </div>
            <p className="text-xs text-slate-400 -mt-1">Used only to search the directory — never an end user's own password. Each person's sign-in still validates with their own credentials, live, against the directory.</p>
            <div>
              <label className="label">Base DN</label>
              <input className="input" required placeholder="ou=Users,dc=company,dc=local" value={baseDN} onChange={(e) => setBaseDN(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">User filter</label>
                <input className="input" value={userFilter} onChange={(e) => setUserFilter(e.target.value)} />
              </div>
              <div>
                <label className="label">Login attribute</label>
                <input className="input" value={loginAttribute} onChange={(e) => setLoginAttribute(e.target.value)} placeholder="userPrincipalName or sAMAccountName" />
              </div>
            </div>
            <div>
              <label className="label mb-1.5">Attribute mapping</label>
              <div className="grid grid-cols-2 gap-2">
                {Object.keys(DEFAULT_LDAP_ATTR_MAP).map((key) => (
                  <div key={key} className="flex items-center gap-1.5">
                    <span className="text-xs text-slate-400 w-20 shrink-0 capitalize">{key === 'employeeId' ? 'Employee ID' : key}</span>
                    <input className="input py-1 text-xs" value={attrMap[key] || ''} onChange={(e) => setAttrMap({ ...attrMap, [key]: e.target.value })} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
              Needs an Entra ID app registration with application permissions <code>User.Read.All</code> (or <code>Directory.Read.All</code>), admin-consented — separate from any Microsoft sign-in provider under Single Sign-On, which only needs delegated permissions.
            </p>
            <div>
              <label className="label">Tenant ID</label>
              <input className="input" required value={tenantId} onChange={(e) => setTenantId(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Client ID</label>
                <input className="input" required value={clientId} onChange={(e) => setClientId(e.target.value)} />
              </div>
              <div>
                <label className="label">Client secret {initial && <span className="text-slate-400 font-normal">(leave blank to keep)</span>}</label>
                <input className="input" type="password" required={!initial} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={initial ? '••••••••' : ''} />
              </div>
            </div>
            <p className="text-xs text-slate-400">Sign-in for Graph-sourced accounts still goes through the existing Microsoft OAuth option under Single Sign-On — this connection only provisions/deprovisions accounts.</p>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div>
            <label className="label">Sync every</label>
            <Select
              value={syncInterval} onChange={(v) => setSyncInterval(Number(v))}
              options={[{ value: 0, label: 'Manual only' }, { value: 30, label: '30 min' }, { value: 60, label: '1 hour' }, { value: 360, label: '6 hours' }, { value: 1440, label: '24 hours' }]}
            />
          </div>
          <div>
            <label className="label">New accounts get role</label>
            <Select value={autoRole} onChange={setAutoRole} options={[{ value: 'requester', label: 'Requester' }, { value: 'agent', label: 'Agent' }]} />
          </div>
          <div>
            <label className="label">Delegated role <span className="text-slate-400 font-normal">(optional)</span></label>
            <Select
              placeholder="None" value={defaultRoleId} onChange={setDefaultRoleId}
              options={[{ value: '', label: 'None' }, ...customRoles.map((r) => ({ value: r.id, label: r.name }))]}
            />
          </div>
        </div>
        <div>
          <label className="label">Default group/team <span className="text-slate-400 font-normal">(used when the directory has no department set)</span></label>
          <input className="input" value={defaultTeam} onChange={(e) => setDefaultTeam(e.target.value)} placeholder="e.g. Service Desk" />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>

        {initial?.id && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={runTest} disabled={testing} className="btn-secondary text-xs"><RefreshCw size={12} className={testing ? 'animate-spin' : ''} /> Test connection</button>
            {testResult && (
              <span className={`text-xs ${testResult.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                {testResult.ok ? `Connected — sample of ${testResult.sampleCount} entries` : testResult.error}
              </span>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DirectorySyncTab() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [customRoles, setCustomRoles] = useState([]);
  const [modal, setModal] = useState(null); // null | 'new' | provider
  const [syncing, setSyncing] = useState('');
  const [syncResult, setSyncResult] = useState({});
  const [logsFor, setLogsFor] = useState(null);
  const [logs, setLogs] = useState(null);

  const load = async () => {
    setLoadError('');
    try {
      const [dirRes, rolesRes] = await Promise.all([api.get('/directory'), api.get('/custom-roles')]);
      setData(dirRes);
      setCustomRoles(rolesRes.roles);
    } catch (e) {
      setLoadError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const toggle = async (p) => { await api.patch(`/directory/${p.id}`, { enabled: !p.enabled }); load(); };
  const remove = async (p) => {
    if (!confirm(`Remove "${p.name}"? Accounts it already provisioned stay, just no longer synced.`)) return;
    await api.del(`/directory/${p.id}`);
    load();
  };
  const runSync = async (p) => {
    setSyncing(p.id);
    setSyncResult((r) => ({ ...r, [p.id]: null }));
    try {
      const result = await api.post(`/directory/${p.id}/sync`, {});
      setSyncResult((r) => ({ ...r, [p.id]: result }));
      load();
    } catch (e) {
      setSyncResult((r) => ({ ...r, [p.id]: { error: e.message } }));
    } finally {
      setSyncing('');
    }
  };
  const viewLogs = async (p) => {
    setLogsFor(p.id);
    setLogs(null);
    const { logs: rows } = await api.get(`/directory/${p.id}/log`);
    setLogs(rows);
  };

  if (loadError && !data) return <LoadErrorState error={loadError} onRetry={load} />;
  if (!data) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;
  const { providers } = data;

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-slate-500 dark:text-slate-400 max-w-lg">
          Provisions accounts from an external directory and deactivates anyone removed or disabled there — never a hard delete. Password login for LDAP-linked accounts validates live against the directory.
        </p>
        <button onClick={() => setModal('new')} className="btn-primary text-xs shrink-0"><Plus size={13} /> Connect directory</button>
      </div>

      {providers.length === 0 ? (
        <EmptyState icon={UsersRound} title="No directory connected" description="Connect Active Directory (LDAP) or Microsoft Graph to provision and auto-deactivate accounts." />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {providers.map((p) => (
            <div key={p.id} className="px-4 py-3 space-y-1.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{p.name}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {DIRECTORY_TYPE_META[p.type]?.label} · {p.sync_interval_minutes > 0 ? `syncs every ${p.sync_interval_minutes} min` : 'manual sync only'} · new accounts become {p.auto_provision_role}
                  </div>
                </div>
                <button onClick={() => toggle(p)} className={`text-xs px-2 py-1 rounded-md shrink-0 ${p.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>
                  {p.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button onClick={() => runSync(p)} disabled={syncing === p.id} className="btn-secondary text-xs shrink-0">
                  {syncing === p.id ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Sync now
                </button>
                <button onClick={() => viewLogs(p)} className="text-slate-400 hover:text-slate-600 shrink-0" title="Sync history"><History size={15} /></button>
                <button onClick={() => setModal(p)} className="text-slate-400 hover:text-brand-600 shrink-0" title="Edit"><Pencil size={15} /></button>
                <button onClick={() => remove(p)} className="text-slate-400 hover:text-red-500 shrink-0" title="Remove"><Trash2 size={15} /></button>
              </div>
              {(p.last_sync_summary || syncResult[p.id]) && (
                <div className={`text-xs ${syncResult[p.id]?.error ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}>
                  {syncResult[p.id]?.error || syncResult[p.id]?.summary || p.last_sync_summary}
                  {p.last_synced_at && !syncResult[p.id] && ` · last synced ${new Date(p.last_synced_at).toLocaleString()}`}
                </div>
              )}
              {logsFor === p.id && (
                <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-2 text-xs space-y-1 max-h-40 overflow-y-auto">
                  {!logs && <div className="text-slate-400">Loading…</div>}
                  {logs?.length === 0 && <div className="text-slate-400">No sync runs yet.</div>}
                  {logs?.map((l) => (
                    <div key={l.id} className="flex items-center gap-2">
                      <span className={`badge shrink-0 ${l.status === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'}`}>{l.status}</span>
                      <span className="text-slate-500 dark:text-slate-400 truncate">{l.summary}</span>
                      <span className="text-slate-300 dark:text-slate-600 ml-auto shrink-0 font-mono">{new Date(l.created_at).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {modal && (
        <DirectoryProviderModal
          initial={modal === 'new' ? null : modal} customRoles={customRoles}
          onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}

function NewApiKeyModal({ scopeCatalog, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const toggle = (key) => setScopes((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);

  const submit = async (e) => {
    e.preventDefault();
    if (!scopes.length) { setError('Grant at least one scope.'); return; }
    setSaving(true);
    setError('');
    try {
      const result = await api.post('/api-keys', { name: name.trim(), scopes, expires_at: expiresAt || null });
      onCreated(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New API key" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Name</label>
          <input className="input" required placeholder="e.g. Monitoring system, HR platform sync" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Scopes</label>
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
            {scopeCatalog.map((s) => (
              <label key={s.key} className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 cursor-pointer">
                <input type="checkbox" checked={scopes.includes(s.key)} onChange={() => toggle(s.key)} /> {s.label}
                <code className="text-xs text-slate-400 ml-auto">{s.key}</code>
              </label>
            ))}
          </div>
        </div>
        <div>
          <label className="label">Expires <span className="text-slate-400 font-normal">(optional)</span></label>
          <input type="date" className="input" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Create key
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RevealKeyModal({ rawKey, onClose }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard?.writeText(rawKey); setCopied(true); setTimeout(() => setCopied(false), 1500); };
  return (
    <Modal title="Your new API key" onClose={onClose}>
      <div className="space-y-3">
        <div className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 rounded-lg px-3 py-2.5">
          <AlertOctagon size={16} className="shrink-0 mt-0.5" />
          Copy this now — for your security, it won't be shown again. If you lose it, revoke this key and create a new one.
        </div>
        <div className="flex items-center gap-1.5">
          <code className="input flex-1 text-xs overflow-x-auto whitespace-nowrap font-mono">{rawKey}</code>
          <button type="button" onClick={copy} className="btn-secondary shrink-0">
            {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
          </button>
        </div>
        <div className="flex justify-end pt-2">
          <button onClick={onClose} className="btn-primary">Done</button>
        </div>
      </div>
    </Modal>
  );
}

function ApiKeysTab() {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [revealKey, setRevealKey] = useState(null);

  const load = async () => {
    try {
      setData(await api.get('/api-keys'));
    } catch (e) {
      setLoadError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const toggle = async (k) => { await api.patch(`/api-keys/${k.id}`, { enabled: !k.enabled }); load(); };
  const revoke = async (k) => {
    if (!confirm(`Revoke "${k.name}"? Any system using this key will immediately lose access.`)) return;
    await api.del(`/api-keys/${k.id}`);
    load();
  };

  if (loadError && !data) return <LoadErrorState error={loadError} onRetry={load} />;
  if (!data) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;
  const { keys, scopes } = data;

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
        Issue a key to let another company system call the public developer API directly — see the <a href="/developer" target="_blank" rel="noreferrer" className="text-brand-600 dark:text-brand-400 hover:underline">API documentation</a> for endpoints and examples.
      </p>
      <div className="flex justify-end">
        <button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> New API key</button>
      </div>

      {keys.length === 0 ? (
        <EmptyState icon={Webhook} title="No API keys yet" description="Create one to let an external system integrate with this workspace." />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {keys.map((k) => (
            <div key={k.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <Webhook size={16} className="text-slate-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{k.name}</div>
                  <div className="text-xs text-slate-500 truncate flex items-center gap-1.5">
                    <code className="font-mono">{k.key_prefix}…</code>
                    · {k.scopes.length} scope{k.scopes.length === 1 ? '' : 's'}
                    · {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleDateString()}` : 'never used'}
                    {k.expires_at && ` · expires ${new Date(k.expires_at).toLocaleDateString()}`}
                  </div>
                </div>
                <button onClick={() => toggle(k)} className={`text-xs px-2 py-1 rounded-md shrink-0 ${k.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>
                  {k.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button onClick={() => revoke(k)} className="text-slate-400 hover:text-red-500 shrink-0" title="Revoke"><Trash2 size={15} /></button>
              </div>
              <div className="flex flex-wrap gap-1 mt-2 pl-7">
                {k.scopes.map((s) => <span key={s} className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 font-mono text-[10px]">{s}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <NewApiKeyModal
          scopeCatalog={scopes}
          onClose={() => setShowNew(false)}
          onCreated={(result) => { setShowNew(false); setRevealKey(result.rawKey); load(); }}
        />
      )}
      {revealKey && <RevealKeyModal rawKey={revealKey} onClose={() => setRevealKey(null)} />}
    </div>
  );
}

// Downloads a fetch() response as a real file save via a throwaway <a
// download> element -- the same pattern AuditLogTab's exportCsv already
// uses, needed because the auth token has to go on an Authorization header
// (a plain <a href> GET can't carry one, and this route is behind
// requireRole('admin')).
async function downloadFile(path, filename) {
  const resp = await fetch(path, { headers: { authorization: `Bearer ${getStoredToken()}` } });
  if (!resp.ok) {
    const data = await resp.json().catch(() => null);
    throw new Error(data?.error || `Download failed (${resp.status})`);
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function BackupTab() {
  const [summary, setSummary] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(null); // null | 'export' | 'database'
  const [error, setError] = useState('');
  const [done, setDone] = useState(null); // null | 'export' | 'database'

  const load = async () => {
    setLoadError('');
    try {
      setSummary(await api.get('/admin/backup/summary'));
    } catch (e) {
      setLoadError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const runExport = async () => {
    setBusy('export'); setError(''); setDone(null);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await downloadFile('/api/admin/backup/export', `itsm-ai-backup-${summary?.workspace?.slug || 'workspace'}-${today}.json`);
      setDone('export');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const runDatabase = async () => {
    setBusy('database'); setError(''); setDone(null);
    try {
      const today = new Date().toISOString().slice(0, 10);
      await downloadFile('/api/admin/backup/database', `itsm-ai-database-${today}.db`);
      setDone('database');
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  if (loadError && !summary) return <LoadErrorState error={loadError} onRetry={load} />;
  if (!summary) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  const totalRecords = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  const topCounts = Object.entries(summary.counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 8);

  return (
    <div className="space-y-4 max-w-2xl">
      {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

      <div className="card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-50 dark:bg-brand-500/10 flex items-center justify-center shrink-0">
            <FileJson size={18} className="text-brand-600 dark:text-brand-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-slate-800 dark:text-slate-100">Export workspace data</div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              A readable JSON file with everything in <strong>{summary.workspace.name}</strong> — tickets, assets, the
              knowledge base, SLA policies, automations, and more ({totalRecords.toLocaleString()} records across{' '}
              {Object.values(summary.counts).filter((n) => n > 0).length} record types). Credentials and integration
              secrets are never included.
            </p>
          </div>
        </div>

        {topCounts.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pl-[52px]">
            {topCounts.map(([key, n]) => (
              <span key={key} className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 text-[11px]">
                {n.toLocaleString()} {key.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 pl-[52px]">
          <button onClick={runExport} disabled={busy === 'export'} className="btn-primary text-xs">
            {busy === 'export' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download JSON export
          </button>
          {done === 'export' && <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><Check size={12} /> Downloaded</span>}
        </div>
      </div>

      <div className="card p-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-500/10 flex items-center justify-center shrink-0">
            <HardDrive size={18} className="text-amber-600 dark:text-amber-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium text-slate-800 dark:text-slate-100 flex items-center gap-2">
              Full database backup
              <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 text-[10px]">Super-admin only</span>
            </div>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
              The complete underlying SQLite database ({formatBytes(summary.dbSizeBytes)}) — every workspace on this
              instance, for true disaster recovery. Stored secrets inside it stay encrypted at rest; this is a snapshot
              taken at download time, not a live file copy.
            </p>
          </div>
        </div>

        {summary.canDownloadDatabase ? (
          <div className="flex items-center gap-2 pl-[52px]">
            <button onClick={runDatabase} disabled={busy === 'database'} className="btn-secondary text-xs">
              {busy === 'database' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Download database (.db)
            </button>
            {done === 'database' && <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><Check size={12} /> Downloaded</span>}
          </div>
        ) : (
          <p className="text-xs text-slate-400 pl-[52px]">Only a platform super-admin can download the full database.</p>
        )}
      </div>
    </div>
  );
}

const STATUS_TONE = (code) => {
  if (code >= 500) return 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-400';
  if (code >= 400) return 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400';
  return 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';
};

// Platform-operator only (see error_log's comment in db.js) -- shows the
// same "restricted" framing as BackupTab's full-database card rather than
// hiding the section outright, so a regular workspace admin at least
// understands why it's here and who to ask, instead of it silently missing.
function ErrorMonitoringTab() {
  const [errors, setErrors] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [clearing, setClearing] = useState(false);

  const load = async () => {
    setLoadError('');
    setForbidden(false);
    try {
      const data = await api.get('/admin/errors');
      setErrors(data.errors);
    } catch (e) {
      if (/super-admin/i.test(e.message)) setForbidden(true);
      else setLoadError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const clearAll = async () => {
    if (!confirm('Clear the entire error log? This cannot be undone.')) return;
    setClearing(true);
    try {
      await api.del('/admin/errors');
      await load();
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setClearing(false);
    }
  };

  if (forbidden) {
    return (
      <div className="card p-6 flex items-start gap-3 max-w-2xl">
        <Bug size={18} className="text-slate-400 shrink-0 mt-0.5" />
        <div>
          <div className="font-medium text-slate-700 dark:text-slate-200">Super-admin only</div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Server error details (including stack traces) are only shown to a platform super-admin, since they can
            reveal internal implementation detail beyond any one workspace. Ask your platform operator if you need
            something investigated.
          </p>
        </div>
      </div>
    );
  }
  if (loadError && !errors) return <LoadErrorState error={loadError} onRetry={load} />;
  if (!errors) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Unhandled server errors across every workspace on this instance — most recent 200. Nothing here means the
          server hasn't hit an unexpected error recently.
        </p>
        {errors.length > 0 && (
          <button onClick={clearAll} disabled={clearing} className="btn-secondary text-xs shrink-0">
            {clearing ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />} Clear all
          </button>
        )}
      </div>

      {errors.length === 0 ? (
        <EmptyState icon={Bug} title="No errors recorded" description="Clean bill of health — nothing has hit the server's error handler yet." />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {errors.map((e) => {
            const isOpen = expanded === e.id;
            return (
              <div key={e.id}>
                <button type="button" onClick={() => setExpanded(isOpen ? null : e.id)} className="w-full flex items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40">
                  <span className={`badge shrink-0 mt-0.5 ${STATUS_TONE(e.status_code || 500)}`}>{e.status_code || 500}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <span className="font-mono">{new Date(e.created_at).toLocaleString()}</span>
                      {e.method && e.path && <span className="font-mono truncate">{e.method} {e.path}</span>}
                      {e.user_email && <span className="truncate">— {e.user_email}</span>}
                    </div>
                    <div className="text-sm text-slate-700 dark:text-slate-200 truncate">{e.message}</div>
                  </div>
                  {e.stack && (isOpen ? <ChevronUp size={14} className="text-slate-300 shrink-0 mt-1" /> : <ChevronDown size={14} className="text-slate-300 shrink-0 mt-1" />)}
                </button>
                {isOpen && e.stack && (
                  <pre className="mx-4 mb-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/60 text-[11px] text-slate-600 dark:text-slate-300 overflow-x-auto whitespace-pre-wrap">{e.stack}</pre>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function GroupModal({ initial, users, customRoles, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [managerId, setManagerId] = useState(initial?.manager_user_id || '');
  const [defaultRoleId, setDefaultRoleId] = useState(initial?.default_custom_role_id || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { name, description, manager_user_id: managerId || null, default_custom_role_id: defaultRoleId || null };
      if (initial?.id) await api.patch(`/groups/${initial.id}`, payload);
      else await api.post('/groups', payload);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit group' : 'New group'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Group name</label>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Network Support" />
        </div>
        <div>
          <label className="label">Description (optional)</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div>
          <label className="label">Manager (optional)</label>
          <Select
            placeholder="Not set" value={managerId} onChange={setManagerId}
            options={[{ value: '', label: 'Not set' }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
          />
          <p className="text-xs text-slate-400 mt-1">Shown as this group's manager, and selectable as a Service Catalog item's approver ("this group's manager").</p>
        </div>
        <div>
          <label className="label">Grants role to members (optional)</label>
          <Select
            placeholder="None" value={defaultRoleId} onChange={setDefaultRoleId}
            options={[{ value: '', label: 'None' }, ...customRoles.map((r) => ({ value: r.id, label: r.name }))]}
          />
          <p className="text-xs text-slate-400 mt-1">Every member of this group gets this role's permissions just by being added — on top of, not instead of, any personal delegated role they already have. Takes effect on their next login.</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GroupsTab() {
  const [groups, setGroups] = useState(null);
  const [users, setUsers] = useState([]);
  const [customRoles, setCustomRoles] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [modal, setModal] = useState(null); // null | 'new' | group
  const [expanded, setExpanded] = useState(null);
  const [addingTo, setAddingTo] = useState(null);
  const [pickUserId, setPickUserId] = useState('');

  const load = async () => {
    try {
      const [groupsRes, usersRes, rolesRes] = await Promise.all([api.get('/groups'), api.get('/auth/users/all'), api.get('/custom-roles')]);
      setGroups(groupsRes.groups);
      setUsers(usersRes.users.filter((x) => x.active));
      setCustomRoles(rolesRes.roles);
    } catch (e) {
      setLoadError(e.message);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (group) => {
    if (!confirm(`Delete group "${group.name}"? This does not affect its members' accounts.`)) return;
    await api.del(`/groups/${group.id}`);
    load();
  };

  const addMember = async (groupId) => {
    if (!pickUserId) return;
    await api.post(`/groups/${groupId}/members`, { user_id: pickUserId });
    setPickUserId('');
    setAddingTo(null);
    load();
  };

  const removeMember = async (groupId, userId) => {
    await api.del(`/groups/${groupId}/members/${userId}`);
    load();
  };

  if (loadError && !groups) return <LoadErrorState error={loadError} onRetry={load} />;
  if (!groups) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New group</button>
      </div>

      {groups.length === 0 ? (
        <EmptyState icon={UsersRound} title="No groups yet" description="Groups let you organize agents by team — e.g. Network, Service Desk, Facilities." />
      ) : (
        <div className="space-y-2">
          {groups.map((g) => {
            const isOpen = expanded === g.id;
            const available = users.filter((u) => !g.members.some((m) => m.id === u.id));
            return (
              <div key={g.id} className="card p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-800 dark:text-slate-100 truncate">{g.name}</div>
                    {g.description && <div className="text-xs text-slate-500 truncate">{g.description}</div>}
                    <div className="flex flex-wrap gap-1 mt-1">
                      {g.manager_user_id && (
                        <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                          Manager: {users.find((u) => u.id === g.manager_user_id)?.name || '—'}
                        </span>
                      )}
                      {g.default_custom_role_id && (
                        <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400">
                          Grants: {customRoles.find((r) => r.id === g.default_custom_role_id)?.name || '—'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {g.members.length} member{g.members.length === 1 ? '' : 's'}
                    </span>
                    <button onClick={() => setModal(g)} className="btn-ghost text-xs">Edit</button>
                    <button onClick={() => remove(g)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                    <button onClick={() => setExpanded(isOpen ? null : g.id)} className="text-slate-400 hover:text-slate-600">
                      {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
                    {g.members.map((m) => (
                      <div key={m.id} className="flex items-center gap-2.5">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-[10px] font-semibold shrink-0" style={{ backgroundColor: m.avatar_color || '#6366f1' }}>
                          {m.name?.[0]?.toUpperCase() || '?'}
                        </div>
                        <div className="min-w-0 flex-1 text-sm text-slate-700 dark:text-slate-200 truncate">
                          {m.name} <span className="text-xs text-slate-400">· {m.email}</span>
                        </div>
                        <button onClick={() => removeMember(g.id, m.id)} className="text-slate-400 hover:text-red-500"><X size={14} /></button>
                      </div>
                    ))}
                    {g.members.length === 0 && <div className="text-xs text-slate-400">No members yet.</div>}

                    {addingTo === g.id ? (
                      <div className="flex items-center gap-2 pt-1">
                        <Select
                          className="flex-1" placeholder="Select user…" value={pickUserId} onChange={setPickUserId}
                          options={available.map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
                        />
                        <button onClick={() => addMember(g.id)} className="btn-primary text-xs py-1.5">Add</button>
                        <button onClick={() => { setAddingTo(null); setPickUserId(''); }} className="btn-secondary text-xs py-1.5">Cancel</button>
                      </div>
                    ) : (
                      <button onClick={() => setAddingTo(g.id)} className="text-xs text-brand-600 hover:text-brand-700 font-medium pt-1">+ Add member</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {modal && (
        <GroupModal
          initial={modal === 'new' ? null : modal} users={users} customRoles={customRoles}
          onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}

function WorkspaceModal({ initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (initial?.id) await api.patch(`/workspaces/${initial.id}`, { name });
      else await api.post('/workspaces', { name });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Rename workspace' : 'New workspace'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Workspace name</label>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Marketing" />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function WorkspacesTab() {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [modal, setModal] = useState(null);

  const load = async () => {
    try {
      const { workspaces } = await api.get('/workspaces');
      setWorkspaces(workspaces);
    } catch (e) {
      setLoadError(e.message);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (ws) => {
    if (!confirm(`Delete workspace "${ws.name}"? All of its tickets, assets, groups and users lose access to this workspace.`)) return;
    try {
      await api.del(`/workspaces/${ws.id}`);
      load();
    } catch (e) {
      alert(e.message);
    }
  };

  if (loadError && !workspaces) return <LoadErrorState error={loadError} onRetry={load} />;
  if (!workspaces) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Each workspace is fully isolated — its tickets, assets, groups and users are only visible to people who belong to it. You'll only see workspaces you're a member of below.
      </p>
      <div className="flex justify-end">
        <button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New workspace</button>
      </div>
      <div className="card divide-y divide-slate-100 dark:divide-slate-800">
        {workspaces.map((ws) => (
          <div key={ws.id} className="flex items-center gap-3 px-4 py-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-semibold shrink-0 bg-gradient-to-br from-brand-500 to-brand-600">
              {ws.name?.[0]?.toUpperCase() || '?'}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{ws.name}</div>
              <div className="text-xs text-slate-500 truncate">{ws.slug}</div>
            </div>
            {user?.workspace_id === ws.id && (
              <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400 shrink-0">Current</span>
            )}
            <button onClick={() => setModal(ws)} className="btn-ghost text-xs shrink-0">Rename</button>
            <button onClick={() => remove(ws)} className="text-slate-400 hover:text-red-500 shrink-0"><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      {modal && (
        <WorkspaceModal initial={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
    </div>
  );
}

const TICKET_TYPES = ['incident', 'request', 'problem', 'change'];
// Priority and Status exist on every ticket regardless of type, so they're
// targetable on all four types. The rest are the extra fields that exist on
// each type's own form (Change has Risk/Planned dates/Rollback plan on top
// of the common four; nothing else does). Field Manager's custom fields are
// layered on top of this list per type, not a replacement for it.
const UNIVERSAL_FIELDS = ['priority', 'status'];
const TYPE_FIELD_CATALOG = {
  incident: ['category', 'subcategory', 'team', 'impact'],
  request: ['category', 'subcategory', 'team', 'impact'],
  problem: ['category', 'subcategory', 'team', 'impact'],
  change: ['category', 'subcategory', 'team', 'impact', 'risk', 'planned_start', 'planned_end', 'rollback_plan'],
};
const FIELD_META = {
  category: { label: 'Category' },
  subcategory: { label: 'Subcategory' },
  team: { label: 'Group' },
  impact: { label: 'Impact' },
  risk: { label: 'Risk' },
  planned_start: { label: 'Planned start' },
  planned_end: { label: 'Planned end' },
  rollback_plan: { label: 'Rollback plan' },
  priority: { label: 'Priority' },
  status: { label: 'Status' },
  catalog_item_name: { label: 'Service Item' },
  tasks_total: { label: 'Tasks — total' },
  tasks_open: { label: 'Tasks — open' },
  tasks_completed: { label: 'Tasks — completed' },
  all_tasks_completed: { label: 'All tasks completed?' },
};
// Read-only aggregates from the ticket's Tasks panel (services/tasks.js) --
// available as a CONDITION on every ticket type (a task checklist isn't
// type-specific), but never an action target: there's no real form field
// named "all_tasks_completed" to show/hide/mandate/set, only something a
// rule can react to. Kept out of ActionRow's field picker via `conditionOnly`
// rather than a second, parallel field-catalog concept.
const TASK_CONDITION_FIELDS = [
  { key: 'tasks_total', label: FIELD_META.tasks_total.label, conditionOnly: true },
  { key: 'tasks_open', label: FIELD_META.tasks_open.label, conditionOnly: true },
  { key: 'tasks_completed', label: FIELD_META.tasks_completed.label, conditionOnly: true },
  { key: 'all_tasks_completed', label: FIELD_META.all_tasks_completed.label, conditionOnly: true },
];
const TASK_FIELD_OPTIONS = { all_tasks_completed: ['true', 'false'] };
const TYPE_META = {
  incident: { label: 'Incident', icon: AlertTriangle, tile: 'from-red-400 to-red-600' },
  request: { label: 'Request', icon: Inbox, tile: 'from-brand-400 to-brand-600' },
  problem: { label: 'Problem', icon: Search, tile: 'from-purple-400 to-purple-600' },
  change: { label: 'Change', icon: GitBranch, tile: 'from-teal-400 to-teal-600' },
};
const builtinCatalog = (type) => [...UNIVERSAL_FIELDS, ...TYPE_FIELD_CATALOG[type]].map((key) => ({ key, label: FIELD_META[key].label }));

// The Field Manager UI now lives in
// components/admin/TicketFieldManagerTab.jsx -- it grew to cover built-in
// fields (their options, labels and colours) and the category taxonomy
// alongside custom fields, which was too much for this already-large file.
// builtinCatalog/FIELD_META above stay here: Business Rules and Lifecycles
// below still use them to enumerate targetable fields.

// ============================== Business Rules ==============================
// Business Rule Logic Engine: named IF/THEN rules with AND/OR-combined
// conditions and multiple actions per rule, evaluated in priority order.
// Targets whatever fields exist for a type — built-in ones above, plus
// anything Field Manager created. Never creates fields itself.

const OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];
const ACTION_TYPES = [
  { value: 'show_field', label: 'Show field' },
  { value: 'hide_field', label: 'Hide field' },
  { value: 'mandate_field', label: 'Mandate field (required)' },
  { value: 'set_options', label: 'Set dropdown options' },
  { value: 'remove_options', label: 'Remove dropdown options' },
  { value: 'set_value', label: 'Set field value' },
  { value: 'validate_field', label: 'Validate format' },
  { value: 'block', label: 'Block the save (custom message)' },
];
const VALIDATION_TYPES = [
  { value: '', label: 'None' },
  { value: 'regex', label: 'Matches pattern (regex)' },
  { value: 'min_length', label: 'Minimum length' },
  { value: 'max_length', label: 'Maximum length' },
  { value: 'number_range', label: 'Number between (min,max)' },
];
const emptyAction = () => ({ type: 'show_field', field: '', options: [], value: '', validation_type: '', validation_value: '', validation_message: '', message: '' });

// Built-in fields for a type plus whatever custom fields Field Manager has
// created for it — the full set Business Rules can target or react to.
// Request additionally gets a synthetic "Service Item" field backed live by
// the real Service Catalog (not something Field Manager creates).
function useTypeCatalog(type) {
  const [customFields, setCustomFields] = useState([]);
  useEffect(() => {
    if (!type) { setCustomFields([]); return; }
    api.get(`/custom-fields?ticket_type=${type}`).then(({ fields }) => setCustomFields(fields)).catch(() => setCustomFields([]));
  }, [type]);
  if (!type) return [];
  const catalogItemField = type === 'request' ? [{ key: 'catalog_item_name', label: 'Service Item', catalogItem: true }] : [];
  return [...builtinCatalog(type), ...catalogItemField, ...customFields.map((f) => ({ key: f.field_key, label: f.label, custom: true })), ...TASK_CONDITION_FIELDS];
}

// Every option-bearing field's real base options for a type (built-in enums,
// Field Manager dropdowns, live Service Catalog names) — what a condition's
// value picker and the Set/Remove Dropdown Options actions work against.
function useFieldOptionsMap(type) {
  const [map, setMap] = useState({});
  useEffect(() => {
    if (!type) { setMap({}); return; }
    api.get(`/business-rules/options?ticket_type=${type}`).then(({ options }) => setMap(options)).catch(() => setMap({}));
  }, [type]);
  return map;
}

function ConditionRow({ condition, catalog, fieldOptionsMap, onChange, onRemove }) {
  const options = TASK_FIELD_OPTIONS[condition.field] || fieldOptionsMap[condition.field];
  const needsValue = condition.operator !== 'is_empty' && condition.operator !== 'is_not_empty';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Select
        className="w-auto" placeholder="Choose a field…" value={condition.field} onChange={(v) => onChange({ ...condition, field: v })}
        options={catalog.map((f) => ({ value: f.key, label: f.label + (f.custom ? ' (custom)' : '') }))}
      />
      <Select className="w-auto" value={condition.operator} onChange={(v) => onChange({ ...condition, operator: v })} options={OPERATORS} />
      {needsValue && (
        options ? (
          <Select className="w-auto" placeholder="Choose…" value={condition.value} onChange={(v) => onChange({ ...condition, value: v })} options={options} />
        ) : (
          <input className="input w-auto" placeholder="value" value={condition.value} onChange={(e) => onChange({ ...condition, value: e.target.value })} />
        )
      )}
      <button type="button" onClick={onRemove} className="text-slate-400 hover:text-red-500 p-1.5"><X size={14} /></button>
    </div>
  );
}

function ActionRow({ action, catalog, fieldOptionsMap, onChange, onRemove }) {
  const needsOptionPicker = action.type === 'set_options' || action.type === 'remove_options';
  const isBlock = action.type === 'block';
  const optionBearingFields = catalog.filter((f) => fieldOptionsMap[f.key] !== undefined);
  // Task aggregates (all_tasks_completed etc.) are condition-only -- nothing
  // to show/hide/mandate/set on a field that doesn't really exist on the
  // ticket form, so they never appear as an action target.
  const fieldChoices = (needsOptionPicker ? optionBearingFields : catalog).filter((f) => !f.conditionOnly);
  const baseOptions = fieldOptionsMap[action.field] || [];
  const toggleOption = (opt) => {
    const has = (action.options || []).includes(opt);
    onChange({ ...action, options: has ? action.options.filter((o) => o !== opt) : [...(action.options || []), opt] });
  };

  return (
    <div className="rounded-lg border border-slate-200 dark:border-white/10 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <Select
          className="w-auto" value={action.type}
          onChange={(v) => onChange({ ...action, type: v, field: needsOptionPicker !== (v === 'set_options' || v === 'remove_options') ? '' : action.field })}
          options={ACTION_TYPES}
        />
        {!isBlock && (
          <Select
            className="w-auto" placeholder="Choose a field…" value={action.field} onChange={(v) => onChange({ ...action, field: v })}
            options={fieldChoices.map((f) => ({ value: f.key, label: f.label + (f.custom ? ' (custom)' : '') }))}
          />
        )}
        <button type="button" onClick={onRemove} className="text-slate-400 hover:text-red-500 p-1.5 ml-auto"><X size={14} /></button>
      </div>

      {isBlock && (
        <div>
          <input
            className="input" placeholder='Message shown to whoever tried to save, e.g. "Complete all tasks before resolving."'
            value={action.message} onChange={(e) => onChange({ ...action, message: e.target.value })}
          />
          <p className="text-[11px] text-slate-400 mt-1">Stops the create/update entirely when this rule's conditions match — pair it with a condition on <em>All tasks completed?</em> or any other field.</p>
        </div>
      )}

      {needsOptionPicker && action.field && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm text-slate-600 dark:text-slate-300 pl-1">
          {baseOptions.length === 0 && <span className="text-xs text-slate-400">This field has no options of its own yet.</span>}
          {baseOptions.map((opt) => (
            <label key={opt} className="flex items-center gap-1.5">
              <input type="checkbox" checked={(action.options || []).includes(opt)} onChange={() => toggleOption(opt)} /> {opt}
            </label>
          ))}
        </div>
      )}

      {action.type === 'set_value' && action.field && (
        fieldOptionsMap[action.field] ? (
          <Select className="w-auto" placeholder="Choose a value…" value={action.value} onChange={(v) => onChange({ ...action, value: v })} options={fieldOptionsMap[action.field]} />
        ) : (
          <input className="input w-auto" placeholder="value" value={action.value} onChange={(e) => onChange({ ...action, value: e.target.value })} />
        )
      )}

      {action.type === 'validate_field' && action.field && (
        <div className="flex items-center gap-2 flex-wrap">
          <Select className="w-auto" value={action.validation_type} onChange={(v) => onChange({ ...action, validation_type: v })} options={VALIDATION_TYPES} />
          {action.validation_type && (
            <>
              <input
                className="input w-auto"
                placeholder={action.validation_type === 'regex' ? 'e.g. ^AT-\\d{4}$' : action.validation_type === 'number_range' ? 'e.g. 1,100' : 'e.g. 10'}
                value={action.validation_value}
                onChange={(e) => onChange({ ...action, validation_value: e.target.value })}
              />
              <input
                className="input w-auto"
                placeholder="Custom error message (optional)"
                value={action.validation_message}
                onChange={(e) => onChange({ ...action, validation_message: e.target.value })}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Full rule builder. When opened from the Business Rules hub's own top-right
// "Create rule" (no type pre-chosen) it asks for the ticket type first, then
// reveals only that type's own fields — built-in and custom.
function RuleBuilderModal({ initialType, rule, onClose, onSaved }) {
  const [type, setType] = useState(initialType || '');
  const catalog = useTypeCatalog(type);
  const fieldOptionsMap = useFieldOptionsMap(type);
  const [name, setName] = useState(rule?.name || '');
  const [logic, setLogic] = useState(rule?.conditions?.logic || 'AND');
  const [conditions, setConditions] = useState(rule?.conditions?.rules || []);
  const [actions, setActions] = useState(rule?.actions?.length ? rule.actions.map((a) => ({ options: [], value: '', validation_type: '', validation_value: '', validation_message: '', ...a })) : [emptyAction()]);
  const [priority, setPriority] = useState(rule?.priority ?? 100);
  const [status, setStatus] = useState(rule?.status || 'active');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setCondition = (i, next) => setConditions(conditions.map((c, idx) => (idx === i ? next : c)));
  const setAction = (i, next) => setActions(actions.map((a, idx) => (idx === i ? next : a)));

  const save = async () => {
    setError('');
    if (!name.trim()) { setError('Rule name is required.'); return; }
    if (!type) { setError('Choose a ticket type.'); return; }
    const cleanActions = actions.filter((a) => (a.type === 'block' ? a.message?.trim() : a.field));
    if (!cleanActions.length) { setError('Add at least one complete action (a field selected, or a message for Block).'); return; }
    const cleanConditions = conditions.filter((c) => c.field);
    setSaving(true);
    try {
      const payload = {
        ticket_type: type, name: name.trim(),
        conditions: { logic, rules: cleanConditions },
        actions: cleanActions,
        priority: Number(priority) || 100,
        status,
      };
      if (rule) {
        await api.patch(`/business-rules/${rule.id}`, payload);
      } else {
        await api.post('/business-rules', payload);
      }
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={rule ? 'Edit rule' : 'Create rule'} maxWidth="max-w-2xl" onClose={onClose}>
      <div className="space-y-4">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

        {!initialType && (
          <div>
            <label className="label">Ticket type</label>
            <Select
              placeholder="Choose a ticket type…" value={type}
              onChange={(v) => { setType(v); setConditions([]); setActions([emptyAction()]); }}
              options={TICKET_TYPES.map((t) => ({ value: t, label: TYPE_META[t].label }))}
            />
          </div>
        )}

        {type && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="label">Rule name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Require Subcategory for Hardware" />
              </div>
              <div>
                <label className="label">Priority</label>
                <input type="number" className="input" value={priority} onChange={(e) => setPriority(e.target.value)} title="Lower runs first" />
              </div>
            </div>

            {/* Same control as the rule list, so enabling a rule looks and
                works the same whether you do it here or from the list. */}
            <div className="flex items-center gap-2">
              <span className="label mb-0">Rule status</span>
              <RuleToggle
                enabled={status === 'active'}
                onChange={() => setStatus(status === 'active' ? 'inactive' : 'active')}
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="label mb-0">
                  IF — match{' '}
                  <Select
                    size="xs" className="w-auto inline-flex align-middle" value={logic} onChange={setLogic}
                    options={[{ value: 'AND', label: 'ALL (AND)' }, { value: 'OR', label: 'ANY (OR)' }]}
                  />
                  {' '}of the following
                </div>
              </div>
              <div className="space-y-2">
                {conditions.map((c, i) => (
                  <ConditionRow
                    key={i}
                    condition={c}
                    catalog={catalog}
                    fieldOptionsMap={fieldOptionsMap}
                    onChange={(next) => setCondition(i, next)}
                    onRemove={() => setConditions(conditions.filter((_, idx) => idx !== i))}
                  />
                ))}
                {conditions.length === 0 && <p className="text-xs text-slate-400">No conditions — this rule always applies.</p>}
                <button
                  type="button"
                  onClick={() => setConditions([...conditions, { field: catalog[0]?.key || '', operator: 'equals', value: '' }])}
                  className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline flex items-center gap-0.5"
                >
                  <Plus size={13} /> Add condition
                </button>
              </div>
            </div>

            <div>
              <div className="label mb-1.5">THEN — do the following</div>
              <div className="space-y-2">
                {actions.map((a, i) => (
                  <ActionRow
                    key={i}
                    action={a}
                    catalog={catalog}
                    fieldOptionsMap={fieldOptionsMap}
                    onChange={(next) => setAction(i, next)}
                    onRemove={() => setActions(actions.filter((_, idx) => idx !== i))}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => setActions([...actions, emptyAction()])}
                  className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline flex items-center gap-0.5"
                >
                  <Plus size={13} /> Add action
                </button>
              </div>
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="button" disabled={saving || !type} onClick={save} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save rule
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Enable / disable a rule without deleting it. This used to be the
// Active/Inactive badge itself, which read as a status label rather than a
// control -- nobody could tell it was clickable. A switch says "you can
// change this", and the word next to it says which way it currently is.
function RuleToggle({ enabled, onChange, labels = ['Enabled', 'Disabled'] }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={onChange}
      title={enabled ? 'Disable this rule' : 'Enable this rule'}
      className="flex items-center gap-2 shrink-0 px-1.5 py-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
    >
      <span className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        enabled ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'
      }`}>
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`} />
      </span>
      <span className={`text-xs font-medium ${enabled ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400'}`}>
        {enabled ? labels[0] : labels[1]}
      </span>
    </button>
  );
}

// One ticket type's own Business Rules manager — a list of named rules,
// sorted by priority, each summarizing its own IF/THEN in plain language.
function TypeRuleManager({ type, onBack }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalRule, setModalRule] = useState(undefined); // undefined = closed, null = create, object = edit
  const catalog = useTypeCatalog(type);
  const meta = TYPE_META[type];

  const load = async () => {
    setLoading(true);
    try {
      const { rules } = await api.get(`/business-rules?ticket_type=${type}`);
      setRules(rules);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [type]);

  const labelFor = (key) => catalog.find((f) => f.key === key)?.label || FIELD_META[key]?.label || key;
  const describeConditions = (conditions) => {
    if (!conditions?.rules?.length) return 'always';
    return conditions.rules
      .map((c) => `${labelFor(c.field)} ${OPERATORS.find((o) => o.value === c.operator)?.label || c.operator}${['is_empty', 'is_not_empty'].includes(c.operator) ? '' : ` "${c.value}"`}`)
      .join(conditions.logic === 'OR' ? ' OR ' : ' AND ');
  };
  const describeActions = (actions) => (actions || [])
    .map((a) => a.type === 'block'
      ? `Block save — "${a.message}"`
      : `${ACTION_TYPES.find((t) => t.value === a.type)?.label || a.type} → ${labelFor(a.field)}`)
    .join('; ');

  const toggleStatus = async (rule) => {
    await api.patch(`/business-rules/${rule.id}`, { status: rule.status === 'active' ? 'inactive' : 'active' });
    load();
  };
  const remove = async (rule) => {
    if (!confirm(`Delete rule "${rule.name}"?`)) return;
    await api.del(`/business-rules/${rule.id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1">
        <ArrowLeft size={13} /> All business rule managers
      </button>

      <PageHeader
        title={`${meta.label} business rules`}
        description={`Named IF/THEN rules, evaluated in priority order (lower runs first). Targets built-in fields and anything Field Manager created for ${meta.label.toLowerCase()} tickets.`}
        actions={<button onClick={() => setModalRule(null)} className="btn-primary"><Plus size={14} /> Create rule</button>}
      />

      {loading ? (
        <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>
      ) : rules.length === 0 ? (
        <EmptyState title="No business rules yet" description={`Create a rule to show, hide, mandate, or auto-populate fields on ${meta.label.toLowerCase()} tickets.`} />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {rules.map((rule) => (
            <div key={rule.id} className="flex items-start gap-3 px-4 py-3">
              {/* A disabled rule stays listed but reads as switched off, so
                  "why isn't this firing?" is answerable at a glance. */}
              <div className={`flex-1 min-w-0 ${rule.status === 'active' ? '' : 'opacity-55'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{rule.name}</span>
                  <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">priority {rule.priority}</span>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">IF {describeConditions(rule.conditions)}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">THEN {describeActions(rule.actions)}</div>
              </div>
              <RuleToggle
                enabled={rule.status === 'active'}
                onChange={() => toggleStatus(rule)}
              />
              <button type="button" onClick={() => setModalRule(rule)} className="text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" title="Edit rule">
                <Pencil size={14} />
              </button>
              <button type="button" onClick={() => remove(rule)} className="text-slate-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" title="Delete rule">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {modalRule !== undefined && (
        <RuleBuilderModal
          initialType={type}
          rule={modalRule}
          onClose={() => setModalRule(undefined)}
          onSaved={() => { setModalRule(undefined); load(); }}
        />
      )}
    </div>
  );
}

// Hub of separate, per-type Business Rules managers, plus a top-level
// "Create rule" that asks which ticket type first before revealing fields.
function BusinessRulesHub() {
  const [activeType, setActiveType] = useState(null);
  const [allRules, setAllRules] = useState([]);
  const [loadingCounts, setLoadingCounts] = useState(true);
  const [creating, setCreating] = useState(false);

  const loadCounts = () => {
    setLoadingCounts(true);
    api.get('/business-rules').then(({ rules }) => setAllRules(rules)).finally(() => setLoadingCounts(false));
  };

  useEffect(() => {
    if (activeType) return;
    loadCounts();
  }, [activeType]);

  if (activeType) {
    return <TypeRuleManager type={activeType} onBack={() => setActiveType(null)} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Business Rules"
        description="Named IF/THEN rules — show, hide, mandate, restrict dropdown options, or auto-populate a field based on any combination of AND/OR conditions."
        actions={<button onClick={() => setCreating(true)} className="btn-primary"><Plus size={14} /> Create rule</button>}
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {TICKET_TYPES.map((type) => {
          const meta = TYPE_META[type];
          const Icon = meta.icon;
          const count = allRules.filter((r) => r.ticket_type === type).length;
          return (
            <button key={type} onClick={() => setActiveType(type)} className="card p-4 flex items-start gap-3 text-left hover:shadow-card-hover dark:hover:shadow-card-hover-dark transition-shadow group">
              <div className={`icon-tile w-11 h-11 rounded-xl bg-gradient-to-b ${meta.tile} text-white shrink-0`}>
                <Icon size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="font-medium text-slate-800 dark:text-slate-100">{meta.label} business rules</div>
                  {!loadingCounts && (
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{count} rule{count === 1 ? '' : 's'}</span>
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{builtinCatalog(type).map((f) => f.label).join(', ')}</p>
              </div>
              <ChevronRight size={16} className="text-slate-300 dark:text-slate-600 shrink-0 mt-1 group-hover:translate-x-0.5 transition-transform" />
            </button>
          );
        })}
      </div>

      {creating && (
        <RuleBuilderModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); loadCounts(); }} />
      )}
    </div>
  );
}

// ============================== Lifecycles ==============================
// A per-type state machine: named stages in order, and the transitions
// allowed between them. Enforced server-side (server/src/services/
// lifecycleEngine.js) -- a type with nothing configured here keeps the
// plain status field exactly as it worked before this existed.

const BUCKETS = ['open', 'in_progress', 'on_hold', 'resolved', 'closed'];
const BUCKET_STYLES = {
  open: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400',
  in_progress: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  on_hold: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  resolved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  closed: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};
const CONDITION_OPERATORS = [
  { value: '', label: 'No gate — always allowed' },
  { value: 'equals', label: 'field equals' },
  { value: 'not_equals', label: 'field does not equal' },
  { value: 'is_empty', label: 'field is empty' },
  { value: 'is_not_empty', label: 'field is not empty' },
];
const ROLE_OPTIONS = [
  { value: '', label: 'Any agent or admin' },
  { value: 'agent', label: 'Agent or admin' },
  { value: 'admin', label: 'Admin only' },
];
const LIFECYCLE_PREVIEW = {
  incident: 'Open → In Progress → Resolved → Closed (recommended)',
  request: 'Open → In Progress → Fulfilled → Closed (recommended)',
  problem: 'Detected → Investigating → Known Error → Fix Scheduled → Resolved → Closed (recommended)',
  change: 'Draft → Risk Assessment → CAB Review → Scheduled → Implementation → Post-Implementation Review → Closed (recommended)',
};

function StageModal({ stage, lifecycleId, onClose, onSaved }) {
  const [key, setKey] = useState(stage?.key || '');
  const [label, setLabel] = useState(stage?.label || '');
  const [bucket, setBucket] = useState(stage?.bucket || 'open');
  const [isTerminal, setIsTerminal] = useState(stage ? !!stage.is_terminal : false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    if (!label.trim()) { setError('Label is required.'); return; }
    if (!stage && !key.trim()) { setError('Key is required.'); return; }
    setSaving(true);
    try {
      if (stage) {
        await api.patch(`/lifecycles/stages/${stage.id}`, { label: label.trim(), bucket, is_terminal: isTerminal });
      } else {
        await api.post(`/lifecycles/${lifecycleId}/stages`, { key: key.trim(), label: label.trim(), bucket, is_terminal: isTerminal });
      }
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={stage ? `Edit stage — ${stage.label}` : 'Add stage'} onClose={onClose}>
      <div className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        {!stage && (
          <div>
            <label className="label">Key (stable identifier — cannot change later)</label>
            <input className="input" value={key} onChange={(e) => setKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))} placeholder="e.g. cab_review" />
          </div>
        )}
        <div>
          <label className="label">Label</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. CAB Review" />
        </div>
        <div>
          <label className="label">Status bucket</label>
          <Select value={bucket} onChange={setBucket} options={BUCKETS.map((b) => ({ value: b, label: b.replace('_', ' ') }))} />
          <p className="text-xs text-slate-400 mt-1">Drives SLA tracking and every report/dashboard filter — pick whichever existing status this stage should count as.</p>
        </div>
        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={isTerminal} onChange={(e) => setIsTerminal(e.target.checked)} /> Terminal stage
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="button" disabled={saving} onClick={save} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TransitionModal({ transition, stages, lifecycleId, type, onClose, onSaved }) {
  const [fromId, setFromId] = useState(transition?.from_stage_id || stages[0]?.id || '');
  const [toId, setToId] = useState(transition?.to_stage_id || '');
  const [requiresRole, setRequiresRole] = useState(transition?.requires_role || '');
  const [conditionOperator, setConditionOperator] = useState(transition?.condition_operator || '');
  const [conditionField, setConditionField] = useState(transition?.condition_field || '');
  const [conditionValue, setConditionValue] = useState(transition?.condition_value || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const catalog = builtinCatalog(type);
  const needsValue = conditionOperator === 'equals' || conditionOperator === 'not_equals';

  const save = async () => {
    setError('');
    if (!fromId || !toId) { setError('Choose both stages.'); return; }
    if (fromId === toId) { setError('From and to must be different stages.'); return; }
    if (conditionOperator && !conditionField) { setError('Choose a field for the gate condition.'); return; }
    setSaving(true);
    try {
      const payload = {
        from_stage_id: fromId, to_stage_id: toId,
        requires_role: requiresRole || null,
        condition_field: conditionOperator ? conditionField : null,
        condition_operator: conditionOperator || null,
        condition_value: needsValue ? conditionValue : null,
      };
      if (transition) await api.patch(`/lifecycles/transitions/${transition.id}`, payload);
      else await api.post(`/lifecycles/${lifecycleId}/transitions`, payload);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={transition ? 'Edit transition' : 'Add transition'} onClose={onClose}>
      <div className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="label">From stage</label>
            <Select disabled={!!transition} value={fromId} onChange={setFromId} options={stages.map((s) => ({ value: s.id, label: s.label }))} />
          </div>
          <div>
            <label className="label">To stage</label>
            <Select
              disabled={!!transition} placeholder="Choose…" value={toId} onChange={setToId}
              options={stages.filter((s) => s.id !== fromId).map((s) => ({ value: s.id, label: s.label }))}
            />
          </div>
        </div>
        <div>
          <label className="label">Who can perform this transition</label>
          <Select value={requiresRole} onChange={setRequiresRole} options={ROLE_OPTIONS} />
        </div>
        <div>
          <label className="label">Gate condition (optional)</label>
          <div className="flex items-center gap-2 flex-wrap">
            <Select className="w-auto" value={conditionOperator} onChange={setConditionOperator} options={CONDITION_OPERATORS} />
            {conditionOperator && (
              <Select
                className="w-auto" placeholder="Choose a field…" value={conditionField} onChange={setConditionField}
                options={catalog.map((f) => ({ value: f.key, label: f.label }))}
              />
            )}
            {needsValue && (
              <input className="input w-auto" placeholder="value" value={conditionValue} onChange={(e) => setConditionValue(e.target.value)} />
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">e.g. "CAB Status equals approved" blocks this move until CAB has signed off.</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="button" disabled={saving} onClick={save} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TypeLifecycleDesigner({ type, onBack }) {
  const [lifecycle, setLifecycle] = useState(undefined); // undefined = loading, null = not configured
  const [stageModal, setStageModal] = useState(undefined); // undefined = closed, null = add, object = edit
  const [transitionModal, setTransitionModal] = useState(undefined);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const meta = TYPE_META[type];

  const load = async () => {
    try {
      const { lifecycle } = await api.get(`/lifecycles/${type}/detail`);
      setLifecycle(lifecycle);
    } catch (e) {
      setLoadError(e.message);
    }
  };
  useEffect(() => { load(); }, [type]);

  const start = async (useTemplate) => {
    setBusy(true);
    try {
      await api.post('/lifecycles', { ticket_type: type, use_template: useTemplate });
      load();
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async () => {
    await api.patch(`/lifecycles/${lifecycle.id}`, { enabled: lifecycle.enabled ? 0 : 1 });
    load();
  };

  const resetTemplate = async () => {
    if (!confirm('Replace all current stages and transitions with the recommended template? This cannot be undone.')) return;
    await api.post(`/lifecycles/${lifecycle.id}/reset-template`);
    load();
  };

  const removeLifecycle = async () => {
    if (!confirm(`Delete the ${meta.label.toLowerCase()} lifecycle? Tickets of this type go back to the plain status field.`)) return;
    await api.del(`/lifecycles/${lifecycle.id}`);
    load();
  };

  const moveStage = async (stage, dir) => {
    const idx = lifecycle.stages.findIndex((s) => s.id === stage.id);
    const swapWith = lifecycle.stages[idx + dir];
    if (!swapWith) return;
    await Promise.all([
      api.patch(`/lifecycles/stages/${stage.id}`, { sort_order: swapWith.sort_order }),
      api.patch(`/lifecycles/stages/${swapWith.id}`, { sort_order: stage.sort_order }),
    ]);
    load();
  };

  const removeStage = async (stage) => {
    if (!confirm(`Delete stage "${stage.label}"? Any transitions touching it are removed too.`)) return;
    try {
      await api.del(`/lifecycles/stages/${stage.id}`);
      load();
    } catch (e) {
      alert(e.message);
    }
  };

  const removeTransition = async (t) => {
    await api.del(`/lifecycles/transitions/${t.id}`);
    load();
  };

  const stageLabel = (id) => lifecycle?.stages.find((s) => s.id === id)?.label || '—';

  if (lifecycle === undefined && loadError) return <LoadErrorState error={loadError} onRetry={load} />;
  if (lifecycle === undefined) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1">
        <ArrowLeft size={13} /> All lifecycle managers
      </button>

      <PageHeader
        title={`${meta.label} lifecycle`}
        description={lifecycle ? `Stages a ${meta.label.toLowerCase()} ticket moves through, in order, with any approval gates enforced server-side.` : `No lifecycle configured yet — ${meta.label.toLowerCase()} tickets use the plain status field.`}
        actions={lifecycle ? (
          <>
            <button onClick={toggleEnabled} className="btn-secondary">
              {lifecycle.enabled ? <ToggleRight size={14} className="text-emerald-500" /> : <ToggleLeft size={14} />} {lifecycle.enabled ? 'Enabled' : 'Disabled'}
            </button>
            <button onClick={resetTemplate} className="btn-secondary"><RefreshCw size={14} /> Reset to template</button>
            <button onClick={removeLifecycle} className="btn-danger"><Trash2 size={14} /> Delete</button>
          </>
        ) : null}
      />

      {!lifecycle ? (
        <div className="card p-8 text-center space-y-3">
          <Milestone size={28} className="mx-auto text-slate-300 dark:text-slate-600" />
          <p className="text-sm text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            Define named stages and the transitions allowed between them for {meta.label.toLowerCase()} tickets — moving a ticket outside those transitions is rejected server-side, not just hidden in the UI.
          </p>
          <p className="text-xs text-slate-400 max-w-md mx-auto font-mono">{LIFECYCLE_PREVIEW[type]}</p>
          <div className="flex items-center justify-center gap-2 pt-1">
            <button onClick={() => start(true)} disabled={busy} className="btn-primary">
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Start from recommended template
            </button>
            <button onClick={() => start(false)} disabled={busy} className="btn-secondary">Start blank</button>
          </div>
        </div>
      ) : (
        <>
          {!lifecycle.enabled && (
            <div className="card p-3 bg-amber-50/70 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/20 text-sm text-amber-800 dark:text-amber-300">
              Disabled — {meta.label.toLowerCase()} tickets currently use the plain status field, not these stages.
            </div>
          )}

          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Stages ({lifecycle.stages.length})</h3>
              <button onClick={() => setStageModal(null)} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline flex items-center gap-0.5">
                <Plus size={13} /> Add stage
              </button>
            </div>
            <div className="space-y-1.5">
              {lifecycle.stages.map((s, i) => (
                <div key={s.id} className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
                  <span className="font-mono text-xs text-slate-400 w-4 shrink-0">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5 flex-wrap">
                      {s.label}
                      <span className={`badge ${BUCKET_STYLES[s.bucket]}`}>{s.bucket.replace('_', ' ')}</span>
                      {!!s.is_terminal && <span className="badge bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300">terminal</span>}
                    </div>
                    <div className="text-xs text-slate-400 font-mono">{s.key}</div>
                  </div>
                  <button onClick={() => moveStage(s, -1)} disabled={i === 0} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 shrink-0"><ArrowUp size={14} /></button>
                  <button onClick={() => moveStage(s, 1)} disabled={i === lifecycle.stages.length - 1} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30 shrink-0"><ArrowDown size={14} /></button>
                  <button onClick={() => setStageModal(s)} className="text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 shrink-0"><Pencil size={14} /></button>
                  <button onClick={() => removeStage(s)} className="text-slate-400 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
                </div>
              ))}
              {lifecycle.stages.length === 0 && <p className="text-xs text-slate-400 text-center py-4">No stages yet.</p>}
            </div>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Transitions ({lifecycle.transitions.length})</h3>
              <button onClick={() => setTransitionModal(null)} disabled={lifecycle.stages.length < 2} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline flex items-center gap-0.5 disabled:opacity-40">
                <Plus size={13} /> Add transition
              </button>
            </div>
            <div className="space-y-1.5">
              {lifecycle.transitions.map((t) => (
                <div key={t.id} className="flex items-center gap-2 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2 flex-wrap">
                  <div className="flex-1 min-w-0 text-sm text-slate-700 dark:text-slate-200 flex items-center gap-1.5 flex-wrap">
                    <span className="font-medium">{stageLabel(t.from_stage_id)}</span>
                    <ChevronRight size={13} className="text-slate-400 shrink-0" />
                    <span className="font-medium">{stageLabel(t.to_stage_id)}</span>
                    {t.requires_role && <span className="badge bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400">{t.requires_role} only</span>}
                    {t.condition_field && (
                      <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
                        gated: {FIELD_META[t.condition_field]?.label || t.condition_field} {t.condition_operator?.replace('_', ' ')} {['equals', 'not_equals'].includes(t.condition_operator) ? `"${t.condition_value}"` : ''}
                      </span>
                    )}
                  </div>
                  <button onClick={() => setTransitionModal(t)} className="text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 shrink-0"><Pencil size={14} /></button>
                  <button onClick={() => removeTransition(t)} className="text-slate-400 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
                </div>
              ))}
              {lifecycle.transitions.length === 0 && <p className="text-xs text-slate-400 text-center py-4">No transitions yet — tickets can't move between stages until you add some.</p>}
            </div>
          </div>
        </>
      )}

      {stageModal !== undefined && (
        <StageModal stage={stageModal} lifecycleId={lifecycle.id} onClose={() => setStageModal(undefined)} onSaved={() => { setStageModal(undefined); load(); }} />
      )}
      {transitionModal !== undefined && (
        <TransitionModal transition={transitionModal} stages={lifecycle.stages} lifecycleId={lifecycle.id} type={type} onClose={() => setTransitionModal(undefined)} onSaved={() => { setTransitionModal(undefined); load(); }} />
      )}
    </div>
  );
}

function LifecycleHub() {
  const [activeType, setActiveType] = useState(null);
  const [summaries, setSummaries] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (activeType) return;
    setLoading(true);
    api.get('/lifecycles').then(({ lifecycles }) => setSummaries(lifecycles)).finally(() => setLoading(false));
  }, [activeType]);

  if (activeType) {
    return <TypeLifecycleDesigner type={activeType} onBack={() => setActiveType(null)} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Lifecycles"
        description="Define the stages a ticket moves through per type, with role-restricted and condition-gated transitions enforced server-side. A type with nothing configured keeps the plain status field."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {TICKET_TYPES.map((type) => {
          const meta = TYPE_META[type];
          const Icon = meta.icon;
          const summary = summaries.find((s) => s.ticket_type === type);
          return (
            <button key={type} onClick={() => setActiveType(type)} className="card p-4 flex items-start gap-3 text-left hover:shadow-card-hover dark:hover:shadow-card-hover-dark transition-shadow group">
              <div className={`icon-tile w-11 h-11 rounded-xl bg-gradient-to-b ${meta.tile} text-white shrink-0`}>
                <Icon size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="font-medium text-slate-800 dark:text-slate-100">{meta.label} lifecycle</div>
                  {!loading && summary && (
                    summary.id ? (
                      <span className={`badge ${summary.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}>
                        {summary.stageCount} stage{summary.stageCount === 1 ? '' : 's'} · {summary.enabled ? 'enabled' : 'disabled'}
                      </span>
                    ) : (
                      <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">not configured</span>
                    )
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{LIFECYCLE_PREVIEW[type]}</p>
              </div>
              <ChevronRight size={16} className="text-slate-300 dark:text-slate-600 shrink-0 mt-1 group-hover:translate-x-0.5 transition-transform" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function HubCard({ section, count, accent, onClick }) {
  const Icon = section.icon;
  return (
    <RevealItem
      as={motion.button}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      className="card p-4 flex items-start gap-3 text-left hover:shadow-card-hover dark:hover:shadow-card-hover-dark transition-shadow group"
    >
      <div className={`icon-tile w-11 h-11 rounded-xl bg-gradient-to-b ${accent || 'from-brand-400 to-brand-600'} text-white shrink-0`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="font-medium text-slate-800 dark:text-slate-100">{section.label}</div>
          {count !== undefined && (
            <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{count}</span>
          )}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{section.description}</p>
      </div>
      <ChevronRight size={16} className="text-slate-300 dark:text-slate-600 shrink-0 mt-1 group-hover:translate-x-0.5 transition-transform" />
    </RevealItem>
  );
}

export default function AdminSettings() {
  const location = useLocation();
  const { user } = useAuth();
  // The Workflow builder is a full top-level route (/automations/:id); its
  // Back button returns here with { state: { section: 'workflows' } } so
  // the admin lands back on the same tab instead of the hub home. A plain
  // `?section=` query param is the same idea for a hard server redirect
  // (the Microsoft mailbox-connect OAuth callback, routes/emailSettings.js)
  // -- location.state doesn't survive a real HTTP redirect the way client
  // -side navigate() state does, so that flow has to use the URL instead.
  const [section, setSection] = useState(() => location.state?.section ?? new URLSearchParams(location.search).get('section') ?? null);
  const [counts, setCounts] = useState({});
  const visibleSections = SECTIONS.filter((s) => canSeeSection(user, s));

  // A delegated agent landing here directly (e.g. a stale back-navigation
  // state) should never see a tab their custom role wasn't granted.
  useEffect(() => {
    if (section && !visibleSections.some((s) => s.key === section)) setSection(null);
  }, [section]);

  useEffect(() => {
    Promise.all([
      api.get('/auth/users/all').catch(() => ({ users: [] })),
      api.get('/groups').catch(() => ({ groups: [] })),
      api.get('/workspaces').catch(() => ({ workspaces: [] })),
      api.get('/automations').catch(() => ({ automations: [] })),
    ]).then(([u, g, w, a]) => {
      setCounts({
        users: u.users.length,
        groups: g.groups.length,
        workspaces: w.workspaces.length,
        workflows: a.automations.length,
      });
    });
  }, [section === null]);

  const active = SECTIONS.find((s) => s.key === section);
  const activeGroup = SECTION_GROUPS.find((g) => g.sectionKeys.includes(section));

  return (
    <div className="space-y-4">
      {section === null ? (
        <>
          <PageHeader title="Admin Settings" description="Users, groups, workspaces, workflows and business rules" />
          <div className="space-y-7">
            {SECTION_GROUPS.map((group) => {
              const items = group.sectionKeys
                .map((key) => visibleSections.find((s) => s.key === key))
                .filter(Boolean);
              // A delegated agent with no permission for anything in this
              // category never sees an empty, pointless section header for it.
              if (!items.length) return null;
              const GroupIcon = group.icon;
              return (
                <div key={group.key}>
                  <div className="flex items-center gap-2.5 mb-3">
                    <div className={`w-7 h-7 rounded-lg bg-gradient-to-b ${group.accent} text-white flex items-center justify-center shrink-0 shadow-sm`}>
                      <GroupIcon size={13} />
                    </div>
                    <h2 className="text-sm font-display font-semibold text-slate-700 dark:text-slate-200">{group.label}</h2>
                    <span className="text-xs text-slate-400 dark:text-slate-500 font-mono">{items.length}</span>
                    <span className="text-xs text-slate-400 dark:text-slate-500 hidden sm:inline truncate">— {group.description}</span>
                    <div className="flex-1 border-t border-slate-200/70 dark:border-white/[0.06]" />
                  </div>
                  <RevealGroup className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {items.map((s) => (
                      <HubCard key={s.key} section={s} count={counts[s.key]} accent={group.accent} onClick={() => setSection(s.key)} />
                    ))}
                  </RevealGroup>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSection(null)}
              className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg p-1.5 transition-colors"
              title="Back to Admin Settings"
            >
              <ArrowLeft size={18} />
            </button>
            {section !== 'workflows' && section !== 'fieldManager' && section !== 'businessRules' && section !== 'lifecycles' && (
              <div>
                <div className="text-xs text-slate-400 flex items-center gap-1">
                  <button onClick={() => setSection(null)} className="hover:text-slate-600 dark:hover:text-slate-300 hover:underline">Admin Settings</button>
                  {activeGroup && <><ChevronRight size={11} /> {activeGroup.label}</>}
                </div>
                <h1 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100">{active?.label}</h1>
              </div>
            )}
          </div>

          {section === 'users' && <UsersTab />}
          {section === 'groups' && <GroupsTab />}
          {section === 'workspaces' && <WorkspacesTab />}
          {section === 'workflows' && <Automations />}
          {section === 'emailConfig' && <EmailConfigTab />}
          {section === 'fieldManager' && <TicketFieldManagerTab />}
          {section === 'changeConfig' && <ChangeConfigTab />}
          {section === 'cmdbConfig' && <CmdbConfigTab />}
          {section === 'businessRules' && <BusinessRulesHub />}
          {section === 'lifecycles' && <LifecycleHub />}
          {section === 'hrCaseTemplates' && <HrCaseTemplatesTab />}
          {section === 'ticketNumbering' && <TicketNumberingTab />}
          {section === 'roles' && <RolesTab />}
          {section === 'auditLog' && <AuditLogTab />}
          {section === 'sso' && <SsoTab />}
          {section === 'directory' && <DirectorySyncTab />}
          {section === 'apiKeys' && <ApiKeysTab />}
          {section === 'backups' && <BackupTab />}
          {section === 'errorMonitoring' && <ErrorMonitoringTab />}
          {section === 'alertManagement' && <AlertManagementTab />}
          {section === 'onCallSchedules' && <OnCallScheduleTab />}
          {section === 'assignmentPolicies' && <AssignmentPolicyTab />}
        </>
      )}
    </div>
  );
}
