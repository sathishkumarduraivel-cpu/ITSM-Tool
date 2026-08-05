import { useEffect, useState } from 'react';
import { Loader2, Save, UserPlus, Trash2, Building2, Users, ListChecks } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Modal from '../components/Modal.jsx';
import EmptyState from '../components/EmptyState.jsx';

const TABS = [
  { key: 'profile', label: 'Company Profile', icon: Building2 },
  { key: 'users', label: 'Users & Roles', icon: Users },
  { key: 'fields', label: 'Ticket Field Rules', icon: ListChecks },
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

function AddMemberModal({ workspaceId, onClose, onSaved }) {
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
      await api.post(`/workspaces/${workspaceId}/members`, { email, name, password, role, team: team || null });
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
          <label className="label">Email</label>
          <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label">Name (only needed if this is a brand-new user)</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Temporary password (only needed if this is a brand-new user)</label>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
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
  const [members, setMembers] = useState(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = async () => {
    const { members } = await api.get(`/workspaces/${user.workspace_id}/members`);
    setMembers(members);
  };

  useEffect(() => { load(); }, []);

  const updateRole = async (userId, roleValue) => {
    await api.patch(`/workspaces/${user.workspace_id}/members/${userId}`, { role: roleValue });
    load();
  };

  const toggleActive = async (m) => {
    await api.patch(`/workspaces/${user.workspace_id}/members/${m.user_id}`, { active: !m.active });
    load();
  };

  const remove = async (m) => {
    if (!confirm(`Remove ${m.name} from this workspace?`)) return;
    await api.del(`/workspaces/${user.workspace_id}/members/${m.user_id}`);
    load();
  };

  if (!members) return <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>;

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => setShowAdd(true)} className="btn-primary"><UserPlus size={14} /> Add user</button>
      </div>

      {members.length === 0 ? (
        <EmptyState icon={Users} title="No members yet" />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {members.map((m) => (
            <div key={m.membership_id} className="flex items-center gap-3 px-4 py-3">
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-semibold shrink-0"
                style={{ backgroundColor: m.avatar_color || '#6366f1' }}
              >
                {m.name?.[0]?.toUpperCase() || '?'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{m.name}</div>
                <div className="text-xs text-slate-500 truncate">{m.email}{m.team ? ` · ${m.team}` : ''}</div>
              </div>
              <select
                className="input w-auto py-1 text-xs"
                value={m.role}
                onChange={(e) => updateRole(m.user_id, e.target.value)}
                disabled={m.user_id === user.id}
              >
                <option value="requester">Requester</option>
                <option value="agent">Agent</option>
                <option value="admin">Admin</option>
              </select>
              <button
                onClick={() => toggleActive(m)}
                disabled={m.user_id === user.id}
                className={`text-xs px-2 py-1 rounded-md ${m.active ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}
              >
                {m.active ? 'Active' : 'Deactivated'}
              </button>
              <button onClick={() => remove(m)} disabled={m.user_id === user.id} className="text-slate-400 hover:text-red-500 disabled:opacity-30">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <AddMemberModal workspaceId={user.workspace_id} onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} />
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
        Control which fields show on the {ticketType} form. Fields with no rule configured stay visible (existing default behavior).
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

export default function AdminSettings() {
  const [tab, setTab] = useState('profile');

  return (
    <div className="space-y-4">
      <PageHeader title="Admin Settings" description="Company profile, users & roles, and ticket field rules" />

      <div className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === t.key
                ? 'border-brand-600 text-brand-700 dark:text-brand-400'
                : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            <t.icon size={14} /> {t.label}
          </button>
        ))}
      </div>

      {tab === 'profile' && <CompanyProfileTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'fields' && <FieldRulesTab />}
    </div>
  );
}
