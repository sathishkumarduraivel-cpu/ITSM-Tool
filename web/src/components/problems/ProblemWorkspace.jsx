import { useCallback, useEffect, useState } from 'react';
import {
  Loader2, AlertTriangle, Plus, Trash2, Check, X, Link2, ShieldAlert,
  ListChecks, GitBranch, Lightbulb, ChevronRight, CircleCheck, Clock,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';

const ACTION_TONE = {
  open: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  in_progress: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  done: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  cancelled: 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
};

function Section({ icon: Icon, title, hint, children, actions }) {
  return (
    <section className="rounded-xl border border-slate-200 p-4 dark:border-white/10">
      <div className="mb-2.5 flex items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
            {Icon && <Icon size={14} className="text-slate-400" />} {title}
          </h3>
          {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

// The lifecycle as a row of steps, with the reason a step cannot be taken
// shown against it rather than hidden behind a failed click.
function StateBar({ problem, meta, onMove, busy }) {
  const order = meta.states.map((s) => s.key);
  const currentIndex = order.indexOf(problem.problem_state);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {meta.states.map((s, i) => {
          const done = i < currentIndex;
          const here = s.key === problem.problem_state;
          return (
            <span key={s.key} className="flex items-center">
              <span
                title={s.description}
                className={`rounded-lg px-2 py-1 text-[11px] font-medium ${
                  here ? 'bg-brand-600 text-white'
                    : done ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
                      : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
                }`}
              >{s.label}</span>
              {i < meta.states.length - 1 && <ChevronRight size={11} className="mx-0.5 text-slate-300 dark:text-slate-600" />}
            </span>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {problem.available_states.length === 0 && <span className="text-[11px] text-slate-400">This problem is finished.</span>}
        {problem.available_states.map((s) => (
          <button
            key={s.key}
            onClick={() => onMove(s.key, s.blockers)}
            disabled={busy}
            title={s.blockers.length ? s.blockers.map((b) => b.message).join(' ') : `Move to ${s.label}`}
            className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
              s.blockers.length
                ? 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-500/30 dark:text-amber-400'
                : 'border-slate-200 text-slate-600 hover:border-brand-400 hover:text-brand-600 dark:border-white/10 dark:text-slate-300'
            }`}
          >
            {s.blockers.length ? <AlertTriangle size={11} className="mr-1 inline" /> : null}
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function ProblemWorkspace({ problemId, meta, onClose, onChanged }) {
  const [problem, setProblem] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newStep, setNewStep] = useState('');
  const [newAction, setNewAction] = useState({ title: '', owner_id: '', due_date: '' });
  const [linkNumber, setLinkNumber] = useState('');
  const [agents, setAgents] = useState([]);
  const [blockerPrompt, setBlockerPrompt] = useState(null);

  const load = useCallback(async () => {
    try { setProblem((await api.get(`/problems/${problemId}`)).problem); setError(''); }
    catch (e) { setError(e.message); }
  }, [problemId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/tickets/assignable-agents', { quiet: true }).then((d) => setAgents(d.agents || [])).catch(() => {}); }, []);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await load(); onChanged?.(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const save = (patch) => run(() => api.patch(`/problems/${problemId}`, patch));

  const move = (state, blockers) => {
    if (blockers?.length) { setBlockerPrompt({ state, blockers }); return; }
    run(() => api.post(`/problems/${problemId}/state`, { state }));
  };

  if (!problem) {
    return (
      <Modal title="Problem" onClose={onClose} maxWidth="max-w-5xl">
        <div className="flex items-center gap-2 py-10 text-sm text-slate-500">
          {error ? <><AlertTriangle size={15} className="text-amber-500" /> {error}</> : <><Loader2 size={15} className="animate-spin" /> Loading…</>}
        </div>
      </Modal>
    );
  }

  const field = (key, label, placeholder, rows = 3) => (
    <div>
      <label className="label">{label}</label>
      <textarea
        className="input" style={{ minHeight: rows * 22 }}
        defaultValue={problem[key] || ''}
        placeholder={placeholder}
        onBlur={(e) => { if (e.target.value !== (problem[key] || '')) save({ [key]: e.target.value }); }}
      />
    </div>
  );

  return (
    <Modal
      title={`${problem.number} — ${problem.title}`}
      onClose={onClose}
      maxWidth="max-w-5xl"
      footer={(
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span>{problem.incident_count} incident{problem.incident_count === 1 ? '' : 's'} explained</span>
            {problem.open_actions > 0 && <span>· {problem.open_actions} open action{problem.open_actions === 1 ? '' : 's'}</span>}
            {problem.overdue_actions > 0 && <span className="text-red-500">· {problem.overdue_actions} overdue</span>}
          </div>
          <button onClick={onClose} className="btn-secondary">Close</button>
        </div>
      )}
    >
      <div className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
            <button onClick={() => setError('')} className="ml-auto shrink-0"><X size={13} /></button>
          </div>
        )}

        <StateBar problem={problem} meta={meta} onMove={move} busy={busy} />

        {problem.is_known_error === 1 && (
          <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm dark:bg-amber-500/10">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-amber-800 dark:text-amber-300">Known error — workaround published</p>
              <p className="mt-0.5 whitespace-pre-wrap text-amber-900/80 dark:text-amber-200/80">{problem.workaround}</p>
            </div>
            <button onClick={() => run(() => api.del(`/problems/${problemId}/known-error`))} className="shrink-0 text-[11px] text-amber-700 hover:underline dark:text-amber-400">
              Withdraw
            </button>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <Section icon={Lightbulb} title="The analysis" hint="How the cause was worked out, and what it turned out to be.">
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="label">Method</label>
                  <Select
                    value={problem.rca_method || ''}
                    onChange={(v) => save({ rca_method: v })}
                    options={[{ value: '', label: 'Not chosen' }, ...meta.rca_methods.map((m) => ({ value: m.key, label: m.label }))]}
                  />
                </div>
                <div>
                  <label className="label">Cause category</label>
                  <Select
                    value={problem.root_cause_category || ''}
                    onChange={(v) => save({ root_cause_category: v })}
                    options={[{ value: '', label: 'Not determined' }, ...meta.root_cause_categories.map((c) => ({ value: c.value, label: c.label }))]}
                  />
                </div>
              </div>

              {/* The steps, which is what makes the reasoning reviewable. */}
              <div>
                <label className="label">
                  {meta.rca_methods.find((m) => m.key === problem.rca_method)?.step_label || 'Step'}s
                </label>
                {problem.rca_steps.length === 0 && <p className="mb-1.5 text-[11px] text-slate-400">Nothing recorded yet.</p>}
                <ol className="space-y-1.5">
                  {problem.rca_steps.map((s, i) => (
                    <li key={s.id} className="flex items-start gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs dark:bg-slate-800/60">
                      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-slate-200 text-[9px] font-bold dark:bg-slate-700">{i + 1}</span>
                      <span className="min-w-0 flex-1 text-slate-700 dark:text-slate-200">{s.content}</span>
                      <button onClick={() => run(() => api.del(`/problems/rca/${s.id}`))} className="shrink-0 text-slate-400 hover:text-red-500"><Trash2 size={12} /></button>
                    </li>
                  ))}
                </ol>
                <div className="mt-1.5 flex gap-1.5">
                  <input
                    className="input text-xs" value={newStep}
                    onChange={(e) => setNewStep(e.target.value)}
                    placeholder={meta.rca_methods.find((m) => m.key === problem.rca_method)?.hint || 'Add a step…'}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newStep.trim()) {
                        e.preventDefault();
                        run(() => api.post(`/problems/${problemId}/rca`, { content: newStep })).then(() => setNewStep(''));
                      }
                    }}
                  />
                  <button
                    onClick={() => newStep.trim() && run(() => api.post(`/problems/${problemId}/rca`, { content: newStep })).then(() => setNewStep(''))}
                    disabled={!newStep.trim() || busy}
                    className="btn-secondary shrink-0 text-xs disabled:opacity-40"
                  ><Plus size={12} /></button>
                </div>
              </div>

              {field('root_cause_detail', 'Root cause', 'What, specifically, was wrong.')}
              {field('workaround', 'Workaround', 'What people can do until it is fixed.')}
              {!problem.is_known_error && (
                <button
                  onClick={() => run(() => api.post(`/problems/${problemId}/known-error`, {}))}
                  disabled={busy || !String(problem.workaround || '').trim()}
                  className="btn-secondary text-xs disabled:opacity-40"
                  title={!String(problem.workaround || '').trim() ? 'Write a workaround first' : 'Publish to the known-error register'}
                ><ShieldAlert size={12} /> Declare a known error</button>
              )}
            </div>
          </Section>

          <div className="space-y-4">
            <Section
              icon={Link2}
              title={`Incidents explained (${problem.incident_count})`}
              hint="The evidence that this problem is real, and the measure of what fixing it is worth."
            >
              <div className="max-h-44 space-y-1 overflow-y-auto">
                {problem.incidents.length === 0 && <p className="text-[11px] text-slate-400">None linked yet.</p>}
                {problem.incidents.map((i) => (
                  <div key={i.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs dark:bg-slate-800/60">
                    <span className="font-mono text-[10px] text-slate-500">{i.number}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200" title={i.title}>{i.title}</span>
                    <button onClick={() => run(() => api.del(`/problems/${problemId}/incidents/${i.id}`))} className="shrink-0 text-slate-400 hover:text-red-500"><X size={12} /></button>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <input
                  className="input text-xs" value={linkNumber}
                  onChange={(e) => setLinkNumber(e.target.value)}
                  placeholder="Ticket id to link…"
                />
                <button
                  onClick={() => linkNumber.trim() && run(() => api.post(`/problems/${problemId}/incidents`, { incident_id: linkNumber.trim() })).then(() => setLinkNumber(''))}
                  disabled={!linkNumber.trim() || busy}
                  className="btn-secondary shrink-0 text-xs disabled:opacity-40"
                ><Link2 size={12} /></button>
              </div>
            </Section>

            <Section
              icon={ListChecks}
              title={`Corrective actions (${problem.open_actions} open)`}
              hint="A cause found and then not acted on is how problem management quietly fails."
            >
              <div className="space-y-1">
                {problem.actions.length === 0 && <p className="text-[11px] text-slate-400">Nothing planned yet.</p>}
                {problem.actions.map((a) => {
                  const overdue = ['open', 'in_progress'].includes(a.status) && a.due_date && a.due_date < new Date().toISOString().slice(0, 10);
                  return (
                    <div key={a.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs dark:bg-slate-800/60">
                      <button
                        onClick={() => run(() => api.patch(`/problems/actions/${a.id}`, { status: a.status === 'done' ? 'open' : 'done' }))}
                        className={a.status === 'done' ? 'text-emerald-500' : 'text-slate-300 hover:text-emerald-500'}
                        title={a.status === 'done' ? 'Reopen' : 'Mark done'}
                      ><CircleCheck size={14} /></button>
                      <span className={`min-w-0 flex-1 truncate ${a.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-700 dark:text-slate-200'}`}>{a.title}</span>
                      {a.owner_name && <span className="shrink-0 text-[10px] text-slate-400">{a.owner_name}</span>}
                      {a.due_date && (
                        <span className={`shrink-0 text-[10px] ${overdue ? 'font-semibold text-red-500' : 'text-slate-400'}`}>
                          {overdue && <Clock size={9} className="mr-0.5 inline" />}{a.due_date}
                        </span>
                      )}
                      <span className={`badge shrink-0 text-[9px] ${ACTION_TONE[a.status]}`}>{a.status.replace('_', ' ')}</span>
                      <button onClick={() => run(() => api.del(`/problems/actions/${a.id}`))} className="shrink-0 text-slate-400 hover:text-red-500"><Trash2 size={11} /></button>
                    </div>
                  );
                })}
              </div>
              <div className="mt-2 grid grid-cols-[1fr_auto_auto_auto] gap-1.5">
                <input className="input text-xs" value={newAction.title} onChange={(e) => setNewAction({ ...newAction, title: e.target.value })} placeholder="What needs doing…" />
                <Select
                  value={newAction.owner_id} onChange={(v) => setNewAction({ ...newAction, owner_id: v })}
                  options={[{ value: '', label: 'Owner' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
                  size="sm"
                />
                <input type="date" className="input text-xs" value={newAction.due_date} onChange={(e) => setNewAction({ ...newAction, due_date: e.target.value })} />
                <button
                  onClick={() => newAction.title.trim() && run(() => api.post(`/problems/${problemId}/actions`, newAction)).then(() => setNewAction({ title: '', owner_id: '', due_date: '' }))}
                  disabled={!newAction.title.trim() || busy}
                  className="btn-secondary text-xs disabled:opacity-40"
                ><Plus size={12} /></button>
              </div>
            </Section>
          </div>
        </div>

        <Section icon={GitBranch} title="Impact and closure">
          <div className="grid gap-3 sm:grid-cols-2">
            {field('business_impact', 'Business impact', 'Who this affects and how badly.', 2)}
            {field('problem_frequency', 'How often it recurs', 'e.g. two or three times a week', 2)}
            {field('lessons_learned', 'Lessons learned', 'What would have caught this sooner.', 2)}
            <div>
              <label className="label">Closing without a fix</label>
              <label className="mt-1 flex cursor-pointer items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
                <input
                  type="checkbox" className="mt-0.5 rounded"
                  checked={!!problem.residual_risk_accepted}
                  onChange={(e) => save({ residual_risk_accepted: e.target.checked })}
                />
                <span>Accept the residual risk<span className="block text-[11px] text-slate-400">A legitimate ending, but it has to be a decision on the record.</span></span>
              </label>
              {!!problem.residual_risk_accepted && (
                <input
                  className="input mt-1.5 text-xs"
                  defaultValue={problem.residual_risk_reason || ''}
                  placeholder="Why the risk is acceptable…"
                  onBlur={(e) => { if (e.target.value !== (problem.residual_risk_reason || '')) save({ residual_risk_reason: e.target.value }); }}
                />
              )}
            </div>
          </div>
        </Section>
      </div>

      {blockerPrompt && (
        <Modal title={`Not ready to be ${blockerPrompt.state.replace('_', ' ')}`} onClose={() => setBlockerPrompt(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">This step normally needs:</p>
            <ul className="space-y-1">
              {blockerPrompt.blockers.map((b, i) => (
                <li key={i} className="flex items-start gap-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {b.message}
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-slate-400">
              You can go ahead anyway — it will be recorded on the problem's history as a forced transition.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setBlockerPrompt(null)} className="btn-secondary">Go back</button>
              <button
                onClick={() => { const s = blockerPrompt.state; setBlockerPrompt(null); run(() => api.post(`/problems/${problemId}/state`, { state: s, force: true })); }}
                className="btn-primary"
              ><Check size={14} /> Move it anyway</button>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}
