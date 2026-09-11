import { useEffect, useState } from 'react';
import { Plus, Loader2, TrendingUp, Trash2, Pencil, ArrowUpCircle, Bell, MessageSquare } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Select from '../components/Select.jsx';

const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const emptyLevel = () => ({ threshold_pct: 100, notify_role: '', notify_user_id: '', set_priority: '', post_comment: true });

function PolicyModal({ initial, onClose, onSaved, groups, agents }) {
  const [form, setForm] = useState({
    name: initial?.name || '', ticket_type: initial?.ticket_type || '', priority: initial?.priority || '', team: initial?.team || '',
    enabled: initial ? !!initial.enabled : true,
  });
  const [levels, setLevels] = useState(
    initial?.levels?.length
      ? initial.levels.map((l) => ({ threshold_pct: l.threshold_pct, notify_role: l.notify_role || '', notify_user_id: l.notify_user_id || '', set_priority: l.set_priority || '', post_comment: !!l.post_comment }))
      : [emptyLevel()]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const updateLevel = (i, patch) => setLevels(levels.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLevel = () => setLevels([...levels, emptyLevel()]);
  const removeLevel = (i) => setLevels(levels.filter((_, idx) => idx !== i));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { ...form, levels };
      if (initial?.id) await api.patch(`/escalations/policies/${initial.id}`, payload);
      else await api.post('/escalations/policies', payload);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit escalation policy' : 'New escalation policy'} onClose={onClose} maxWidth="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

        <div>
          <label className="label">Name</label>
          <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Critical incident escalation" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Ticket type (optional)</label>
            <Select placeholder="Any" value={form.ticket_type} onChange={(v) => setForm({ ...form, ticket_type: v })} options={['incident', 'request', 'problem', 'change']} />
          </div>
          <div>
            <label className="label">Priority (optional)</label>
            <Select placeholder="Any" value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} options={PRIORITIES} />
          </div>
          <div>
            <label className="label">Group (optional)</label>
            <Select placeholder="Any" value={form.team} onChange={(v) => setForm({ ...form, team: v })} options={groups.map((g) => ({ value: g.name, label: g.name }))} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Active
        </label>

        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label mb-0">Escalation levels — fire in order as time elapses</label>
            <button type="button" onClick={addLevel} className="text-xs text-brand-600 dark:text-brand-400 font-medium flex items-center gap-1"><Plus size={12} /> Add level</button>
          </div>
          <div className="space-y-2">
            {levels.map((lvl, i) => (
              <div key={i} className="card-flat p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Level {i + 1}</span>
                  {levels.length > 1 && (
                    <button type="button" onClick={() => removeLevel(i)} className="text-slate-400 hover:text-red-500"><Trash2 size={13} /></button>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="label text-[11px]">% of SLA elapsed</label>
                    <input
                      type="number" min={1} max={500} className="input" required
                      value={lvl.threshold_pct}
                      onChange={(e) => updateLevel(i, { threshold_pct: Number(e.target.value) })}
                    />
                  </div>
                  <div>
                    <label className="label text-[11px] flex items-center gap-1"><Bell size={10} /> Notify role</label>
                    <Select
                      value={lvl.notify_role} onChange={(v) => updateLevel(i, { notify_role: v })}
                      options={[{ value: '', label: 'None' }, { value: 'agent', label: 'All agents' }, { value: 'admin', label: 'All admins' }]}
                    />
                  </div>
                  <div>
                    <label className="label text-[11px]">Notify person</label>
                    <Select
                      value={lvl.notify_user_id} onChange={(v) => updateLevel(i, { notify_user_id: v })}
                      options={[{ value: '', label: 'None' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 items-end">
                  <div>
                    <label className="label text-[11px] flex items-center gap-1"><ArrowUpCircle size={10} /> Raise priority to</label>
                    <Select
                      value={lvl.set_priority} onChange={(v) => updateLevel(i, { set_priority: v })}
                      options={[{ value: '', label: "Don't change" }, ...PRIORITIES]}
                    />
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 pb-2">
                    <input type="checkbox" checked={lvl.post_comment} onChange={(e) => updateLevel(i, { post_comment: e.target.checked })} />
                    <MessageSquare size={11} /> Add a note on the ticket
                  </label>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {initial?.id ? 'Save changes' : 'Save policy'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function EscalationRules() {
  const [policies, setPolicies] = useState([]);
  const [groups, setGroups] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | 'new' | policy

  const load = async () => {
    setLoading(true);
    try {
      const [pol, groupsRes, agentsRes] = await Promise.all([
        api.get('/escalations/policies'),
        api.get('/groups'),
        api.get('/tickets/assignable-agents').catch(() => ({ agents: [] })),
      ]);
      setPolicies(pol.policies);
      setGroups(groupsRes.groups);
      setAgents(agentsRes.agents);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    if (!confirm('Delete this escalation policy?')) return;
    await api.del(`/escalations/policies/${id}`);
    load();
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Escalation Rules"
        description="Automatic multi-level escalation as a ticket approaches or breaches its SLA"
        actions={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New policy</button>}
      />

      <div className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
        Escalation is checked whenever a ticket is opened or its list is viewed — there's no background timer, so a ticket escalates the moment someone next looks at it after crossing a threshold, which in active use is effectively immediate.
      </div>

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}

      <div className="card overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Name</th>
              <th className="text-left px-4 py-2.5 font-medium">Matches</th>
              <th className="text-left px-4 py-2.5 font-medium">Levels</th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th className="text-left px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {!loading && policies.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8 text-slate-400"><TrendingUp className="mx-auto mb-1 text-slate-300" size={22} /> No escalation policies yet — tickets will never auto-escalate until one exists.</td></tr>
            )}
            {policies.map((p) => (
              <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-100">{p.name}</td>
                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 text-xs">
                  {[p.ticket_type && `type=${p.ticket_type}`, p.priority && `priority=${p.priority}`, p.team && `group=${p.team}`].filter(Boolean).join(', ') || 'any ticket'}
                </td>
                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 text-xs">
                  {p.levels.map((l) => `${l.threshold_pct}%`).join(' → ')}
                </td>
                <td className="px-4 py-2.5">
                  <span className={`badge ${p.enabled ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'}`}>
                    {p.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => setModal(p)} className="text-slate-400 hover:text-brand-600"><Pencil size={14} /></button>
                    <button onClick={() => remove(p.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <PolicyModal
          initial={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
          groups={groups}
          agents={agents}
        />
      )}
    </div>
  );
}
