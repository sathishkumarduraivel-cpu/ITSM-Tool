import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Plus, Search, Sparkles, ShieldAlert, TrendingUp, RefreshCw, X, Check,
  AlertTriangle, Loader2, Link2, ListChecks,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { PriorityBadge, StatusBadge } from '../components/Badge.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import NewTicketModal from '../components/NewTicketModal.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Select from '../components/Select.jsx';
import ProblemWorkspace from '../components/problems/ProblemWorkspace.jsx';
import ViewBar from '../components/views/ViewBar.jsx';

const STATUSES = ['open', 'in_progress', 'on_hold', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

const TABS = [
  { key: 'problems', label: 'Problems', icon: ListChecks },
  { key: 'candidates', label: 'Suggested', icon: Sparkles },
  { key: 'known', label: 'Known errors', icon: ShieldAlert },
  { key: 'trends', label: 'Trends', icon: TrendingUp },
];

// ---- suggested problems --------------------------------------------------

function Candidates({ onOpened }) {
  const [candidates, setCandidates] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setCandidates((await api.get('/problems/candidates')).candidates); }
    catch (e) { setError(e.message); setCandidates([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const rescan = async () => {
    setBusy(true); setError('');
    try { setCandidates((await api.post('/problems/candidates/refresh', {})).candidates); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const act = async (id, what) => {
    setBusy(true); setError('');
    try {
      if (what === 'dismiss') setCandidates((await api.post(`/problems/candidates/${id}/dismiss`, {})).candidates);
      else {
        const { problem } = await api.post(`/problems/candidates/${id}/promote`, {});
        await load();
        onOpened(problem.id);
      }
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  if (candidates === null) return <SkeletonRows count={3} />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="max-w-2xl text-xs text-slate-500 dark:text-slate-400">
          Incidents that keep coming back with something in common, which nobody has raised a problem for. The
          hard part of problem management is noticing the pattern — each incident is handled, closed, and looks
          like a one-off to whoever took it.
        </p>
        <button onClick={rescan} disabled={busy} className="btn-secondary shrink-0 text-xs">
          <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> Scan again
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {!candidates.length ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing recurring right now"
          description="No cluster of incidents has crossed the threshold. Scan again after a busy week, or once more incidents have been categorised."
          action={<button onClick={rescan} className="btn-secondary"><RefreshCw size={14} /> Scan again</button>}
        />
      ) : candidates.map((c) => (
        <div key={c.id} className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-display font-semibold text-slate-800 dark:text-slate-100">{c.label}</h3>
                <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {c.basis === 'asset' ? 'same CI' : `same ${c.basis}`}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                <strong className="tabular-nums text-slate-700 dark:text-slate-200">{c.incident_count}</strong> incidents
                between {String(c.first_seen || '').slice(0, 10)} and {String(c.last_seen || '').slice(0, 10)}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button onClick={() => act(c.id, 'dismiss')} disabled={busy} className="btn-secondary text-xs"><X size={13} /> Not a problem</button>
              <button onClick={() => act(c.id, 'promote')} disabled={busy} className="btn-primary text-xs"><Check size={13} /> Raise a problem</button>
            </div>
          </div>
          {!!c.incidents?.length && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {c.incidents.slice(0, 8).map((i) => (
                <span key={i.id} className="rounded-md bg-slate-50 px-2 py-1 text-[11px] text-slate-600 dark:bg-slate-800/60 dark:text-slate-300" title={i.title}>
                  <span className="font-mono text-[10px] text-slate-400">{i.number}</span> {i.title.slice(0, 44)}{i.title.length > 44 ? '…' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ---- known error register ------------------------------------------------

function KnownErrors({ onOpen }) {
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    api.get(`/problems/known-errors${q ? `?q=${encodeURIComponent(q)}` : ''}`)
      .then((d) => setRows(d.known_errors)).catch(() => setRows([]));
  }, [q]);

  if (rows === null) return <SkeletonRows count={3} />;

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input className="input pl-9" placeholder="Search workarounds…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!rows.length ? (
        <EmptyState
          icon={ShieldAlert}
          title="No known errors yet"
          description="When a problem's cause is understood but the permanent fix is still to come, publish the workaround here so the service desk can use it mid-call."
        />
      ) : rows.map((r) => (
        <button key={r.id} onClick={() => onOpen(r.id)} className="card w-full p-4 text-left transition-shadow hover:shadow-popover dark:hover:shadow-popover-dark">
          <div className="flex items-start justify-between gap-3">
            <h3 className="font-display font-semibold text-slate-800 dark:text-slate-100">{r.title}</h3>
            <span className="shrink-0 font-mono text-[10px] text-slate-400">{r.number}</span>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{r.workaround}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            {r.root_cause_category && <span className="badge bg-slate-100 dark:bg-slate-800">{r.root_cause_category.replace(/_/g, ' ')}</span>}
            <span>{r.incident_count} incident{r.incident_count === 1 ? '' : 's'} explained</span>
          </div>
        </button>
      ))}
    </div>
  );
}

// ---- trends --------------------------------------------------------------

function Trends() {
  const [t, setT] = useState(null);
  useEffect(() => { api.get('/problems/trends').then(setT).catch(() => setT(null)); }, []);
  if (!t) return <SkeletonRows count={4} />;

  const Stat = ({ label, value, hint }) => (
    <div className="card p-4">
      <div className="font-display text-2xl font-semibold tabular-nums text-slate-800 dark:text-slate-100">{value}</div>
      <div className="mt-0.5 text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      {hint && <p className="mt-1 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Problems" value={t.counts.total} />
        <Stat label="Still open" value={t.counts.open} />
        <Stat label="Known errors" value={t.counts.known_errors} hint="with a published workaround" />
        <Stat
          label="Incidents explained"
          value={t.coverage.percent === null ? '—' : `${t.coverage.percent}%`}
          hint={`${t.coverage.explained} of ${t.coverage.incidents} in ${t.days} days`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Where the causes lie</h3>
          {!t.by_root_cause.length ? <p className="text-xs text-slate-400">Nothing analysed yet.</p> : (
            <div className="space-y-1.5">
              {t.by_root_cause.map((r) => {
                const max = Math.max(...t.by_root_cause.map((x) => x.n), 1);
                return (
                  <div key={r.category} className="flex items-center gap-2 text-xs">
                    <span className="w-40 shrink-0 truncate text-slate-600 dark:text-slate-300">{r.category.replace(/_/g, ' ')}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${(r.n / max) * 100}%` }} />
                    </div>
                    <span className="w-6 shrink-0 text-right tabular-nums text-slate-500">{r.n}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card p-4">
          <h3 className="mb-2 text-sm font-semibold text-slate-800 dark:text-slate-100">Worth the most</h3>
          <p className="mb-2 text-[11px] text-slate-400">Problems by how many incidents they account for.</p>
          {!t.top_problems.length ? <p className="text-xs text-slate-400">No problem has incidents linked yet.</p> : (
            <div className="space-y-1">
              {t.top_problems.map((p) => (
                <div key={p.id} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-[10px] text-slate-400">{p.number}</span>
                  <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">{p.title}</span>
                  {!!p.is_known_error && <ShieldAlert size={11} className="shrink-0 text-amber-500" />}
                  <span className="shrink-0 tabular-nums font-semibold text-slate-700 dark:text-slate-200">{p.incident_count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {!!t.overdue_actions.length && (
        <div className="card p-4">
          <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-red-600 dark:text-red-400">
            <AlertTriangle size={14} /> Overdue corrective actions
          </h3>
          <div className="space-y-1">
            {t.overdue_actions.map((a) => (
              <div key={a.id} className="flex items-center gap-2 text-xs">
                <span className="font-mono text-[10px] text-slate-400">{a.problem_number}</span>
                <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200">{a.title}</span>
                {a.owner_name && <span className="shrink-0 text-[10px] text-slate-400">{a.owner_name}</span>}
                <span className="shrink-0 font-semibold text-red-500">{a.due_date}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- page ----------------------------------------------------------------

export default function ProblemManagement() {
  const [tab, setTab] = useState('problems');
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ status: '', priority: '', q: '' });
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [meta, setMeta] = useState(null);
  const [activeView, setActiveView] = useState(null);

  useEffect(() => { api.get('/problems/meta').then(setMeta).catch(() => setMeta(null)); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // A saved view carries its own condition tree, so it is run through the
      // filter endpoint. The type is pinned here regardless, because this page
      // is the problem queue whatever the view says.
      if (activeView) {
        const out = await api.post('/views/run', {
          filters: {
            logic: 'AND',
            rules: [{ field: 'type', op: 'equals', value: 'problem' }, activeView.filters].filter(Boolean),
          },
          sort_by: activeView.sort_by,
          sort_dir: activeView.sort_dir,
        });
        setTickets(out.tickets);
        return;
      }
      const params = new URLSearchParams({ type: 'problem' });
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      setTickets((await api.get(`/tickets?${params.toString()}`)).tickets);
    } finally { setLoading(false); }
  }, [filters, activeView]);

  useEffect(() => { if (tab === 'problems') load(); }, [tab, filters.status, filters.priority]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = (id) => setOpenId(id);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Problem Management"
        description="Find the causes behind repeat incidents, publish workarounds, and see them through to a fix"
        actions={<button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> New problem</button>}
      />

      <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white/70 p-1 dark:border-white/10 dark:bg-slate-900/60">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === key ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
                : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
            }`}
          ><Icon size={13} /> {label}</button>
        ))}
      </div>

      {tab === 'problems' && (
        <>
          <ViewBar
            module="problems"
            activeId={activeView?.id}
            onRun={(view) => { setActiveView(view); setFilters({ status: '', priority: '', q: '' }); }}
          />

          {activeView && (
            <div className="flex items-center gap-2 rounded-xl bg-brand-50 px-3 py-2 text-xs dark:bg-brand-500/10">
              <span className="text-brand-700 dark:text-brand-300">
                Showing <strong>{activeView.name}</strong>
              </span>
              <button onClick={() => setActiveView(null)} className="ml-auto shrink-0 font-medium text-brand-700 hover:underline dark:text-brand-300">
                Clear
              </button>
            </div>
          )}

          <div className="card flex flex-wrap items-center gap-2 p-3">
            <form onSubmit={(e) => { e.preventDefault(); load(); }} className="relative min-w-[200px] flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className="input pl-9" placeholder="Search problems…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
            </form>
            <Select value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })}
              options={[{ value: '', label: 'Any status' }, ...STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') }))]} />
            <Select value={filters.priority} onChange={(v) => setFilters({ ...filters, priority: v })}
              options={[{ value: '', label: 'Any priority' }, ...PRIORITIES.map((p) => ({ value: p, label: p }))]} />
          </div>

          {loading ? <SkeletonRows count={5} /> : !tickets.length ? (
            <EmptyState
              icon={ListChecks}
              title="No problems recorded"
              description="A problem is the cause behind repeat incidents. Check Suggested — the platform looks for clusters you may not have noticed."
              action={<button onClick={() => setTab('candidates')} className="btn-secondary"><Sparkles size={14} /> See what's recurring</button>}
            />
          ) : (
            <div className="card divide-y divide-slate-100 dark:divide-slate-800">
              {tickets.map((t) => (
                <motion.button
                  key={t.id}
                  onClick={() => open(t.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/40"
                >
                  <span className="font-mono text-[11px] text-slate-400">{t.number}</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-slate-100">{t.title}</span>
                  {!!t.is_known_error && <ShieldAlert size={13} className="shrink-0 text-amber-500" title="Known error" />}
                  {t.problem_state && (
                    <span className="badge shrink-0 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {String(t.problem_state).replace(/_/g, ' ')}
                    </span>
                  )}
                  <PriorityBadge priority={t.priority} />
                  <StatusBadge status={t.status} />
                </motion.button>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'candidates' && <Candidates onOpened={open} />}
      {tab === 'known' && <KnownErrors onOpen={open} />}
      {tab === 'trends' && <Trends />}

      {showNew && <NewTicketModal availableTypes={['problem']} onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
      {openId && meta && (
        <ProblemWorkspace
          problemId={openId}
          meta={meta}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}
