import { useEffect, useState } from 'react';
import {
  Loader2, ShieldCheck, GitBranch, CalendarClock, AlertTriangle, CheckCircle2, XCircle,
  Sparkles, Lock, Play, Undo2, RotateCcw, ClipboardCheck, Gauge, Users, Snowflake,
  ChevronRight, ChevronDown, Info, FileText, History,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative } from '../../lib/dates.js';
import Select from '../Select.jsx';
import Modal from '../Modal.jsx';

const BAND_STYLES = {
  low: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  medium: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  high: 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300',
  critical: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
};

const STATE_STYLES = {
  new: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  in_review: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  pending_approval: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  approved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  scheduled: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
  in_progress: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300',
  implemented: 'bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-300',
  rolled_back: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  closed: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  reopened: 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300',
};

const TYPE_STYLES = {
  standard: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  normal: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  emergency: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  expedite: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
};

const PIPELINE = ['new', 'in_review', 'pending_approval', 'approved', 'scheduled', 'in_progress', 'implemented', 'closed'];

function Section({ icon: Icon, title, children, action, defaultOpen = true, badge }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-2xl border border-slate-200 dark:border-white/10">
      <div className="flex items-center gap-2 p-3">
        <button onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown size={14} className="shrink-0 text-slate-400" /> : <ChevronRight size={14} className="shrink-0 text-slate-400" />}
          <Icon size={15} className="shrink-0 text-slate-500" />
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</span>
          {badge}
        </button>
        {action}
      </div>
      {open && <div className="border-t border-slate-100 p-3 dark:border-white/5">{children}</div>}
    </div>
  );
}

// The pipeline ribbon: where the change is, and what it has passed through.
function StateRibbon({ state, states }) {
  const currentIndex = PIPELINE.indexOf(state);
  const offPipeline = currentIndex === -1;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {PIPELINE.map((key, i) => {
          const done = !offPipeline && i < currentIndex;
          const active = key === state;
          return (
            <div key={key} className="flex items-center gap-1">
              <span className={`rounded-lg px-2 py-1 text-[11px] font-medium transition-colors ${
                active ? 'bg-brand-600 text-white'
                  : done ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500'
              }`}>
                {states[key]?.label || key}
              </span>
              {i < PIPELINE.length - 1 && <ChevronRight size={11} className="text-slate-300 dark:text-slate-600" />}
            </div>
          );
        })}
      </div>
      {offPipeline && (
        <p className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs font-medium ${STATE_STYLES[state]}`}>
          <AlertTriangle size={11} /> {states[state]?.label} — off the normal path
        </p>
      )}
    </div>
  );
}

function ScheduleModal({ change, onClose, onScheduled }) {
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const planned = change.ticket.planned_start ? new Date(change.ticket.planned_start) : new Date(Date.now() + 86400000);
  const plannedEnd = change.ticket.planned_end ? new Date(change.ticket.planned_end) : new Date(planned.getTime() + 3600000);

  const [start, setStart] = useState(local(planned));
  const [end, setEnd] = useState(local(plannedEnd));
  const [overrideReason, setOverrideReason] = useState('');
  const [verdict, setVerdict] = useState(null);
  const [alternates, setAlternates] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const checkWindow = async () => {
    setBusy(true); setError(''); setVerdict(null);
    try {
      const result = await api.post(`/changes/${change.ticket.id}/check-window`, {
        start: new Date(start).toISOString(), end: new Date(end).toISOString(),
      });
      setVerdict(result);
      setAlternates(result.alternates || []);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  useEffect(() => { checkWindow(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/changes/${change.ticket.id}/schedule`, {
        start: new Date(start).toISOString(), end: new Date(end).toISOString(),
        override_reason: overrideReason || undefined,
      });
      onScheduled();
    } catch (e) {
      setError(e.message);
      await checkWindow();
    } finally { setBusy(false); }
  };

  return (
    <Modal title="Schedule the implementation window" onClose={onClose} maxWidth="max-w-xl">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Start</label>
            <input type="datetime-local" className="input" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className="label">End</label>
            <input type="datetime-local" className="input" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <button onClick={checkWindow} disabled={busy} className="btn-secondary text-xs">
          {busy ? <Loader2 size={12} className="animate-spin" /> : <CalendarClock size={12} />} Check this window
        </button>

        {verdict && (
          <div className={`space-y-2 rounded-xl p-3 text-xs ${
            verdict.ok
              ? verdict.requiresOverride
                ? 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'
                : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200'
              : 'bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-200'
          }`}>
            <p className="flex items-start gap-1.5 font-medium">
              {verdict.ok ? <CheckCircle2 size={13} className="mt-0.5 shrink-0" /> : <XCircle size={13} className="mt-0.5 shrink-0" />}
              {verdict.ok
                ? (verdict.requiresOverride ? verdict.reason : 'This window is clear.')
                : verdict.reason}
            </p>
            {verdict.freezes?.length > 0 && (
              <p className="flex items-start gap-1.5"><Snowflake size={12} className="mt-0.5 shrink-0" />
                Freeze: {verdict.freezes.map((f) => f.name).join(', ')}
              </p>
            )}
            {verdict.conflicts?.length > 0 && (
              <ul className="space-y-0.5">
                {verdict.conflicts.map((c) => (
                  <li key={c.ticket_id}>
                    {c.severity === 'blocking' ? '⛔' : '⚠'} {c.number} — {c.title}
                    {c.shared_ci_count > 0 ? ` (shares ${c.shared_ci_count} CI)` : ' (same window, different CIs)'}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {alternates.length > 0 && (
          <div>
            <label className="label">Suggested alternatives</label>
            <div className="space-y-1">
              {alternates.map((a) => (
                <button
                  key={a.start_at} type="button"
                  onClick={() => { setStart(local(new Date(a.start_at))); setEnd(local(new Date(a.end_at))); setVerdict(null); }}
                  className="btn-secondary w-full justify-start text-xs"
                >
                  <CalendarClock size={12} /> {fmtDateTime(a.start_at)} → {fmtDateTime(a.end_at)}
                </button>
              ))}
            </div>
          </div>
        )}

        {verdict?.requiresOverride && (
          <div>
            <label className="label">Freeze override reason <span className="text-red-500">*</span></label>
            <input
              className="input" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)}
              placeholder="Sev1 outage — authorised by the CTO"
            />
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
              This is recorded against the change and counted as a freeze violation in the metrics.
            </p>
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={submit}
            disabled={busy || (verdict && !verdict.ok) || (verdict?.requiresOverride && !overrideReason.trim())}
            className="btn-primary"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null} Reserve window
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PirPanel({ change, onChanged }) {
  const pir = change.pir;
  const [draft, setDraft] = useState(() => ({
    outcome: pir?.outcome || '',
    met_objectives: pir?.met_objectives ?? null,
    caused_incident: pir?.caused_incident ?? false,
    lessons_learned: pir?.lessons_learned || '',
    follow_up_actions: pir?.follow_up_actions || '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft({
      outcome: pir?.outcome || '',
      met_objectives: pir?.met_objectives ?? null,
      caused_incident: pir?.caused_incident ?? false,
      lessons_learned: pir?.lessons_learned || '',
      follow_up_actions: pir?.follow_up_actions || '',
    });
  }, [pir?.id, pir?.completed_at]);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); onChanged(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (!pir) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {change.pir_required
            ? 'A post-implementation review is required for this change and will open when implementation finishes.'
            : 'No review is required for this change type at this risk band.'}
        </p>
        {['implemented', 'rolled_back'].includes(change.state) && (
          <button onClick={() => run(() => api.post(`/changes/${change.ticket.id}/pir`, {}))} disabled={busy} className="btn-secondary text-xs">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <ClipboardCheck size={12} />} Open a review
          </button>
        )}
      </div>
    );
  }

  const complete = !!pir.completed_at;

  return (
    <div className="space-y-3">
      {complete && (
        <p className="flex items-center gap-1.5 rounded-xl bg-emerald-50 px-2.5 py-1.5 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-200">
          <CheckCircle2 size={12} /> Completed {fmtRelative(pir.completed_at)}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Outcome</label>
          <Select
            disabled={complete}
            value={draft.outcome}
            onChange={(v) => setDraft((d) => ({ ...d, outcome: v }))}
            options={[
              { value: '', label: 'Choose…' },
              { value: 'successful', label: 'Successful' },
              { value: 'successful_with_issues', label: 'Successful, with issues' },
              { value: 'failed', label: 'Failed' },
              { value: 'rolled_back', label: 'Rolled back' },
            ]}
          />
        </div>
        <div className="space-y-2 pt-5">
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" disabled={complete} checked={draft.met_objectives === true}
              onChange={(e) => setDraft((d) => ({ ...d, met_objectives: e.target.checked }))} />
            Met its objectives
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" disabled={complete} checked={!!draft.caused_incident}
              onChange={(e) => setDraft((d) => ({ ...d, caused_incident: e.target.checked }))} />
            Caused an incident
          </label>
        </div>
      </div>
      <div>
        <label className="label">What was learned <span className="text-red-500">*</span></label>
        <textarea
          className="input min-h-[60px]" disabled={complete} value={draft.lessons_learned}
          onChange={(e) => setDraft((d) => ({ ...d, lessons_learned: e.target.value }))}
          placeholder="What would you do differently next time?"
        />
      </div>
      <div>
        <label className="label">Follow-up actions</label>
        <textarea
          className="input min-h-[50px]" disabled={complete} value={draft.follow_up_actions}
          onChange={(e) => setDraft((d) => ({ ...d, follow_up_actions: e.target.value }))}
        />
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {!complete && (
        <div className="flex gap-2">
          <button onClick={() => run(() => api.patch(`/changes/${change.ticket.id}/pir`, draft))} disabled={busy} className="btn-secondary text-xs">
            {busy ? <Loader2 size={12} className="animate-spin" /> : null} Save draft
          </button>
          <button
            onClick={() => run(async () => {
              await api.patch(`/changes/${change.ticket.id}/pir`, draft);
              await api.post(`/changes/${change.ticket.id}/pir/complete`, {});
            })}
            disabled={busy || !draft.outcome || !draft.lessons_learned.trim()}
            className="btn-primary text-xs"
          >
            <ClipboardCheck size={12} /> Complete review
          </button>
        </div>
      )}
    </div>
  );
}

// Classification is the step that sets the change type and scores its risk.
// Nothing downstream can proceed without it -- "Send for approval" is gated
// on a risk band existing -- so an unclassified change needs this offered
// prominently rather than buried.
function ClassifyModal({ change, onClose, onDone }) {
  const [types, setTypes] = useState([]);
  const [changeType, setChangeType] = useState(change.ticket.change_type || 'normal');
  const [aiReview, setAiReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.get('/changes/meta').then((d) => setTypes(d.change_types || [])).catch(() => setTypes([]));
  }, []);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const resp = await api.post(`/changes/${change.ticket.id}/classify`, { change_type: changeType, ai_review: aiReview });
      setResult(resp);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  if (result) {
    return (
      <Modal title="Classified" onClose={() => onDone()} maxWidth="max-w-lg">
        <div className="space-y-3">
          <div className={`rounded-xl p-3 text-sm ${
            result.risk?.band === 'critical' || result.risk?.band === 'high'
              ? 'bg-orange-50 text-orange-900 dark:bg-orange-500/10 dark:text-orange-200'
              : 'bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200'
          }`}>
            <p className="font-medium">
              Classified as {result.ticket.change_type} · risk {result.risk?.band} ({result.risk?.score})
            </p>
            {result.routed_as_normal && (
              <p className="mt-1 text-xs">
                No standard change template matched, so this was routed as a <strong>Normal</strong> change and will need CAB approval.
              </p>
            )}
            {result.matched_template && (
              <p className="mt-1 text-xs">
                Matched the template <strong>{result.matched_template.name}</strong> — it will auto-approve when you submit it.
              </p>
            )}
          </div>

          {result.risk?.contributions?.length > 0 && (
            <div>
              <p className="label">What drove the score</p>
              <ul className="space-y-0.5">
                {result.risk.contributions.map((c, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-700 dark:text-slate-200">{c.rule}</span>
                    <span className="font-mono text-slate-500">{c.points >= 0 ? '+' : ''}{c.points}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end">
            <button onClick={() => onDone()} className="btn-primary">Done</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Classify this change" onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Sets the change type and scores its risk. Risk decides which approvals apply, so nothing can move forward until this is done.
        </p>
        <div>
          <label className="label">Change type</label>
          <div className="space-y-1.5">
            {types.map((t) => (
              <button
                key={t.key} type="button" onClick={() => setChangeType(t.key)}
                className={`w-full rounded-xl border p-2.5 text-left transition-colors ${
                  changeType === t.key
                    ? 'border-brand-500 bg-brand-50/60 dark:border-brand-400 dark:bg-brand-500/10'
                    : 'border-slate-200 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-slate-800/50'
                }`}
              >
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{t.label}</span>
                  {t.approval_sla_hours && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{t.approval_sla_hours}h SLA</span>}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 dark:text-slate-400">{t.description}</span>
              </button>
            ))}
          </div>
          {changeType === 'standard' && (
            <p className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
              A Standard change must match a pre-approved template. If none matches, it is routed as Normal automatically.
            </p>
          )}
        </div>

        <button type="button" onClick={() => setAiReview((v) => !v)} className="flex items-start gap-2 text-left">
          {aiReview ? <Sparkles size={16} className="mt-0.5 shrink-0 text-brand-600" /> : <Sparkles size={16} className="mt-0.5 shrink-0 text-slate-400" />}
          <span>
            <span className="block text-xs font-medium text-slate-700 dark:text-slate-200">Also ask Sona to review the plans</span>
            <span className="text-[11px] text-slate-500 dark:text-slate-400">Flags gaps in the implementation and backout plans for approvers. Advisory only — it never changes the risk score.</span>
          </span>
        </button>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={submit} disabled={busy} className="btn-primary">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Gauge size={14} />} Classify & score risk
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default function ChangeWorkflowPanel({ ticketId, isAgent, onTicketChanged }) {
  const [change, setChange] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [showSchedule, setShowSchedule] = useState(false);
  const [showClassify, setShowClassify] = useState(false);
  const [reasonPrompt, setReasonPrompt] = useState(null); // { action, label }
  const [reason, setReason] = useState('');

  const load = async () => {
    setError('');
    try {
      setChange(await api.get(`/changes/${ticketId}`));
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ticketId]);

  const act = async (path, body = {}, key = path) => {
    setBusy(key); setError('');
    try {
      await api.post(`/changes/${ticketId}/${path}`, body);
      await load();
      onTicketChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  if (error && !change) {
    return (
      <div className="card p-4 text-sm">
        <p className="text-red-600 dark:text-red-400">{error}</p>
        <button onClick={load} className="btn-secondary mt-2 text-xs">Retry</button>
      </div>
    );
  }
  if (!change) {
    return <div className="card flex items-center gap-2 p-4 text-sm text-slate-400"><Loader2 size={14} className="animate-spin" /> Loading change workflow…</div>;
  }

  const { ticket, state, states, transitions, risk, approvals, schedule, freezes, evidence, tasks } = change;
  const openTasks = tasks.filter((t) => t.status !== 'done').length;
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  // A change is classified once it has both a type and a scored risk band --
  // that pair is exactly what guardClassified checks server-side.
  const isClassified = !!ticket.change_type && !!ticket.risk_band;
  // Internal edges (the standard-change auto-approve step) are driven by the
  // submit handler, never clicked.
  const actionableTransitions = transitions.filter((t) => !t.internal);

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <GitBranch size={15} className="text-teal-600" /> Change workflow
        </h3>
        <div className="flex flex-wrap items-center gap-1.5">
          {ticket.change_type && (
            <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 capitalize">{ticket.change_type}</span>
          )}
          {risk?.band && (
            <span className={`badge ${BAND_STYLES[risk.band]}`}><Gauge size={10} /> {risk.band} risk · {risk.score}</span>
          )}
          <span className={`badge ${STATE_STYLES[state]}`}>{states[state]?.label}</span>
        </div>
      </div>

      <StateRibbon state={state} states={states} />

      {/* Change type and risk, always visible and always re-runnable.
          These were only reachable while a change was *unclassified* (the
          banner below) or from inside the collapsed Risk section, so once a
          change had been classified once there was no obvious way to change
          its type -- and the type cannot be edited as a plain field, because
          changing it has to re-match the template and re-score the risk. */}
      {isClassified && state !== 'closed' && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 dark:border-white/10">
          <span className="text-xs text-slate-500 dark:text-slate-400">Change type</span>
          <span className={`badge capitalize ${TYPE_STYLES[ticket.change_type] || 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
            {ticket.change_type}
          </span>
          {change.template && (
            <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
              template: {change.template.name}
            </span>
          )}
          {ticket.change_type === 'normal' && !change.template && (
            <span className="text-[11px] text-slate-400">no standard template matched</span>
          )}
          {isAgent && (
            <button onClick={() => setShowClassify(true)} className="btn-secondary ml-auto shrink-0 text-xs">
              <Gauge size={12} /> Change type &amp; re-score
            </button>
          )}
        </div>
      )}

      {/* Classification gates everything else, so an unclassified change
          gets a call to action rather than a row of blocked buttons whose
          only explanation is "Risk has not been assessed yet". */}
      {isAgent && !isClassified && !['closed'].includes(state) && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-brand-50 px-3 py-2.5 dark:bg-brand-500/10">
          <Gauge size={15} className="shrink-0 text-brand-600 dark:text-brand-400" />
          <span className="flex-1 text-xs text-brand-900 dark:text-brand-100">
            This change has not been classified yet. Set its type and score its risk — everything after this is gated on it.
          </span>
          <button onClick={() => setShowClassify(true)} className="btn-primary shrink-0 text-xs">
            Classify & score risk
          </button>
        </div>
      )}

      {/* Available actions, each explaining itself when blocked. */}
      {isAgent && actionableTransitions.length > 0 && (
        <div className="space-y-1.5">
          {actionableTransitions.map((t) => {
            const isSchedule = t.to === 'scheduled';
            const needsReason = ['rolled_back', 'reopened'].includes(t.to);
            return (
              <div key={t.to}>
                <button
                  onClick={() => {
                    if (isSchedule) { setShowSchedule(true); return; }
                    if (needsReason) { setReasonPrompt({ to: t.to, label: t.label }); setReason(''); return; }
                    // Each edge maps to its own named, agent-level endpoint.
                    // `transition` is the change manager's override and is
                    // only the fallback for edges with no dedicated step.
                    const path = t.to === 'in_review' ? 'review'
                      : t.to === 'pending_approval' ? 'submit-for-approval'
                        : t.to === 'in_progress' ? 'start'
                          : t.to === 'implemented' ? 'complete'
                            : t.to === 'closed' ? 'close'
                              : t.to === 'new' ? 'return'
                                : t.to === 'approved' && state === 'scheduled' ? 'release-schedule'
                                  : 'transition';
                    act(path, path === 'transition' ? { to: t.to } : {}, t.to);
                  }}
                  disabled={!t.allowed || busy === t.to}
                  className={`w-full justify-start text-xs ${t.allowed ? 'btn-primary' : 'btn-secondary opacity-70'}`}
                  title={t.allowed ? t.label : t.blockers.join(' · ')}
                >
                  {busy === t.to ? <Loader2 size={12} className="animate-spin" />
                    : t.to === 'in_progress' ? <Play size={12} />
                      : t.to === 'rolled_back' ? <Undo2 size={12} />
                        : t.to === 'reopened' ? <RotateCcw size={12} />
                          : t.allowed ? <ChevronRight size={12} /> : <Lock size={12} />}
                  {t.label}
                </button>
                {/* The "why is this blocked?" the plan called for. */}
                {!t.allowed && t.blockers.length > 0 && (
                  <ul className="mt-1 space-y-0.5 pl-5">
                    {t.blockers.map((b, i) => (
                      <li key={i} className="flex flex-wrap items-start gap-1 text-[11px] text-amber-700 dark:text-amber-300">
                        <Info size={10} className="mt-0.5 shrink-0" />
                        <span>{b}</span>
                        {/* Each blocker names the thing that clears it, so a
                            disabled button is never a dead end. */}
                        {/[Rr]isk has not been assessed/.test(b) && (
                          <button onClick={() => setShowClassify(true)} className="font-medium underline underline-offset-2">Classify now</button>
                        )}
                        {/categorized|change type/i.test(b) && (
                          <button onClick={() => setShowClassify(true)} className="font-medium underline underline-offset-2">Classify now</button>
                        )}
                        {/No implementation window|calendar slot/i.test(b) && (
                          <button onClick={() => setShowSchedule(true)} className="font-medium underline underline-offset-2">Schedule now</button>
                        )}
                        {/backout plan/i.test(b) && (
                          <span className="text-slate-500 dark:text-slate-400">— add one in Change details above.</span>
                        )}
                        {/implementation task/i.test(b) && (
                          <span className="text-slate-500 dark:text-slate-400">— finish them in the Tasks panel.</span>
                        )}
                        {/No approval has been recorded/.test(b) && (
                          <span className="text-slate-500 dark:text-slate-400">— use “Send for approval” to route it.</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {isAgent && state === 'implemented' && !ticket.closure_approved_by && (
        <button onClick={() => act('approve-closure', {}, 'closure')} disabled={busy === 'closure'} className="btn-secondary w-full justify-start text-xs">
          {busy === 'closure' ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />} Approve closure (change manager)
        </button>
      )}

      {error && <p className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}

      {/* Risk breakdown */}
      {risk && (
        <Section icon={Gauge} title="Risk assessment" defaultOpen
          badge={<span className={`badge ${BAND_STYLES[risk.band]}`}>{risk.band} · {risk.score}</span>}>
          <div className="space-y-2">
            {risk.contributions.length === 0 ? (
              <p className="text-xs text-slate-400">No scoring rule matched this change.</p>
            ) : (
              <ul className="space-y-1">
                {risk.contributions.map((c, i) => (
                  <li key={i} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-700 dark:text-slate-200">{c.rule}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      <code className="text-[10px] text-slate-400">{c.signal} = {String(c.signal_value)}</code>
                      <span className={`font-mono ${c.points >= 0 ? 'text-orange-600 dark:text-orange-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {c.points >= 0 ? '+' : ''}{c.points}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {risk.advisory?.length > 0 && (
              <div className="rounded-xl bg-brand-50 p-2.5 dark:bg-brand-500/10">
                <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-brand-800 dark:text-brand-200">
                  <Sparkles size={11} /> Sona&apos;s review of the plans (advisory)
                </p>
                <ul className="space-y-1">
                  {risk.advisory.map((f, i) => (
                    <li key={i} className="text-[11px] text-brand-900 dark:text-brand-100">
                      <span className="font-medium capitalize">{f.area}</span> — {f.message}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[10px] text-brand-700 dark:text-brand-300">Advice only — it does not affect the risk score or routing.</p>
              </div>
            )}
            {isAgent && (
              <button onClick={() => setShowClassify(true)} className="btn-secondary text-xs">
                <Gauge size={12} /> Re-classify &amp; re-score
              </button>
            )}
          </div>
        </Section>
      )}

      {/* Approvals */}
      <Section icon={Users} title="Approvals" defaultOpen={pendingApprovals.length > 0}
        badge={<span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{approvals.length}</span>}>
        {approvals.length === 0 ? (
          <p className="text-xs text-slate-400">No approvals yet — submit the change for approval to route it.</p>
        ) : (
          <ul className="space-y-1.5">
            {approvals.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs dark:border-white/10">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-slate-100 text-[10px] font-bold text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {a.step_order}
                </span>
                <span className="font-medium text-slate-800 dark:text-slate-100">{a.approver_name || a.approver_type?.replace(/_/g, ' ') || 'Approver'}</span>
                <span className={`badge ${
                  a.status === 'approved' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : a.status === 'rejected' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                      : a.status === 'not_required' ? 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                        : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
                }`}>{a.status.replace(/_/g, ' ')}</span>
                {a.sla_breached ? <span className="badge bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"><AlertTriangle size={9} /> SLA breached</span> : null}
                {a.sla_due_at && a.status === 'pending' && <span className="text-slate-400">due {fmtRelative(a.sla_due_at)}</span>}
                {a.conditions && <span className="w-full text-amber-700 dark:text-amber-300">Conditions: {a.conditions}</span>}
                {a.comments && <span className="w-full text-slate-500 dark:text-slate-400">{a.comments}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Schedule */}
      <Section icon={CalendarClock} title="Implementation window" defaultOpen={!!ticket.scheduled_start}>
        <div className="space-y-2 text-xs">
          {ticket.scheduled_start ? (
            <>
              <p className="text-slate-700 dark:text-slate-200">
                {fmtDateTime(ticket.scheduled_start)} → {fmtDateTime(ticket.scheduled_end)}
              </p>
              {ticket.freeze_override_reason && (
                <p className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2 py-1.5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                  <Snowflake size={11} className="mt-0.5 shrink-0" /> Freeze overridden: {ticket.freeze_override_reason}
                </p>
              )}
              {schedule && !schedule.ok && (
                <p className="flex items-start gap-1.5 rounded-lg bg-red-50 px-2 py-1.5 text-red-800 dark:bg-red-500/10 dark:text-red-200">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {schedule.reason}
                </p>
              )}
              {schedule?.conflicts?.length > 0 && (
                <ul className="space-y-0.5 text-slate-500 dark:text-slate-400">
                  {schedule.conflicts.map((c) => (
                    <li key={c.ticket_id}>{c.severity === 'blocking' ? '⛔' : '⚠'} overlaps {c.number}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="text-slate-400">
              Not scheduled.{ticket.planned_start ? ` Requested window: ${fmtDateTime(ticket.planned_start)} → ${fmtDateTime(ticket.planned_end)}.` : ''}
            </p>
          )}
          {freezes.length > 0 && (
            <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
              <Snowflake size={11} /> Inside: {freezes.map((f) => f.name).join(', ')}
            </p>
          )}
          {isAgent && ['approved', 'scheduled', 'reopened'].includes(state) && (
            <button onClick={() => setShowSchedule(true)} className="btn-secondary text-xs">
              <CalendarClock size={12} /> {ticket.scheduled_start ? 'Re-schedule' : 'Schedule'}
            </button>
          )}
        </div>
      </Section>

      {/* Implementation */}
      {['scheduled', 'in_progress', 'implemented', 'rolled_back', 'reopened', 'closed'].includes(state) && (
        <Section icon={FileText} title="Implementation" defaultOpen={state === 'in_progress'}
          badge={openTasks > 0 ? <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{openTasks} open task(s)</span> : null}>
          <div className="space-y-2 text-xs">
            {ticket.actual_start && <p className="text-slate-500 dark:text-slate-400">Started {fmtDateTime(ticket.actual_start)}</p>}
            {ticket.actual_end && <p className="text-slate-500 dark:text-slate-400">Finished {fmtDateTime(ticket.actual_end)}</p>}
            <p className="text-slate-600 dark:text-slate-300">
              {evidence.length} evidence file(s) captured.
              {evidence.length === 0 && ' Attach logs or screenshots to the ticket and mark them as evidence.'}
            </p>
            {tasks.length === 0 && <p className="text-slate-400">No implementation tasks — add them in the Tasks panel to gate completion.</p>}
          </div>
        </Section>
      )}

      {/* PIR */}
      {(change.pir || change.pir_required || ['implemented', 'rolled_back', 'closed'].includes(state)) && (
        <Section icon={ClipboardCheck} title="Post-implementation review" defaultOpen={['implemented', 'rolled_back'].includes(state)}
          badge={change.pir?.completed_at
            ? <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">complete</span>
            : change.pir_required ? <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">required</span> : null}>
          <PirPanel change={change} onChanged={() => { load(); onTicketChanged?.(); }} />
        </Section>
      )}

      {/* Audit */}
      <Section icon={History} title="State history" defaultOpen={false}
        badge={<span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{change.history.length}</span>}>
        {change.history.length === 0 ? (
          <p className="text-xs text-slate-400">No transitions recorded yet.</p>
        ) : (
          <ul className="space-y-1">
            {change.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-1.5 text-[11px]">
                <span className="text-slate-400">{states[h.from_state]?.label || h.from_state || '—'}</span>
                <ChevronRight size={9} className="text-slate-300" />
                <span className="font-medium text-slate-700 dark:text-slate-200">{states[h.to_state]?.label || h.to_state}</span>
                {h.actor_name && <span className="text-slate-400">by {h.actor_name}</span>}
                {h.guards?.forced && <span className="badge bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300">forced</span>}
                <span className="ml-auto text-slate-400">{fmtRelative(h.created_at)}</span>
                {h.reason && <span className="w-full text-slate-500 dark:text-slate-400">{h.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {showSchedule && (
        <ScheduleModal
          change={change}
          onClose={() => setShowSchedule(false)}
          onScheduled={() => { setShowSchedule(false); load(); onTicketChanged?.(); }}
        />
      )}

      {showClassify && (
        <ClassifyModal
          change={change}
          onClose={() => setShowClassify(false)}
          onDone={() => { setShowClassify(false); load(); onTicketChanged?.(); }}
        />
      )}

      {reasonPrompt && (
        <Modal title={reasonPrompt.label} onClose={() => setReasonPrompt(null)}>
          <div className="space-y-3">
            <div>
              <label className="label">Reason <span className="text-red-500">*</span></label>
              <textarea
                className="input min-h-[70px]" value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder={reasonPrompt.to === 'rolled_back' ? 'Why was the backout executed?' : 'Why is this being reopened?'}
              />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setReasonPrompt(null)} className="btn-secondary">Cancel</button>
              <button
                onClick={async () => {
                  const path = reasonPrompt.to === 'rolled_back' ? 'rollback' : 'reopen';
                  setReasonPrompt(null);
                  await act(path, { reason }, reasonPrompt.to);
                }}
                disabled={!reason.trim()}
                className="btn-primary"
              >
                Confirm
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
