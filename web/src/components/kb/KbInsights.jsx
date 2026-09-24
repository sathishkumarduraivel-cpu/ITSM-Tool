import { useEffect, useState } from 'react';
import {
  Loader2, SearchX, ThumbsDown, Clock, TrendingDown, Plus, Info, CheckCircle2,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { fmtRelative } from '../../lib/dates.js';
import Select from '../Select.jsx';
import EmptyState from '../EmptyState.jsx';

// What the knowledge base is doing, and what to do about it.
//
// Every panel here ends in an action. A view counter does not: an article
// with 900 views might be the best page you have or the one everyone lands on
// and bounces off. These four answer "what should I write", "what should I
// fix", "what should I check" and "is any of this working".
export default function KbInsights({ onWriteArticle, onOpenArticle }) {
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState(null);
  const [gaps, setGaps] = useState(null);
  const [failing, setFailing] = useState(null);
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setOverview(null); setGaps(null);
    Promise.all([
      api.get(`/kb/analytics/overview?days=${days}`).then(setOverview),
      api.get(`/kb/analytics/gaps?days=${days}`).then(setGaps),
      api.get('/kb/analytics/failing').then((d) => setFailing(d.articles)),
      api.get('/kb/analytics/review-queue').then(setQueue),
    ]).catch((e) => setError(e.message));
  }, [days]);

  if (error) return <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>;
  if (!overview || !gaps) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid flex-1 grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Published" value={overview.articles.published} sub={`${overview.articles.drafts} draft, ${overview.articles.in_review} in review`} />
          <Stat label="Searches" value={overview.searches.total} sub={`${overview.searches.total ? `${overview.searches.miss_rate}% found nothing` : 'none yet'}`} />
          <Stat label="Due a review" value={overview.articles.overdue} tone={overview.articles.overdue ? 'warn' : 'ok'} sub="published and overdue" />
          <Stat label="Est. deflection" value={overview.deflection.rate != null ? `${overview.deflection.rate}%` : '—'} sub={`${overview.deflection.views} portal views`} />
        </div>
        <Select className="w-auto" value={String(days)} onChange={(v) => setDays(Number(v))}
          options={[7, 30, 90, 180].map((d) => ({ value: String(d), label: `Last ${d} days` }))} />
      </div>

      {/* The one report almost no tool ships, and the most useful. */}
      <Panel
        icon={SearchX}
        title="What people looked for and did not find"
        hint="In their own words. Each of these is an article nobody has written yet."
      >
        {gaps.gaps.length === 0 ? (
          <p className="text-xs text-slate-400">Every search in this period found something.</p>
        ) : (
          <div className="space-y-1">
            {gaps.gaps.map((g) => (
              <div key={g.query} className="flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-2.5 py-1.5 text-sm dark:bg-amber-500/10">
                <span className="flex-1 text-amber-900 dark:text-amber-200">“{g.query}”</span>
                <span className="text-[11px] text-amber-700 dark:text-amber-300">
                  {g.searches} search{g.searches === 1 ? '' : 'es'} · {g.people} {g.people === 1 ? 'person' : 'people'} · {fmtRelative(g.last_searched)}
                </span>
                <button onClick={() => onWriteArticle({ title: g.query })} className="btn-secondary shrink-0 text-[11px]">
                  <Plus size={11} /> Write it
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* A subtler failure than a zero-result search, and usually worse. */}
      <Panel
        icon={TrendingDown}
        title="Found results, opened none"
        hint="The articles came back and did not look like the answer. That is a title and summary problem, not a missing-content one."
      >
        {(!gaps.unhelpful_searches || gaps.unhelpful_searches.length === 0) ? (
          <p className="text-xs text-slate-400">Nothing repeated often enough to draw a conclusion.</p>
        ) : (
          <div className="space-y-1">
            {gaps.unhelpful_searches.map((s) => (
              <div key={s.query} className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-sm dark:bg-slate-800/60">
                <span className="text-slate-700 dark:text-slate-200">“{s.query}”</span>
                <span className="text-[11px] text-slate-400">{s.searches} searches · {s.avg_results} results each</span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <Panel
        icon={ThumbsDown}
        title="Articles readers said did not help"
        hint="Ranked by proportion, not raw count, so a page read twice and disliked twice outranks one read a thousand times."
      >
        {(!failing || failing.length === 0) ? (
          <p className="text-xs text-slate-400">Nothing with enough votes to judge yet.</p>
        ) : (
          <div className="space-y-1">
            {failing.map((a) => (
              <button key={a.id} onClick={() => onOpenArticle(a.id)}
                className="w-full rounded-md bg-slate-50 px-2.5 py-2 text-left hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 text-sm text-slate-700 dark:text-slate-200">{a.title}</span>
                  <span className="badge bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300">
                    {a.unhelpful_rate}% unhelpful
                  </span>
                  <span className="text-[11px] text-slate-400">{a.votes} votes</span>
                </div>
                {a.comments?.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {a.comments.slice(0, 2).map((c, i) => (
                      <div key={i} className="text-[11px] italic text-slate-500 dark:text-slate-400">“{c}”</div>
                    ))}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </Panel>

      <Panel icon={Clock} title="Needs a look" hint="Overdue, never reviewed, or waiting for somebody to approve it.">
        {!queue ? <Loading /> : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
            <QueueList title="Overdue" items={queue.overdue} onOpen={onOpenArticle}
              empty="Nothing overdue." meta={(a) => `due ${String(a.review_due_at).slice(0, 10)}`} tone="warn" />
            <QueueList title="Never reviewed" items={queue.never_reviewed} onOpen={onOpenArticle}
              empty="Everything has a review date." meta={(a) => `updated ${fmtRelative(a.updated_at)}`} />
            <QueueList title="Waiting for approval" items={queue.awaiting_review} onOpen={onOpenArticle}
              empty="Nothing waiting." meta={(a) => `submitted ${fmtRelative(a.submitted_at)}`} />
          </div>
        )}
      </Panel>

      <p className="flex items-start gap-1.5 text-[11px] text-slate-400">
        <Info size={11} className="mt-0.5 shrink-0" />
        {overview.deflection.basis}
      </p>
    </div>
  );
}

function QueueList({ title, items, empty, meta, onOpen, tone }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
        {title}
        <span className={`rounded px-1 ${tone === 'warn' && items.length ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}>
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="flex items-center gap-1 text-xs text-slate-400"><CheckCircle2 size={11} /> {empty}</p>
      ) : (
        <div className="space-y-1">
          {items.slice(0, 8).map((a) => (
            <button key={a.id} onClick={() => onOpen(a.id)}
              className="w-full rounded-md bg-slate-50 px-2 py-1.5 text-left text-xs hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800">
              <div className="truncate text-slate-700 dark:text-slate-200">{a.title}</div>
              <div className="text-[10px] text-slate-400">{meta(a)}</div>
            </button>
          ))}
          {items.length > 8 && <div className="text-[10px] text-slate-400">+{items.length - 8} more</div>}
        </div>
      )}
    </div>
  );
}

function Panel({ icon: Icon, title, hint, children }) {
  return (
    <div className="card p-4">
      <div className="mb-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
          <Icon size={14} /> {title}
        </h3>
        {hint && <p className="mt-0.5 max-w-3xl text-[11px] text-slate-400">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`font-display text-xl font-bold ${
        tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100'
      }`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}

function Loading() {
  return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading…</p>;
}
