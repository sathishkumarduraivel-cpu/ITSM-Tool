import { useEffect, useState } from 'react';
import { Plus, X, Loader2, Workflow, Trash2, ChevronDown, ChevronUp, Zap, FlaskConical, ListChecks, PlayCircle } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from '../components/Modal.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import PageHeader from '../components/PageHeader.jsx';

const EVENTS = [
  { value: 'ticket_created', label: 'Ticket created' },
  { value: 'ticket_updated', label: 'Ticket updated' },
];

const FIELDS = ['priority', 'status', 'type', 'category', 'team', 'title', 'description'];
const FIELD_LABELS = { team: 'group' };
const OPS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'in', label: 'is one of (comma list)' },
];

// Fields with a known, valid set of values get a dropdown instead of free text
// — this is what makes conditions like `type = request` reliable to author.
const FIELD_ENUMS = {
  priority: ['low', 'medium', 'high', 'critical'],
  status: ['open', 'in_progress', 'on_hold', 'resolved', 'closed'],
  type: ['incident', 'request', 'problem', 'change'],
};

function ConditionValueInput({ field, value, onChange, groups }) {
  if (FIELD_ENUMS[field]) {
    return (
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select value…</option>
        {FIELD_ENUMS[field].map((v) => <option key={v} value={v}>{v}</option>)}
      </select>
    );
  }
  if (field === 'team' && groups.length > 0) {
    return (
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select group…</option>
        {groups.map((g) => <option key={g.id} value={g.name}>{g.name}</option>)}
      </select>
    );
  }
  return <input className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder="value" />;
}

const ACTION_TYPES = [
  { value: 'set_priority', label: 'Set priority' },
  { value: 'set_status', label: 'Set status' },
  { value: 'assign_team', label: 'Assign to group' },
  { value: 'assign_agent', label: 'Assign to agent' },
  { value: 'tag_category', label: 'Set category' },
  { value: 'add_comment', label: 'Add comment' },
  { value: 'notify_integration', label: 'Notify integration (Slack/Teams/Webhook)' },
  { value: 'ai_categorize', label: 'AI: auto-categorize ticket' },
  { value: 'ai_suggest_resolution', label: 'AI: post suggested resolution' },
  { value: 'auto_approve', label: 'Auto-approve pending approval' },
];

function emptyAction(type = 'set_priority') {
  return { type };
}

function ActionEditor({ action, onChange, onRemove, agents, integrations, groups }) {
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
        <select className="input" value={action.team || ''} onChange={(e) => set({ team: e.target.value })}>
          <option value="">Select group…</option>
          {groups.map((g) => <option key={g.id} value={g.name}>{g.name}</option>)}
        </select>
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
      {action.type === 'auto_approve' && (
        <p className="text-xs text-slate-500">Automatically approves any pending approval steps on the triggering ticket, skipping manual review.</p>
      )}
    </div>
  );
}

// A workflow is always in exactly one of three states — no separate
// "enabled" + "test" toggles that could contradict each other:
//  off  -> not evaluated at all
//  test -> evaluated against real tickets, but only logs what it would do
//  live -> evaluated and actually executes
const MODES = [
  { key: 'off', label: 'Off', on: 'bg-slate-400 text-white' },
  { key: 'test', label: 'Test', on: 'bg-amber-500 text-white' },
  { key: 'live', label: 'Live', on: 'bg-emerald-500 text-white' },
];

function modeOf(wf) {
  if (!wf.enabled) return 'off';
  return wf.test_mode ? 'test' : 'live';
}

function ModeControl({ wf, onChange }) {
  const current = modeOf(wf);
  const patchFor = {
    off: { enabled: false, test_mode: false },
    test: { enabled: true, test_mode: true },
    live: { enabled: true, test_mode: false },
  };
  return (
    <div className="flex items-center rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden shrink-0">
      {MODES.map((m) => (
        <button
          key={m.key}
          type="button"
          onClick={() => onChange(patchFor[m.key])}
          className={`px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            current === m.key ? m.on : 'bg-white dark:bg-slate-900 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800'
          }`}
          title={
            m.key === 'off' ? 'Not evaluated at all' :
            m.key === 'test' ? 'Checks real tickets, only logs what it would do — nothing actually happens' :
            'Fully live — actions run for real'
          }
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

function WorkflowModal({ initial, onClose, onSaved, agents, integrations, groups }) {
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
    <Modal title={initial?.id ? 'Edit workflow' : 'New automation workflow'} onClose={onClose} maxWidth="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

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
                  {FIELDS.map((f) => <option key={f} value={f}>{FIELD_LABELS[f] || f}</option>)}
                </select>
                <select className="input w-auto" value={c.op} onChange={(e) => updateCondition(i, { op: e.target.value })}>
                  {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <div className="flex-1">
                  <ConditionValueInput field={c.field} value={c.value} onChange={(v) => updateCondition(i, { value: v })} groups={groups} />
                </div>
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
                groups={groups}
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
    </Modal>
  );
}

export default function Automations() {
  const [workflows, setWorkflows] = useState([]);
  const [agents, setAgents] = useState([]);
  const [integrations, setIntegrations] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | 'new' | workflow object
  const [expanded, setExpanded] = useState(null);
  const [logs, setLogs] = useState({}); // { [workflowId]: rows }
  const [testResults, setTestResults] = useState({}); // { [workflowId]: { checked, matched, results } }
  const [testing, setTesting] = useState(null); // workflow id currently running a test-run

  const load = async () => {
    setLoading(true);
    const [wf, users, integ, groupsRes] = await Promise.all([
      api.get('/automations'),
      api.get('/auth/users'),
      api.get('/integrations'),
      api.get('/groups'),
    ]);
    setWorkflows(wf.automations);
    setAgents(users.users.filter((u) => u.role === 'agent' || u.role === 'admin'));
    setIntegrations(integ.integrations);
    setGroups(groupsRes.groups);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const setMode = async (wf, patch) => {
    await api.patch(`/automations/${wf.id}`, patch);
    load();
  };

  const remove = async (wf) => {
    if (!confirm(`Delete workflow "${wf.name}"?`)) return;
    await api.del(`/automations/${wf.id}`);
    load();
  };

  const toggleExpand = async (id) => {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next && !logs[next]) {
      const { logs: rows } = await api.get(`/automations/${next}/logs`);
      setLogs((l) => ({ ...l, [next]: rows }));
    }
  };

  const runTest = async (id) => {
    setTesting(id);
    try {
      const res = await api.post(`/automations/${id}/test-run`, {});
      setTestResults((r) => ({ ...r, [id]: res }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Automation"
        description="Trigger → conditions → actions, including built-in AI steps"
        actions={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New workflow</button>}
      />

      {loading && <SkeletonRows count={3} />}

      {!loading && workflows.length === 0 && (
        <EmptyState icon={Workflow} description="No automations yet — create one to auto-triage, escalate, or notify." />
      )}

      <div className="space-y-2">
        {workflows.map((wf) => {
          const mode = modeOf(wf);
          const wfLogs = logs[wf.id];
          const wfTest = testResults[wf.id];
          return (
            <div key={wf.id} className="card p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <ModeControl wf={wf} onChange={(patch) => setMode(wf, patch)} />
                  <div className="min-w-0">
                    <div className="font-medium text-slate-800 dark:text-slate-100 truncate">{wf.name}</div>
                    <div className="text-xs text-slate-500 truncate">{wf.description}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{wf.trigger.event.replace('_', ' ')}</span>
                  <span className="text-xs text-slate-400">{wf.run_count} runs</span>
                  <button onClick={() => setModal(wf)} className="btn-ghost text-xs">Edit</button>
                  <button onClick={() => remove(wf)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                  <button onClick={() => toggleExpand(wf.id)} className="text-slate-400 hover:text-slate-600">
                    {expanded === wf.id ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                  </button>
                </div>
              </div>

              {mode === 'test' && (
                <div className="mt-3 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-500/10 rounded-lg px-2.5 py-1.5">
                  <FlaskConical size={13} /> Test mode — watching real tickets, but not acting on them. Nothing here is affecting live data.
                </div>
              )}

              {expanded === wf.id && (
                <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-sm space-y-3">
                  <div>
                    <span className="text-slate-500">Conditions: </span>
                    {wf.conditions.length === 0 ? <span className="text-slate-400">always runs</span> : (
                      <span className="text-slate-700 dark:text-slate-200">{wf.conditions.map((c) => `${FIELD_LABELS[c.field] || c.field} ${c.op} "${c.value}"`).join('  AND  ')}</span>
                    )}
                  </div>
                  <div>
                    <span className="text-slate-500">Actions: </span>
                    <span className="text-slate-700 dark:text-slate-200">{wf.actions.map((a) => ACTION_TYPES.find((t) => t.value === a.type)?.label || a.type).join('  →  ')}</span>
                  </div>
                  {wf.last_run_at && <div className="text-xs text-slate-400">Last ran: {new Date(wf.last_run_at).toLocaleString()}</div>}

                  {/* Instant feedback: check against the last 30 days without waiting for new tickets */}
                  <div className="card-flat p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                        <PlayCircle size={13} /> Test against last 30 days
                      </span>
                      <button onClick={() => runTest(wf.id)} disabled={testing === wf.id} className="btn-secondary text-xs">
                        {testing === wf.id ? <Loader2 size={12} className="animate-spin" /> : <PlayCircle size={12} />} Run check
                      </button>
                    </div>
                    {wfTest && (
                      <div className="space-y-1.5">
                        <p className="text-xs text-slate-500">
                          Checked {wfTest.checked} ticket(s) from the last 30 days — {wfTest.matched} would have matched.
                        </p>
                        {wfTest.results.slice(0, 10).map((r) => (
                          <div key={r.ticket.id} className="text-xs bg-white dark:bg-slate-900 rounded-md px-2 py-1.5 border border-slate-100 dark:border-slate-800">
                            <span className="font-mono text-slate-400">{r.ticket.number}</span>{' '}
                            <span className="text-slate-700 dark:text-slate-200">{r.ticket.title}</span>
                            <div className="text-slate-400 mt-0.5">{r.would.join('; ')}</div>
                          </div>
                        ))}
                        {wfTest.results.length > 10 && (
                          <p className="text-[11px] text-slate-400">+ {wfTest.results.length - 10} more not shown</p>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Run log: real executions ("Ran") and, in Test mode, dry-run matches ("Would run") */}
                  <div className="card-flat p-3">
                    <div className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5 mb-2">
                      <ListChecks size={13} /> Run log
                    </div>
                    {!wfLogs && <p className="text-xs text-slate-400">Loading…</p>}
                    {wfLogs?.length === 0 && <p className="text-xs text-slate-400">No runs recorded yet.</p>}
                    <div className="space-y-1.5">
                      {wfLogs?.slice(0, 10).map((log) => (
                        <div key={log.id} className="text-xs flex items-start gap-2">
                          <span className={`badge shrink-0 ${
                            log.status === 'success' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' :
                            log.status === 'test_match' ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' :
                            'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400'
                          }`}>
                            {log.status === 'success' ? 'Ran' : log.status === 'test_match' ? 'Would run' : 'Error'}
                          </span>
                          <span className="text-slate-500 dark:text-slate-400">{log.detail}</span>
                          <span className="text-slate-300 dark:text-slate-600 ml-auto shrink-0 font-mono">{new Date(log.created_at).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {modal && (
        <WorkflowModal
          initial={modal === 'new' ? null : modal}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
          agents={agents}
          integrations={integrations}
          groups={groups}
        />
      )}
    </div>
  );
}
