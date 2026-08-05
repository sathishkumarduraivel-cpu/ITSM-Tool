import { useEffect, useState } from 'react';
import {
  Loader2, Save, UserPlus, Building2, Users, ListChecks, UsersRound, Layers,
  Workflow, ArrowLeft, ChevronRight, Plus, Trash2, ChevronDown, ChevronUp, X,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Automations from './Automations.jsx';

const SECTIONS = [
  { key: 'profile', label: 'Company Profile', description: 'Organization name, support email, timezone & default priority', icon: Building2 },
  { key: 'users', label: 'Users', description: 'Manage agent & requester accounts, roles and status', icon: Users },
  { key: 'groups', label: 'Groups', description: 'Organize agents into teams, e.g. Network, Facilities, Service Desk', icon: UsersRound },
  { key: 'workspaces', label: 'Workspaces', description: 'Add, rename or remove shared workspace labels', icon: Layers },
  { key: 'workflows', label: 'Workflows & Automation', description: 'Trigger → conditions → actions, including built-in AI steps', icon: Workflow },
  { key: 'fields', label: 'Business Rules', description: 'Control which ticket fields show, and which are required', icon: ListChecks },
];

function CompanyProfileTab() {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.get('/admin/settings').then(({ settings }) => setForm(settings));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    try {
      await api.patch('/admin/settings', form);
      setSaved(true);
    } finally {
      setSaving(false);
    }
  };

  if (!form) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  return (
    <form onSubmit={submit} className="card p-5 space-y-4 max-w-lg">
      <div>
        <label className="label">Company / workspace name</label>
        <input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
      </div>
      <div>
        <label className="label">Support email</label>
        <input className="input" type="email" value={form.support_email || ''} onChange={(e) => setForm({ ...form, support_email: e.target.value })} placeholder="support@yourcompany.com" />
      </div>
      <div>
        <label className="label">Timezone</label>
        <input className="input" value={form.timezone || ''} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="e.g. Asia/Kolkata" />
      </div>
      <div>
        <label className="label">Default ticket priority</label>
        <select className="input" value={form.default_priority || 'medium'} onChange={(e) => setForm({ ...form, default_priority: e.target.value })}>
          {['low', 'medium', 'high', 'critical'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-3 pt-2">
        <button type="submit" disabled={saving} className="btn-primary">
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
        </button>
        {saved && <span className="text-sm text-emerald-600">Saved.</span>}
      </div>
    </form>
  );
}

function AddUserModal({ onClose, onSaved }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('agent');
  const [team, setTeam] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/auth/users', { email, name, password, role, team: team || null });
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
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Role</label>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="requester">Requester</option>
              <option value="agent">Agent</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div>
            <label className="label">Team (optional)</label>
            <input className="input" value={team} onChange={(e) => setTeam(e.target.value)} />
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

function UsersTab() {
  const { user } = useAuth();
  const [users, setUsers] = useState(null);
  const [groups, setGroups] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [expanded, setExpanded] = useState(null);

  const load = async () => {
    const [usersRes, groupsRes] = await Promise.all([api.get('/auth/users/all'), api.get('/groups')]);
    setUsers(usersRes.users);
    setGroups(groupsRes.groups);
  };

  useEffect(() => { load(); }, []);

  const updateRole = async (userId, roleValue) => {
    await api.patch(`/auth/users/${userId}`, { role: roleValue });
    load();
  };

  const toggleActive = async (u) => {
    await api.patch(`/auth/users/${u.id}`, { active: !u.active });
    load();
  };

  const groupsFor = (userId) => groups.filter((g) => g.members.some((m) => m.id === userId));

  if (!users) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => setShowAdd(true)} className="btn-primary"><UserPlus size={14} /> Add user</button>
      </div>

      {users.length === 0 ? (
        <EmptyState icon={Users} title="No users yet" />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {users.map((u) => {
            const isOpen = expanded === u.id;
            const memberOf = groupsFor(u.id);
            return (
              <div key={u.id}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <div
                    className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                    style={{ backgroundColor: u.avatar_color || '#6366f1' }}
                  >
                    {u.name?.[0]?.toUpperCase() || '?'}
                  </div>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setExpanded(isOpen ? null : u.id)}>
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{u.name}</div>
                    <div className="text-xs text-slate-500 truncate">{u.email}{u.team ? ` · ${u.team}` : ''}</div>
                  </button>
                  <select
                    className="input w-auto py-1 text-xs"
                    value={u.role}
                    onChange={(e) => updateRole(u.id, e.target.value)}
                    disabled={u.id === user.id}
                  >
                    <option value="requester">Requester</option>
                    <option value="agent">Agent</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button
                    onClick={() => toggleActive(u)}
                    disabled={u.id === user.id}
                    className={`text-xs px-2 py-1 rounded-md ${u.active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}
                  >
                    {u.active ? 'Active' : 'Deactivated'}
                  </button>
                  <button onClick={() => setExpanded(isOpen ? null : u.id)} className="text-slate-400 hover:text-slate-600">
                    {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                  </button>
                </div>
                {isOpen && (
                  <div className="px-4 pb-4 pt-0.5 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                    <div><span className="text-slate-400">Email:</span> <span className="text-slate-700 dark:text-slate-200">{u.email}</span></div>
                    <div><span className="text-slate-400">Team:</span> <span className="text-slate-700 dark:text-slate-200">{u.team || '—'}</span></div>
                    <div><span className="text-slate-400">Joined:</span> <span className="text-slate-700 dark:text-slate-200">{u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}</span></div>
                    <div><span className="text-slate-400">Status:</span> <span className="text-slate-700 dark:text-slate-200">{u.active ? 'Active' : 'Deactivated'}</span></div>
                    <div className="col-span-2">
                      <span className="text-slate-400">Groups:</span>{' '}
                      {memberOf.length ? memberOf.map((g) => (
                        <span key={g.id} className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 mr-1">{g.name}</span>
                      )) : <span className="text-slate-400">none</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAdd && (
        <AddUserModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />
      )}
    </div>
  );
}

function GroupModal({ initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (initial?.id) await api.patch(`/groups/${initial.id}`, { name, description });
      else await api.post('/groups', { name, description });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Rename group' : 'New group'} onClose={onClose}>
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
  const [modal, setModal] = useState(null); // null | 'new' | group
  const [expanded, setExpanded] = useState(null);
  const [addingTo, setAddingTo] = useState(null);
  const [pickUserId, setPickUserId] = useState('');

  const load = async () => {
    const [groupsRes, usersRes] = await Promise.all([api.get('/groups'), api.get('/auth/users/all')]);
    setGroups(groupsRes.groups);
    setUsers(usersRes.users.filter((x) => x.active));
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
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {g.members.length} member{g.members.length === 1 ? '' : 's'}
                    </span>
                    <button onClick={() => setModal(g)} className="btn-ghost text-xs">Rename</button>
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
                        <select className="input w-auto flex-1" value={pickUserId} onChange={(e) => setPickUserId(e.target.value)}>
                          <option value="">Select user…</option>
                          {available.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                        </select>
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
        <GroupModal initial={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
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
  const [modal, setModal] = useState(null);

  const load = async () => {
    const { workspaces } = await api.get('/workspaces');
    setWorkspaces(workspaces);
  };

  useEffect(() => { load(); }, []);

  const remove = async (ws) => {
    if (workspaces.length <= 1) { alert('At least one workspace must remain.'); return; }
    if (!confirm(`Delete workspace "${ws.name}"? Tickets/users already labeled with it keep that label.`)) return;
    await api.del(`/workspaces/${ws.id}`);
    load();
  };

  if (!workspaces) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Workspaces are shared labels used to organize tickets and users — everyone can see everything regardless of which workspace is currently selected.
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
const COMMON_FIELDS = ['category', 'subcategory', 'team', 'impact', 'risk', 'planned_start', 'planned_end', 'rollback_plan'];

function FieldRulesTab() {
  const [ticketType, setTicketType] = useState('change');
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    const { rules } = await api.get(`/field-rules?ticket_type=${ticketType}`);
    setRules(rules);
    setLoading(false);
  };

  useEffect(() => { load(); }, [ticketType]);

  const ruleFor = (field) => rules.find((r) => r.field_name === field && !r.category);

  const setRule = async (field, patch) => {
    const existing = ruleFor(field);
    if (existing) {
      await api.patch(`/field-rules/${existing.id}`, patch);
    } else {
      await api.post('/field-rules', { ticket_type: ticketType, field_name: field, visible: true, required: false, ...patch });
    }
    load();
  };

  return (
    <div className="space-y-4">
      <div className="max-w-xs">
        <label className="label">Ticket type</label>
        <select className="input" value={ticketType} onChange={(e) => setTicketType(e.target.value)}>
          {TICKET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <p className="text-sm text-slate-500 dark:text-slate-400">
        Business rules that control which fields show on the {ticketType} form, and which are mandatory before submission. Fields with no rule configured stay visible (existing default behavior).
      </p>

      {loading ? (
        <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {COMMON_FIELDS.map((field) => {
            const rule = ruleFor(field);
            const visible = rule ? !!rule.visible : true;
            const required = rule ? !!rule.required : false;
            return (
              <div key={field} className="flex items-center gap-4 px-4 py-3">
                <div className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-200 capitalize">{field.replace('_', ' ')}</div>
                <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                  <input type="checkbox" checked={visible} onChange={(e) => setRule(field, { visible: e.target.checked })} /> Visible
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                  <input type="checkbox" checked={required} disabled={!visible} onChange={(e) => setRule(field, { required: e.target.checked })} /> Required
                </label>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HubCard({ section, count, onClick }) {
  const Icon = section.icon;
  return (
    <button
      onClick={onClick}
      className="card p-4 flex items-start gap-3 text-left hover:shadow-card-hover dark:hover:shadow-card-hover-dark transition-shadow group"
    >
      <div className="icon-tile w-11 h-11 rounded-xl bg-gradient-to-b from-brand-400 to-brand-600 text-white shrink-0">
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
    </button>
  );
}

export default function AdminSettings() {
  const [section, setSection] = useState(null); // null = hub home
  const [counts, setCounts] = useState({});

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

  return (
    <div className="space-y-4">
      {section === null ? (
        <>
          <PageHeader title="Admin Settings" description="Company profile, users, groups, workspaces, workflows and business rules" />
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {SECTIONS.map((s) => (
              <HubCard key={s.key} section={s} count={counts[s.key]} onClick={() => setSection(s.key)} />
            ))}
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
            {section !== 'workflows' && (
              <div>
                <div className="text-xs text-slate-400">Admin Settings</div>
                <h1 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100">{active?.label}</h1>
              </div>
            )}
          </div>

          {section === 'profile' && <CompanyProfileTab />}
          {section === 'users' && <UsersTab />}
          {section === 'groups' && <GroupsTab />}
          {section === 'workspaces' && <WorkspacesTab />}
          {section === 'workflows' && <Automations />}
          {section === 'fields' && <FieldRulesTab />}
        </>
      )}
    </div>
  );
}
