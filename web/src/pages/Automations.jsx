import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Loader2, Workflow, Trash2, Bot, ShieldAlert, Check } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from '../components/Modal.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import PageHeader from '../components/PageHeader.jsx';
import ModeControl from '../components/workflow/ModeControl.jsx';

// Sona drafts trigger/conditions/actions from a plain-English description.
// This modal hands the draft off to the graph builder (as router state) for
// review — it never saves anything itself.
function SonaDraftModal({ onClose, onDrafted }) {
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!description.trim()) return;
    setLoading(true);
    setError('');
    try {
      const { draft } = await api.post('/automations/draft', { description: description.trim() });
      onDrafted(draft);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="Ask Sona to build a workflow" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Describe what you want in plain English. Sona drafts the trigger, conditions, and actions — you'll review and can add branching before it saves.
        </p>
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <textarea
          className="input"
          rows={3}
          autoFocus
          placeholder="e.g. When a critical VPN incident comes in, assign it to the Network group and notify Slack."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={loading || !description.trim()} className="btn-primary">
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />} Draft it
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Automations() {
  const navigate = useNavigate();
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sonaOpen, setSonaOpen] = useState(false);
  const [pending, setPending] = useState([]);
  const [deciding, setDeciding] = useState(null);
  const [notes, setNotes] = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const [wf, pendingRes] = await Promise.all([
        api.get('/automations'),
        api.get('/automations/pending'),
      ]);
      setWorkflows(wf.automations);
      setPending(pendingRes.pending);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const setMode = async (wf, patch) => {
    await api.patch(`/automations/${wf.id}`, patch);
    load();
  };

  const decide = async (pendingAction, approve) => {
    setDeciding(pendingAction.id);
    try {
      await api.post(`/automations/pending/${pendingAction.id}/${approve ? 'approve' : 'reject'}`, { note: notes[pendingAction.id]?.trim() || undefined });
      setNotes((n) => { const next = { ...n }; delete next[pendingAction.id]; return next; });
      load();
    } catch (e) {
      alert(e.message);
    } finally {
      setDeciding(null);
    }
  };

  const remove = async (wf) => {
    if (!confirm(`Delete workflow "${wf.name}"?`)) return;
    await api.del(`/automations/${wf.id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Automation"
        description="Build branching workflows visually — trigger, conditions, and actions on a canvas"
        actions={
          <>
            <button onClick={() => setSonaOpen(true)} className="btn-secondary"><Bot size={14} /> Ask Sona</button>
            <button onClick={() => navigate('/automations/new')} className="btn-primary"><Plus size={14} /> New workflow</button>
          </>
        }
      />

      {pending.length > 0 && (
        <div className="card p-4 border-red-100 dark:border-red-900">
          <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-2 flex items-center gap-1.5">
            <ShieldAlert size={14} /> Needs a decision ({pending.length})
          </h3>
          <div className="space-y-2">
            {pending.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">
                <div className="min-w-0 text-sm flex-1">
                  <div>
                    <span className="font-medium text-slate-700 dark:text-slate-200">{p.automation_name}</span>
                    <span className="text-slate-500 dark:text-slate-400"> wants to {p.description}</span>
                    {p.ticket_number && <span className="text-slate-400 font-mono text-xs"> · {p.ticket_number}</span>}
                  </div>
                  {p.action?.message && <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{p.action.message}</p>}
                  <input
                    className="input mt-1.5 text-xs py-1"
                    placeholder="Add a note (optional)"
                    value={notes[p.id] || ''}
                    onChange={(e) => setNotes((n) => ({ ...n, [p.id]: e.target.value }))}
                  />
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button disabled={deciding === p.id} onClick={() => decide(p, false)} className="btn-secondary text-xs">Reject</button>
                  <button disabled={deciding === p.id} onClick={() => decide(p, true)} className="btn-primary text-xs">
                    {deciding === p.id ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Approve
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && <SkeletonRows count={3} />}

      {!loading && workflows.length === 0 && (
        <EmptyState icon={Workflow} description="No automations yet — create one to auto-triage, escalate, or notify." />
      )}

      <div className="space-y-2">
        {workflows.map((wf) => (
          <div key={wf.id} className="card p-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <ModeControl wf={wf} onChange={(patch) => setMode(wf, patch)} />
              <div className="min-w-0 cursor-pointer" onClick={() => navigate(`/automations/${wf.id}`)}>
                <div className="font-medium text-slate-800 dark:text-slate-100 truncate hover:text-brand-600 dark:hover:text-brand-400">{wf.name}</div>
                <div className="text-xs text-slate-500 truncate">{wf.description}</div>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{wf.trigger.event.replace('_', ' ')}</span>
              <span className="text-xs text-slate-400">{wf.run_count} runs</span>
              {wf.last_run_at && <span className="text-xs text-slate-400 hidden sm:inline">last ran {new Date(wf.last_run_at).toLocaleDateString()}</span>}
              <button onClick={() => navigate(`/automations/${wf.id}`)} className="btn-ghost text-xs">Open</button>
              <button onClick={() => remove(wf)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>

      {sonaOpen && (
        <SonaDraftModal
          onClose={() => setSonaOpen(false)}
          onDrafted={(draft) => { setSonaOpen(false); navigate('/automations/new', { state: { draft } }); }}
        />
      )}
    </div>
  );
}
