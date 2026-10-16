import { useCallback, useEffect, useState } from 'react';
import {
  Loader2, AlertTriangle, Plus, CircleCheck, Megaphone, Scale, ListChecks,
  Users2, Clock, X, Check,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import Select from '../Select.jsx';
import SonaTextarea from '../SonaTextarea.jsx';

const ACTION_TONE = {
  open: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  in_progress: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  done: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  abandoned: 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
};

const pretty = (s) => String(s || '').replace(/_/g, ' ');
const time = (v) => (v ? new Date(v.includes?.('T') ? v : `${String(v).replace(' ', 'T')}Z`).toLocaleString() : '—');

function Section({ icon: Icon, title, hint, count, children }) {
  return (
    <section className="rounded-xl border border-slate-200 p-4 dark:border-white/10">
      <div className="mb-2.5">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
          {Icon && <Icon size={14} className="text-slate-400" />} {title}
          {count !== undefined && <span className="font-mono text-xs text-slate-400">{count}</span>}
        </h3>
        {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

// The benchmark clocks from §6.6, each measured from promotion.
function Benchmarks({ benchmarks }) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {Object.entries(benchmarks || {}).map(([key, b]) => {
        const overdue = b.met === null && b.elapsed_minutes > b.target_minutes;
        const tone = b.met === true ? 'text-emerald-600 dark:text-emerald-400'
          : b.met === false || overdue ? 'text-red-600 dark:text-red-400'
            : 'text-slate-500';
        return (
          <div key={key} className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-slate-800/60">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">{b.label}</div>
            <div className={`mt-0.5 flex items-baseline gap-1.5 text-sm font-semibold ${tone}`}>
              {b.at ? `${b.actual_minutes}m` : `${b.elapsed_minutes}m`}
              <span className="text-[10px] font-normal text-slate-400">target {b.target_minutes}m</span>
            </div>
            <div className="mt-0.5 text-[10px] text-slate-400">
              {b.at ? 'done' : overdue ? 'overdue' : 'waiting'}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function CommandConsole({ majorIncident, meta, agents = [], onChanged }) {
  const miId = majorIncident.id;
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState({ action: '', owner_id: '', eta: '' });
  const [decision, setDecision] = useState({ decision: '', options_considered: '', rationale: '' });
  const [comms, setComms] = useState({ audience: 'executives', channel: 'email', message: '' });

  const load = useCallback(async () => {
    try { setData(await api.get(`/major-incidents/${miId}/command`)); setError(''); }
    catch (e) { setError(e.message); }
  }, [miId]);
  useEffect(() => { load(); }, [load]);

  const run = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await load(); onChanged?.(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (!data) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-slate-500">
        {error ? <><AlertTriangle size={15} className="text-amber-500" /> {error}</> : <><Loader2 size={15} className="animate-spin" /> Loading the console…</>}
      </div>
    );
  }

  const agentOptions = [{ value: '', label: 'Unassigned' }, ...agents.map((a) => ({ value: a.id, label: a.name }))];

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          <button onClick={() => setError('')} className="ml-auto shrink-0"><X size={13} /></button>
        </div>
      )}

      <Section icon={Clock} title="Response benchmarks" hint="Measured from the moment it was promoted.">
        <Benchmarks benchmarks={data.benchmarks} />
        {!majorIncident.acknowledged_at && (
          <button onClick={() => run(() => api.post(`/major-incidents/${miId}/acknowledge`, {}))} disabled={busy} className="btn-primary mt-3 text-xs">
            <Check size={13} /> Acknowledge
          </button>
        )}
      </Section>

      <Section icon={Users2} title="Who is running this" hint="During a real outage the person on the bridge and the person briefing the business are not the same.">
        <div className="grid gap-2 sm:grid-cols-2">
          {data.roles.map((r) => (
            <div key={r.key}>
              <label className="label">{r.label}</label>
              <Select
                value={r.user_id || ''}
                onChange={(v) => run(() => api.patch(`/major-incidents/${miId}/roles`, { [r.key]: v || null }))}
                options={agentOptions}
              />
              <p className="mt-0.5 text-[10px] text-slate-400">{r.hint}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        icon={ListChecks}
        title="Actions"
        count={data.open_actions ? `${data.open_actions} open` : undefined}
        hint="What is being done, by whom, and by when — the thing the bridge actually runs on."
      >
        <div className="space-y-1">
          {!data.actions.length && <p className="text-[11px] text-slate-400">Nothing raised yet.</p>}
          {data.actions.map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs dark:bg-slate-800/60">
              <button
                onClick={() => run(() => api.patch(`/major-incidents/actions/${a.id}`, { status: a.status === 'done' ? 'in_progress' : 'done' }))}
                className={a.status === 'done' ? 'text-emerald-500' : 'text-slate-300 hover:text-emerald-500'}
                title={a.status === 'done' ? 'Reopen' : 'Mark done'}
              ><CircleCheck size={14} /></button>
              <span className={`min-w-0 flex-1 truncate ${a.status === 'done' ? 'text-slate-400 line-through' : 'text-slate-700 dark:text-slate-200'}`}>{a.action}</span>
              {a.owner_name && <span className="shrink-0 text-[10px] text-slate-400">{a.owner_name}</span>}
              {a.eta && <span className="shrink-0 text-[10px] text-slate-400">ETA {time(a.eta)}</span>}
              <span className={`badge shrink-0 text-[9px] ${ACTION_TONE[a.status]}`}>{pretty(a.status)}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-[1fr_auto_auto_auto] gap-1.5">
          <input className="input text-xs" value={action.action} onChange={(e) => setAction({ ...action, action: e.target.value })} placeholder="What needs doing…" />
          <Select value={action.owner_id} onChange={(v) => setAction({ ...action, owner_id: v })} options={agentOptions} size="sm" />
          <input type="datetime-local" className="input text-xs" value={action.eta} onChange={(e) => setAction({ ...action, eta: e.target.value })} />
          <button
            onClick={() => action.action.trim() && run(() => api.post(`/major-incidents/${miId}/actions`, action)).then(() => setAction({ action: '', owner_id: '', eta: '' }))}
            disabled={!action.action.trim() || busy}
            className="btn-secondary text-xs disabled:opacity-40"
          ><Plus size={12} /></button>
        </div>
      </Section>

      <Section icon={Scale} title="Decisions" count={data.decisions.length || undefined} hint="What was decided, what else was on the table, and why. The review afterwards is mostly an argument about this.">
        <div className="space-y-1.5">
          {!data.decisions.length && <p className="text-[11px] text-slate-400">Nothing recorded yet.</p>}
          {data.decisions.map((d) => (
            <div key={d.id} className="rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800/60">
              <p className="font-medium text-slate-800 dark:text-slate-100">{d.decision}</p>
              {d.options_considered && <p className="mt-0.5 text-slate-500 dark:text-slate-400">Also considered: {d.options_considered}</p>}
              {d.rationale && <p className="mt-0.5 text-slate-600 dark:text-slate-300">{d.rationale}</p>}
              <p className="mt-1 text-[10px] text-slate-400">{d.decided_by_name || 'Someone'} · {time(d.decided_at)}</p>
            </div>
          ))}
        </div>
        <div className="mt-2 space-y-1.5">
          <input className="input text-xs" value={decision.decision} onChange={(e) => setDecision({ ...decision, decision: e.target.value })} placeholder="What was decided…" />
          <div className="grid gap-1.5 sm:grid-cols-2">
            <input className="input text-xs" value={decision.options_considered} onChange={(e) => setDecision({ ...decision, options_considered: e.target.value })} placeholder="What else was considered" />
            <input className="input text-xs" value={decision.rationale} onChange={(e) => setDecision({ ...decision, rationale: e.target.value })} placeholder="Why this one" />
          </div>
          <button
            onClick={() => decision.decision.trim() && run(() => api.post(`/major-incidents/${miId}/decisions`, decision)).then(() => setDecision({ decision: '', options_considered: '', rationale: '' }))}
            disabled={!decision.decision.trim() || busy}
            className="btn-secondary text-xs disabled:opacity-40"
          ><Plus size={12} /> Record decision</button>
        </div>
      </Section>

      <Section icon={Megaphone} title="Communications" count={data.comms.length || undefined} hint="Who was told what, through which channel. Distinct from the running technical timeline.">
        <div className="max-h-52 space-y-1.5 overflow-y-auto">
          {!data.comms.length && <p className="text-[11px] text-slate-400">Nobody has been briefed yet.</p>}
          {data.comms.map((c) => (
            <div key={c.id} className="rounded-lg bg-slate-50 px-3 py-2 text-xs dark:bg-slate-800/60">
              <div className="flex items-center gap-1.5">
                <span className="badge bg-slate-200 text-[9px] dark:bg-slate-700">{pretty(c.audience)}</span>
                <span className="text-[10px] text-slate-400">via {pretty(c.channel)}</span>
                <span className="ml-auto text-[10px] text-slate-400">{time(c.sent_at)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-slate-700 dark:text-slate-200">{c.message}</p>
              <p className="mt-0.5 text-[10px] text-slate-400">{c.sent_by_name || 'Someone'}</p>
            </div>
          ))}
        </div>
        <div className="mt-2 space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <Select value={comms.audience} onChange={(v) => setComms({ ...comms, audience: v })}
              options={(meta?.audiences || []).map((a) => ({ value: a, label: pretty(a) }))} />
            <Select value={comms.channel} onChange={(v) => setComms({ ...comms, channel: v })}
              options={(meta?.channels || []).map((c) => ({ value: c, label: pretty(c) }))} />
          </div>
          <SonaTextarea purpose="Major incident communication" className="input min-h-[52px] text-xs" value={comms.message} onChange={(e) => setComms({ ...comms, message: e.target.value })} placeholder="What was said…" />
          <button
            onClick={() => comms.message.trim() && run(() => api.post(`/major-incidents/${miId}/comms`, comms)).then(() => setComms({ ...comms, message: '' }))}
            disabled={!comms.message.trim() || busy}
            className="btn-secondary text-xs disabled:opacity-40"
          ><Megaphone size={12} /> Log the update</button>
        </div>
      </Section>
    </div>
  );
}
