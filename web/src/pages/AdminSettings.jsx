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
};
const TYPE_META = {
  incident: { label: 'Incident', icon: AlertTriangle, tile: 'from-red-400 to-red-600' },
  request: { label: 'Request', icon: Inbox, tile: 'from-brand-400 to-brand-600' },
  problem: { label: 'Problem', icon: Search, tile: 'from-purple-400 to-purple-600' },
  change: { label: 'Change', icon: GitBranch, tile: 'from-teal-400 to-teal-600' },
};
const builtinCatalog = (type) => [...UNIVERSAL_FIELDS, ...TYPE_FIELD_CATALOG[type]].map((key) => ({ key, label: FIELD_META[key].label }));

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
];
const VALIDATION_TYPES = [
  { value: '', label: 'None' },
  { value: 'regex', label: 'Matches pattern (regex)' },
  { value: 'min_length', label: 'Minimum length' },
  { value: 'max_length', label: 'Maximum length' },
  { value: 'number_range', label: 'Number between (min,max)' },
];
const emptyAction = () => ({ type: 'show_field', field: '', options: [], value: '', validation_type: '', validation_value: '', validation_message: '' });

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
  return [...builtinCatalog(type), ...catalogItemField, ...customFields.map((f) => ({ key: f.field_key, label: f.label, custom: true }))];
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
  const options = fieldOptionsMap[condition.field];
  const needsValue = condition.operator !== 'is_empty' && condition.operator !== 'is_not_empty';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select className="input w-auto" value={condition.field} onChange={(e) => onChange({ ...condition, field: e.target.value })}>
        <option value="">Choose a field…</option>
        {catalog.map((f) => <option key={f.key} value={f.key}>{f.label}{f.custom ? ' (custom)' : ''}</option>)}
      </select>
      <select className="input w-auto" value={condition.operator} onChange={(e) => onChange({ ...condition, operator: e.target.value })}>
        {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {needsValue && (
        options ? (
          <select className="input w-auto" value={condition.value} onChange={(e) => onChange({ ...condition, value: e.target.value })}>
            <option value="">Choose…</option>
            {options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
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
  const optionBearingFields = catalog.filter((f) => fieldOptionsMap[f.key] !== undefined);
  const fieldChoices = needsOptionPicker ? optionBearingFields : catalog;
  const baseOptions = fieldOptionsMap[action.field] || [];
  const toggleOption = (opt) => {
    const has = (action.options || []).includes(opt);
    onChange({ ...action, options: has ? action.options.filter((o) => o !== opt) : [...(action.options || []), opt] });
  };

  return (
    <div className="rounded-lg border border-slate-200 dark:border-white/10 p-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <select
          className="input w-auto"
          value={action.type}
          onChange={(e) => onChange({ ...action, type: e.target.value, field: needsOptionPicker !== (e.target.value === 'set_options' || e.target.value === 'remove_options') ? '' : action.field })}
        >
          {ACTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select className="input w-auto" value={action.field} onChange={(e) => onChange({ ...action, field: e.target.value })}>
          <option value="">Choose a field…</option>
          {fieldChoices.map((f) => <option key={f.key} value={f.key}>{f.label}{f.custom ? ' (custom)' : ''}</option>)}
        </select>
        <button type="button" onClick={onRemove} className="text-slate-400 hover:text-red-500 p-1.5 ml-auto"><X size={14} /></button>
      </div>

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
          <select className="input w-auto" value={action.value} onChange={(e) => onChange({ ...action, value: e.target.value })}>
            <option value="">Choose a value…</option>
            {fieldOptionsMap[action.field].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input className="input w-auto" placeholder="value" value={action.value} onChange={(e) => onChange({ ...action, value: e.target.value })} />
        )
      )}

      {action.type === 'validate_field' && action.field && (
        <div className="flex items-center gap-2 flex-wrap">
          <select className="input w-auto" value={action.validation_type} onChange={(e) => onChange({ ...action, validation_type: e.target.value })}>
            {VALIDATION_TYPES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
          </select>
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
    const cleanActions = actions.filter((a) => a.field);
    if (!cleanActions.length) { setError('Add at least one action with a field selected.'); return; }
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
            <select className="input" value={type} onChange={(e) => { setType(e.target.value); setConditions([]); setActions([emptyAction()]); }}>
              <option value="">Choose a ticket type…</option>
              {TICKET_TYPES.map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
            </select>
          </div>
        )}

        {type && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="label">Rule name</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Require Subcategory for Hardware" />
              </div>
              <div>
                <label className="label">Priority</label>
                <input type="number" className="input" value={priority} onChange={(e) => setPriority(e.target.value)} title="Lower runs first" />
              </div>
            </div>

            <label className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={status === 'active'} onChange={(e) => setStatus(e.target.checked ? 'active' : 'inactive')} /> Active
            </label>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="label mb-0">
                  IF — match{' '}
                  <select className="input w-auto inline-block py-1 px-2 text-xs" value={logic} onChange={(e) => setLogic(e.target.value)}>
                    <option value="AND">ALL (AND)</option>
                    <option value="OR">ANY (OR)</option>
                  </select>
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
    const { rules } = await api.get(`/business-rules?ticket_type=${type}`);
    setRules(rules);
    setLoading(false);
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
    .map((a) => `${ACTION_TYPES.find((t) => t.value === a.type)?.label || a.type} → ${labelFor(a.field)}`)
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
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{rule.name}</span>
                  <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">priority {rule.priority}</span>
                  <button
                    type="button"
                    onClick={() => toggleStatus(rule)}
                    className={`badge ${rule.status === 'active' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}
                    title="Click to toggle"
                  >
                    {rule.status === 'active' ? 'Active' : 'Inactive'}
                  </button>
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">IF {describeConditions(rule.conditions)}</div>
                <div className="text-xs text-slate-500 dark:text-slate-400">THEN {describeActions(rule.actions)}</div>
              </div>
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
