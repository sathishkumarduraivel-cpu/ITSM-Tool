import { useEffect, useState } from 'react';
import {
  Loader2, Save, UserPlus, Users, ListChecks, UsersRound, Layers,
  Workflow, ArrowLeft, ChevronRight, Plus, Trash2, ChevronDown, ChevronUp, X,
  AlertTriangle, Inbox, Search, GitBranch, Pencil, ShieldCheck,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Automations from './Automations.jsx';

const SECTIONS = [
  { key: 'users', label: 'Users', description: 'Manage agent & requester accounts, roles and status', icon: Users },
  { key: 'groups', label: 'Groups', description: 'Organize agents into groups, e.g. Network, Facilities, Service Desk', icon: UsersRound },
  { key: 'workspaces', label: 'Workspaces', description: 'Add, rename or remove workspaces you belong to', icon: Layers },
  { key: 'workflows', label: 'Workflows & Automation', description: 'Trigger → conditions → actions, including built-in AI steps', icon: Workflow },
  { key: 'fieldManager', label: 'Field Manager', description: 'Create custom fields — text, paragraph, dropdown, multi-select — separately for each ticket type', icon: ListChecks },
  { key: 'businessRules', label: 'Business Rules', description: 'Conditional visibility, required and validation logic per ticket type', icon: ShieldCheck },
];

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
            <label className="label">Group (optional)</label>
            <select className="input" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
              <option value="">None</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
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

  const removeUser = async (u) => {
    if (!confirm(`Remove ${u.name} from this workspace? They will lose access entirely.`)) return;
    await api.del(`/auth/users/${u.id}`);
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
                    <div className="text-xs text-slate-500 truncate">{u.email}{memberOf.length ? ` · ${memberOf.map((g) => g.name).join(', ')}` : ''}</div>
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
                  <button
                    onClick={() => removeUser(u)}
                    disabled={u.id === user.id}
                    className="text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-slate-400"
                    title="Remove from workspace"
                  >
                    <Trash2 size={15} />
                  </button>
                  <button onClick={() => setExpanded(isOpen ? null : u.id)} className="text-slate-400 hover:text-slate-600">
                    {isOpen ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                  </button>
                </div>
                {isOpen && (
                  <div className="px-4 pb-4 pt-0.5 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
                    <div><span className="text-slate-400">Email:</span> <span className="text-slate-700 dark:text-slate-200">{u.email}</span></div>
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
        <AddUserModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} groups={groups} />
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
    if (!confirm(`Delete workspace "${ws.name}"? All of its tickets, assets, groups and users lose access to this workspace.`)) return;
    try {
      await api.del(`/workspaces/${ws.id}`);
      load();
    } catch (e) {
      alert(e.message);
    }
  };

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
// The built-in fields that already exist on each ticket type's form (Change
// has Risk/Planned dates/Rollback plan on top of the common four; nothing
// else does). Field Manager's custom fields are layered on top of this list
// per type, not a replacement for it.
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
};
const TYPE_META = {
  incident: { label: 'Incident', icon: AlertTriangle, tile: 'from-red-400 to-red-600' },
  request: { label: 'Request', icon: Inbox, tile: 'from-brand-400 to-brand-600' },
  problem: { label: 'Problem', icon: Search, tile: 'from-purple-400 to-purple-600' },
  change: { label: 'Change', icon: GitBranch, tile: 'from-teal-400 to-teal-600' },
};
const builtinCatalog = (type) => TYPE_FIELD_CATALOG[type].map((key) => ({ key, label: FIELD_META[key].label }));

// ============================== Field Manager ==============================
// Creates the fields themselves (text / paragraph / dropdown / multi-select),
// separately for each ticket type. Distinct from Business Rules below, which
// only governs behavior of fields that already exist here or in the schema.

const CUSTOM_FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Paragraph' },
  { value: 'select', label: 'Dropdown' },
  { value: 'multiselect', label: 'Multi-select dropdown' },
];

function CustomFieldModal({ type, field, onClose, onSaved }) {
  const [label, setLabel] = useState(field?.label || '');
  const [fieldType, setFieldType] = useState(field?.field_type || 'text');
  const [options, setOptions] = useState(field?.options?.length ? field.options : ['']);
  const [required, setRequired] = useState(field ? !!field.required : false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isDropdown = fieldType === 'select' || fieldType === 'multiselect';

  const setOption = (i, val) => setOptions(options.map((o, idx) => (idx === i ? val : o)));
  const addOption = () => setOptions([...options, '']);
  const removeOption = (i) => setOptions(options.filter((_, idx) => idx !== i));

  const save = async () => {
    setError('');
    if (!label.trim()) { setError('Label is required.'); return; }
    const cleanOptions = options.map((o) => o.trim()).filter(Boolean);
    if (isDropdown && cleanOptions.length === 0) { setError('Add at least one option.'); return; }
    setSaving(true);
    try {
      const payload = { label: label.trim(), field_type: fieldType, options: cleanOptions, required };
      if (field) {
        await api.patch(`/custom-fields/${field.id}`, payload);
      } else {
        await api.post('/custom-fields', { ticket_type: type, ...payload });
      }
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={field ? `Edit field — ${field.label}` : `Add field — ${TYPE_META[type].label}`} onClose={onClose}>
      <div className="space-y-4">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Label</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Affected system" />
        </div>
        <div>
          <label className="label">Field type</label>
          <select className="input" value={fieldType} onChange={(e) => setFieldType(e.target.value)}>
            {CUSTOM_FIELD_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        {isDropdown && (
          <div>
            <label className="label">Options</label>
            <div className="space-y-2">
              {options.map((o, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input className="input" value={o} onChange={(e) => setOption(i, e.target.value)} placeholder={`Option ${i + 1}`} />
                  {options.length > 1 && (
                    <button type="button" onClick={() => removeOption(i)} className="text-slate-400 hover:text-red-500 p-1.5"><X size={14} /></button>
                  )}
                </div>
              ))}
              <button type="button" onClick={addOption} className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline flex items-center gap-0.5">
                <Plus size={13} /> Add option
              </button>
            </div>
          </div>
        )}
        <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} /> Always required
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="button" disabled={saving} onClick={save} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save field
          </button>
        </div>
      </div>
    </Modal>
  );
}

function TypeFieldDesigner({ type, onBack }) {
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalField, setModalField] = useState(undefined); // undefined = closed, null = add new, object = edit existing
  const [deleting, setDeleting] = useState(null);
  const meta = TYPE_META[type];

  const load = async () => {
    setLoading(true);
    const { fields } = await api.get(`/custom-fields?ticket_type=${type}`);
    setFields(fields);
    setLoading(false);
  };

  useEffect(() => { load(); }, [type]);

  const remove = async (field) => {
    if (!confirm(`Delete "${field.label}"? Any Business Rule referencing it will be removed too.`)) return;
    setDeleting(field.id);
    await api.del(`/custom-fields/${field.id}`);
    setDeleting(null);
    load();
  };

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1">
        <ArrowLeft size={13} /> All field managers
      </button>

      <PageHeader
        title={`${meta.label} field manager`}
        description={`Built-in fields (${builtinCatalog(type).map((f) => f.label).join(', ')}) always exist. Add custom fields below — they'll appear on the ${meta.label.toLowerCase()} form right away.`}
        actions={<button onClick={() => setModalField(null)} className="btn-primary"><Plus size={14} /> Add field</button>}
      />

      {loading ? (
        <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>
      ) : fields.length === 0 ? (
        <EmptyState title="No custom fields yet" description={`Add a field to collect more detail on ${meta.label.toLowerCase()} tickets.`} />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {fields.map((f) => (
            <div key={f.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5 flex-wrap">
                  {f.label}
                  <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {CUSTOM_FIELD_TYPES.find((t) => t.value === f.field_type)?.label}
                  </span>
                  {!!f.required && <span className="badge bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">Required</span>}
                </div>
                {f.options?.length > 0 && <div className="text-xs text-slate-400 mt-0.5">{f.options.join(', ')}</div>}
              </div>
              <button type="button" onClick={() => setModalField(f)} className="text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" title="Edit field">
                <Pencil size={14} />
              </button>
              <button type="button" disabled={deleting === f.id} onClick={() => remove(f)} className="text-slate-400 hover:text-red-500 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors" title="Delete field">
                {deleting === f.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              </button>
            </div>
          ))}
        </div>
      )}

      {modalField !== undefined && (
        <CustomFieldModal type={type} field={modalField} onClose={() => setModalField(undefined)} onSaved={() => { setModalField(undefined); load(); }} />
      )}
    </div>
  );
}

function FieldManagerHub() {
  const [activeType, setActiveType] = useState(null);
  const [counts, setCounts] = useState({});
  const [loadingCounts, setLoadingCounts] = useState(true);

  useEffect(() => {
    if (activeType) return;
    setLoadingCounts(true);
    Promise.all(TICKET_TYPES.map((t) => api.get(`/custom-fields?ticket_type=${t}`).then((r) => [t, r.fields.length]).catch(() => [t, 0])))
      .then((pairs) => setCounts(Object.fromEntries(pairs)))
      .finally(() => setLoadingCounts(false));
  }, [activeType]);

  if (activeType) {
    return <TypeFieldDesigner type={activeType} onBack={() => setActiveType(null)} />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Field Manager"
        description="A separate field manager for each ticket type — add text, paragraph, dropdown or multi-select fields that show up right on that type's ticket form."
      />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {TICKET_TYPES.map((type) => {
          const meta = TYPE_META[type];
          const Icon = meta.icon;
          const count = counts[type] || 0;
          return (
            <button key={type} onClick={() => setActiveType(type)} className="card p-4 flex items-start gap-3 text-left hover:shadow-card-hover dark:hover:shadow-card-hover-dark transition-shadow group">
              <div className={`icon-tile w-11 h-11 rounded-xl bg-gradient-to-b ${meta.tile} text-white shrink-0`}>
                <Icon size={18} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <div className="font-medium text-slate-800 dark:text-slate-100">{meta.label} field manager</div>
                  {!loadingCounts && (
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{count} custom field{count === 1 ? '' : 's'}</span>
                  )}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">Built-in: {builtinCatalog(type).map((f) => f.label).join(', ')}</p>
              </div>
              <ChevronRight size={16} className="text-slate-300 dark:text-slate-600 shrink-0 mt-1 group-hover:translate-x-0.5 transition-transform" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ============================== Business Rules ==============================
// Conditional visibility / required / format-validation logic layered on top
// of whatever fields exist for a type — built-in ones above, plus anything
// Field Manager created. Never creates fields itself.

const CONDITION_OPS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'in', label: 'is one of (comma-separated)' },
];
const VALIDATION_TYPES = [
  { value: '', label: 'None' },
  { value: 'regex', label: 'Matches pattern (regex)' },
  { value: 'min_length', label: 'Minimum length' },
  { value: 'max_length', label: 'Maximum length' },
  { value: 'number_range', label: 'Number between (min,max)' },
];

// Built-in fields for a type plus whatever custom fields Field Manager has
// created for it — the full set Business Rules can target or react to.
function useTypeCatalog(type) {
  const [customFields, setCustomFields] = useState([]);
  useEffect(() => {
    if (!type) { setCustomFields([]); return; }
    api.get(`/custom-fields?ticket_type=${type}`).then(({ fields }) => setCustomFields(fields)).catch(() => setCustomFields([]));
  }, [type]);
  if (!type) return [];
  return [...builtinCatalog(type), ...customFields.map((f) => ({ key: f.field_key, label: f.label, custom: true }))];
}

// Rule builder in a modal. When opened from the Business Rules hub's own
// top-right "Create rule" (no type pre-chosen) it asks for the ticket type
// first, then reveals only that type's own fields — built-in and custom.
// When opened from inside a type's own manager, the type is already fixed.
function RuleModal({ initialType, field, rule, onClose, onSaved }) {
  const [type, setType] = useState(initialType || '');
  const catalog = useTypeCatalog(type);
  const [selectedField, setSelectedField] = useState(field || '');
  const [visible, setVisible] = useState(rule ? !!rule.visible : true);
  const [required, setRequired] = useState(rule ? !!rule.required : false);
  const [conditionField, setConditionField] = useState(rule?.condition_field || '');
  const [conditionOp, setConditionOp] = useState(rule?.condition_op || 'equals');
  const [conditionValue, setConditionValue] = useState(rule?.condition_value || '');
  const [validationType, setValidationType] = useState(rule?.validation_type || '');
  const [validationValue, setValidationValue] = useState(rule?.validation_value || '');
  const [validationMessage, setValidationMessage] = useState(rule?.validation_message || '');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!field && catalog.length && !selectedField) setSelectedField(catalog[0].key);
  }, [catalog, field, selectedField]);

  const labelFor = (key) => catalog.find((f) => f.key === key)?.label || FIELD_META[key]?.label || key;
  // A condition can react to this type's own fields (minus the one being
  // configured) plus the two universal fields every ticket has.
  const conditionCandidates = ['priority', 'status', ...catalog.map((f) => f.key)].filter((k) => k !== selectedField);

  const save = async () => {
    setSaving(true);
    const patch = {
      visible, required,
      condition_field: conditionField || null,
      condition_op: conditionField ? conditionOp : null,
      condition_value: conditionField ? conditionValue : null,
      validation_type: validationType || null,
      validation_value: validationType ? validationValue : null,
      validation_message: validationType ? validationMessage : null,
    };
    if (rule) {
      await api.patch(`/field-rules/${rule.id}`, patch);
    } else {
      await api.post('/field-rules', { ticket_type: type, field_name: selectedField, ...patch });
    }
    setSaving(false);
    onSaved();
  };

  return (
    <Modal title={field ? `Edit rule — ${labelFor(field)}` : 'Create rule'} onClose={onClose}>
      <div className="space-y-4">
        {!initialType && (
          <div>
            <label className="label">Ticket type</label>
            <select className="input" value={type} onChange={(e) => { setType(e.target.value); setSelectedField(''); setConditionField(''); }}>
              <option value="">Choose a ticket type…</option>
              {TICKET_TYPES.map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
            </select>
          </div>
        )}

        {type && !field && (
          <div>
            <label className="label">Field</label>
            <select className="input" value={selectedField} onChange={(e) => setSelectedField(e.target.value)}>
              {catalog.map((f) => <option key={f.key} value={f.key}>{f.label}{f.custom ? ' (custom)' : ''}</option>)}
            </select>
          </div>
        )}

        {type && (
          <>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} /> Visible
              </label>
              <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={required} disabled={!visible} onChange={(e) => setRequired(e.target.checked)} /> Required
              </label>
            </div>

            <div>
              <div className="label mb-1.5">Only apply this rule when…</div>
              <div className="flex items-center gap-2 flex-wrap">
                <select className="input w-auto" value={conditionField} onChange={(e) => setConditionField(e.target.value)}>
                  <option value="">Always (no condition)</option>
                  {conditionCandidates.map((k) => <option key={k} value={k}>{labelFor(k)}</option>)}
                </select>
                {conditionField && (
                  <>
                    <select className="input w-auto" value={conditionOp} onChange={(e) => setConditionOp(e.target.value)}>
                      {CONDITION_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <input className="input w-auto" placeholder="value" value={conditionValue} onChange={(e) => setConditionValue(e.target.value)} />
                  </>
                )}
              </div>
            </div>

            <div>
              <div className="label mb-1.5">Format validation</div>
              <div className="flex items-center gap-2 flex-wrap">
                <select className="input w-auto" value={validationType} onChange={(e) => setValidationType(e.target.value)}>
                  {VALIDATION_TYPES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                </select>
                {validationType && (
                  <input
                    className="input w-auto"
                    placeholder={validationType === 'regex' ? 'e.g. ^AT-\\d{4}$' : validationType === 'number_range' ? 'e.g. 1,100' : 'e.g. 10'}
                    value={validationValue}
                    onChange={(e) => setValidationValue(e.target.value)}
                  />
                )}
              </div>
              {validationType && (
                <input
                  className="input mt-2"
                  placeholder="Custom error message shown to the user (optional)"
                  value={validationMessage}
                  onChange={(e) => setValidationMessage(e.target.value)}
                />
              )}
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="button" disabled={saving || !type || !selectedField} onClick={save} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save rule
          </button>
        </div>
      </div>
    </Modal>
  );
}

// One ticket type's own Business Rules manager — only ever shows fields that
// actually exist for that type (built-in + Field Manager's custom ones).
function TypeRuleManager({ type, onBack }) {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalField, setModalField] = useState(undefined); // undefined = closed, null = create (pick field), string = edit that field
  const catalog = useTypeCatalog(type);
  const meta = TYPE_META[type];

  const load = async () => {
    setLoading(true);
    const { rules } = await api.get(`/field-rules?ticket_type=${type}`);
    setRules(rules.filter((r) => !r.category));
    setLoading(false);
  };

  useEffect(() => { load(); }, [type]);

  const ruleFor = (key) => rules.find((r) => r.field_name === key);

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center gap-1">
        <ArrowLeft size={13} /> All business rule managers
      </button>

      <PageHeader
        title={`${meta.label} business rules`}
        description={`Only fields that exist on ${meta.label.toLowerCase()} tickets — built-in and custom. What you configure here is exactly what happens when someone creates a ${meta.label.toLowerCase()} ticket.`}
        actions={<button onClick={() => setModalField(null)} className="btn-primary"><Plus size={14} /> Create rule</button>}
      />

      {loading || !catalog.length ? (
        <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {catalog.map((f) => {
            const rule = ruleFor(f.key);
            const visible = rule ? !!rule.visible : true;
            const required = rule ? !!rule.required : false;
            const conditional = !!rule?.condition_field;
            const validated = !!(rule?.validation_type && rule.validation_type !== 'none');
            return (
              <div key={f.key} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5 flex-wrap">
                    {f.label}
                    {f.custom && <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">custom</span>}
                    {conditional && <span className="badge bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">conditional</span>}
                    {validated && <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">validated</span>}
                  </div>
                  {!visible && <div className="text-xs text-slate-400 mt-0.5">Hidden on the {meta.label.toLowerCase()} form</div>}
                </div>
                <span className={`badge ${visible ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}>
                  {visible ? 'Visible' : 'Hidden'}
                </span>
                {required && <span className="badge bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">Required</span>}
                <button
                  type="button"
                  onClick={() => setModalField(f.key)}
                  className="text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  title="Edit rule"
                >
                  <Pencil size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {modalField !== undefined && (
        <RuleModal
          initialType={type}
          field={modalField}
          rule={modalField ? ruleFor(modalField) : null}
          onClose={() => setModalField(undefined)}
          onSaved={() => { setModalField(undefined); load(); }}
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
    api.get('/field-rules').then(({ rules }) => setAllRules(rules)).finally(() => setLoadingCounts(false));
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
        description="Conditional visibility, required, and format-validation logic — e.g. only require Subcategory when Category = Hardware."
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
        <RuleModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); loadCounts(); }} />
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
          <PageHeader title="Admin Settings" description="Users, groups, workspaces, workflows and business rules" />
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
            {section !== 'workflows' && section !== 'fieldManager' && section !== 'businessRules' && (
              <div>
                <div className="text-xs text-slate-400">Admin Settings</div>
                <h1 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100">{active?.label}</h1>
              </div>
            )}
          </div>

          {section === 'users' && <UsersTab />}
          {section === 'groups' && <GroupsTab />}
          {section === 'workspaces' && <WorkspacesTab />}
          {section === 'workflows' && <Automations />}
          {section === 'fieldManager' && <FieldManagerHub />}
          {section === 'businessRules' && <BusinessRulesHub />}
        </>
      )}
    </div>
  );
}
