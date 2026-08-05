import { useEffect, useState } from 'react';
import { Plus, X, Loader2, Workflow, Trash2, ToggleLeft, ToggleRight, ChevronDown, ChevronUp, Zap } from 'lucide-react';
import { api } from '../lib/api.js';

const EVENTS = [
  { value: 'ticket_created', label: 'Ticket created' },
  { value: 'ticket_updated', label: 'Ticket updated' },
];

const FIELDS = ['priority', 'status', 'type', 'category', 'team', 'title', 'description'];
const OPS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'in', label: 'is one of (comma list)' },
];

const ACTION_TYPES = [
  { value: 'set_priority', label: 'Set priority' },
  { value: 'set_status', label: 'Set status' },
  { value: 'assign_team', label: 'Assign to team' },
  { value: 'assign_agent', label: 'Assign to agent' },
  { value: 'tag_category', label: 'Set category' },
  { value: 'add_comment', label: 'Add comment' },
  { value: 'notify_integration', label: 'Notify integration (Slack/Teams/Webhook)' },
  { value: 'ai_categorize', label: 'AI: auto-categorize ticket' },
  { value: 'ai_suggest_resolution', label: 'AI: post suggested resolution' },
];

function emptyAction(type = 'set_priority') {
  return { type };
}

function ActionEditor({ action, onChange, onRemove, agents, integrations }) {
  const set = (patch) => onChange({ ...action, ...patch });
  return (
    <div className="border border-slate-200 rounded-lg p-3 space-y-2 bg-slate-50">
      <div className="flex items-center justify-between">
        <select className="input w-auto" value={action.type} onChange={(e) => onChange(emptyAction(e.target.value))}>
          {ACTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <button type="button" onClick={onRemove} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
      </div>

      {action.type === 'set_priority' && (
        <select className="input" value={action.priority || 'medium'} onChange={(e) => set({ priority: e.target.value })}>
          {['low', 'medium', 'high', 'critical'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      )}
      {action.type === 'set_status' && (
        <select className="input" value={action.status || 'open'} onChange={(e) => set({ status: e.target.value })}>
          {['open', 'in_progress', 'on_hold', 'resolved', 'closed'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      )}
      {action.type === 'assign_team' && (
        <input className="input" placeholder="Team name" value={action.team || ''} onChange={(e) => set({ team: e.target.value })} />
      )}
      {action.type === 'assign_agent' && (
        <select className="input" value={action.agent_id || ''} onChange={(e) => set({ agent_id: e.target.value })}>
          <option value="">Select agent…</option>
          {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      )}
      {action.type === 'tag_category' && (
        <div className="grid grid-cols-2 gap-2">
          <input className="input" placeholder="Category" value={action.category || ''} onChange={(e) => set({ category: e.target.value })} />
          <input className="input" placeholder="Subcategory (optional)" value={action.subcategory || ''} onChange={(e) => set({ subcategory: e.target.value })} />
        </div>
      )}
      {action.type === 'add_comment' && (
        <textarea className="input" rows={2} placeholder="Comment body" value={action.body || ''} onChange={(e) => set({ body: e.target.value })} />
      )}
      {action.type === 'notify_integration' && (
        <div className="space-y-2">
          <select className="input" value={action.integration_id || ''} onChange={(e) => set({ integration_id: e.target.value })}>
            <option value="">Any enabled integration of type…</option>
            {integrations.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.type})</option>)}
          </select>
          <input className="input" placeholder="Message" value={action.message || ''} onChange={(e) => set({ message: e.target.value })} />
        </div>
      )}
      {(action.type === 'ai_categorize' || action.type === 'ai_suggest_resolution') && (
        <p className="text-xs text-slate-500">Uses your default AI provider (configure under AI Settings).</p>
      )}
    </div>
  );
}

function WorkflowModal({ initial, onClose, onSaved, agents, integrations }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [event, setEvent] = useState(initial?.trigger?.event || 'ticket_created');
  const [conditions, setConditions] = useState(initial?.conditions || []);
  const [actions, setActions] = useState(initial?.actions?.length ? initial.actions : [emptyAction()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const addCondition = () => setConditions([...conditions, { field: 'priority', op: 'equals', value: '' }]);
  const updateCondition = (i, patch) => setConditions(conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const removeCondition = (i) => setConditions(conditions.filter((_, idx) => idx !== i));

  const addAction = () => setActions([...actions, emptyAction()]);
  const updateAction = (i, next) => setActions(actions.map((a, idx) => (idx === i ? next : a)));
  const removeAction = (i) => setActions(actions.filter((_, idx) => idx !== i));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    const payload = { name, description, trigger: { event }, conditions, actions, enabled: initial?.enabled ?? true };
    try {
      if (initial?.id) await api.patch(`/automations/${initial.id}`, payload);
      else await api.post('/automations', payload);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4 py-8 overflow-y-auto">
      <form onSubmit={submit} className="card w-full max-w-2xl p-5 space-y-4 my-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">{initial?.id ? 'Edit workflow' : 'New automation workflow'}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">Trigger event</label>
            <select className="input" value={event} onChange={(e) => setEvent(e.target.value)}>
              {EVENTS.map((ev) => <option key={ev.value} value={ev.value}>{ev.label}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="label">Description</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="label mb-0">Conditions (all must match — leave empty to always run)</label>
            <button type="button" onClick={addCondition} className="text-xs text-brand-600 hover:text-brand-700 font-medium">+ Add condition</button>
          </div>
          <div className="space-y-2">
            {conditions.map((c, i) => (
              <div key={i} className="flex gap-2 items-center">
                <select className="input w-auto" value={c.field} onChange={(e) => updateCondition(i, { field: e.target.value })}>
                  {FIELDS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <select className="input w-auto" value={c.op} onChange={(e) => updateCondition(i, { op: e.target.value })}>
                  {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input className="input" value={c.value} onChange={(e) => updateCondition(i, { value: e.target.value })} placeholder="value" />
                <button type="button" onClick={() => removeCondition(i)} className="text-slate-400 hover:text-red-500 shrink-0"><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="label mb-0">Actions (run in order)</label>
            <button type="button" onClick={addAction} className="text-xs text-brand-600 hover:text-brand-700 font-medium">+ Add action</button>
          </div>
          <div className="space-y-2">
            {actions.map((a, i) => (
              <ActionEditor
                key={i}
                action={a}
                onChange={(next) => updateAction(i, next)}
                onRemove={() => removeAction(i)}
                agents={agents}
                integrations={integrations}
              />
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />} Save workflow
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Automations() {
  const [workflows, setWorkflows] = useState([]);
  const [agents, setAgents] = useState([]);
  const [integrations, setIntegrations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | 'new' | workflow object
  const [expanded, setExpanded] = useState(null);

  const load = async () => {
    setLoading(true);
    const [wf, users, integ] = await Promise.all([
      api.get('/automations'),
      api.get('/auth/users'),
      api.get('/integrations'),
    ]);
    setWorkflows(wf.automations);
    setAgents(users.users.filter((u) => u.role === 'agent' || u.role === 'admin'));
    setIntegrations(integ.integrations);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const toggle = async (wf) => {
    await api.patch(`/automations/${wf.id}`, { enabled: !wf.enabled });
    load();
  };

  const remove = async (wf) => {
    if (!confirm(`Delete workflow "${wf.name}"?`)) return;
    await api.del(`/automations/${wf.id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Automation</h1>
          <p className="text-sm text-slate-500">Trigger → conditions → actions, including built-in AI steps</p>
        </div>
        <button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New workflow</button>
      </div>

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}

      {!loading && workflows.length === 0 && (
        <div className="card p-10 text-center text-slate-400">
          <Workflow className="mx-auto mb-2 text-slate-300" size={28} /> No automations yet — create one to auto-triage, escalate, or notify.
        </div>
      )}

      <div className="space-y-2">
        {workflows.map((wf) => (
          <div key={wf.id} className="card p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <button onClick={() => toggle(wf)} className={wf.enabled ? 'text-emerald-500' : 'text-slate-300'} title="Toggle enabled">
                  {wf.enabled ? <ToggleRight size={26} /> : <ToggleLeft size={26} />}
                </button>
                <div className="min-w-0">
                  <div className="font-medium text-slate-800 truncate">{wf.name}</div>
                  <div className="text-xs text-slate-500 truncate">{wf.description}</div>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="badge bg-slate-100 text-slate-600">{wf.trigger.event.replace('_', ' ')}</span>
                <span className="text-xs text-slate-400">{wf.run_count} runs</span>
                <button onClick={() => setModal(wf)} className="btn-ghost text-xs">Edit</button>
                <button onClick={() => remove(wf)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                <button onClick={() => setExpanded(expanded === wf.id ? null : wf.id)} className="text-slate-400 hover:text-slate-600">
                  {expanded === wf.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </button>
              </div>
            </div>
            {expanded === wf.id && (
              <div className="mt-3 pt-3 border-t border-slate-100 text-sm space-y-2">
                <div>
                  <span className="text-slate-500">Conditions: </span>
                  {wf.conditions.length === 0 ? <span className="text-slate-400">always runs</span> : (
                    <span className="text-slate-700">{wf.conditions.map((c) => `${c.field} ${c.op} "${c.value}"`).join('  AND  ')}</span>
                  )}
                </div>
                <div>
                  <span className="text-slate-500">Actions: </span>
                  <span className="text-slate-700">{wf.actions.map((a) => ACTION_TYPES.find((t) => t.value === a.type)?.label || a.type).join('  →  ')}</span>
                </div>
                {wf.last_run_at && <div className="text-xs text-slate-400">Last ran: {new Date(wf.last_run_at).toLocaleString()}</div>}
              </div>
            )}
          </div>
        ))}
      </div>

      {modal && (
        <WorkflowModal
          initial={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
          agents={agents}
          integrations={integrations}
        />
      )}
    </div>
  );
}
