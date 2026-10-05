import { useEffect, useState } from 'react';
import { Loader2, HeartPulse, ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { api } from '../../lib/api.js';
import EmptyState from '../EmptyState.jsx';
import Select from '../Select.jsx';

const GRADE_STYLE = {
  good: 'text-emerald-600 dark:text-emerald-400',
  fair: 'text-amber-600 dark:text-amber-400',
  poor: 'text-orange-600 dark:text-orange-400',
  critical: 'text-red-600 dark:text-red-400',
};

// CMDB health.
//
// Every dimension expands into the actual CIs that fail it. A percentage on
// its own tells nobody what to do on Monday morning; a list of forty CIs with
// no owner does. The score is the headline, the lists are the product.
export default function HealthView({ onOpenCi }) {
  const [data, setData] = useState(null);
  const [staleDays, setStaleDays] = useState(90);
  const [openDim, setOpenDim] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    api.get(`/itam/health?stale_days=${staleDays}`).then(setData).catch((e) => setError(e.message));
  }, [staleDays]);

  if (error) return <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>;
  if (!data) return <Loading />;

  if (data.score === null) {
    return <EmptyState icon={HeartPulse} title="Nothing to score yet" description={data.message} />;
  }

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">CMDB health</div>
          <div className={`font-display text-4xl font-bold ${GRADE_STYLE[data.grade]}`}>{data.score}%</div>
          <p className="mt-1 max-w-lg text-sm text-slate-500 dark:text-slate-400">{data.headline}</p>
        </div>
        <div className="flex items-end gap-3">
          <div>
            <label className="label">Count as stale after</label>
            <Select
              className="w-auto" value={String(staleDays)} onChange={(v) => setStaleDays(Number(v))}
              options={[30, 60, 90, 180, 365].map((d) => ({ value: String(d), label: `${d} days` }))}
            />
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">CIs scanned</div>
            <div className="font-display text-xl font-bold text-slate-800 dark:text-slate-100">{data.scanned}</div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {data.dimensions.map((dim) => {
          const expanded = openDim === dim.key;
          return (
            <div key={dim.key} className="card overflow-hidden">
              <button
                onClick={() => setOpenDim(expanded ? null : dim.key)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                {expanded ? <ChevronDown size={14} className="shrink-0 text-slate-400" /> : <ChevronRight size={14} className="shrink-0 text-slate-400" />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{dim.label}</span>
                    <span className="text-xs text-slate-400">{dim.question}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className={`h-full rounded-full ${dim.score >= 90 ? 'bg-emerald-500' : dim.score >= 70 ? 'bg-amber-500' : 'bg-red-500'}`}
                      style={{ width: `${dim.score}%` }}
                    />
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-display text-lg font-bold text-slate-800 dark:text-slate-100">{dim.score}%</div>
                  <div className="text-[10px] text-slate-400">{dim.failing} of {dim.total} failing</div>
                </div>
              </button>

              {expanded && (
                <div className="border-t border-slate-100 px-4 py-3 dark:border-slate-800">
                  <p className="mb-2 flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    <Wrench size={12} className="mt-0.5 shrink-0" /> {dim.fix}
                  </p>
                  {dim.items.length === 0 ? (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400">Nothing fails this check.</p>
                  ) : (
                    <div className="grid max-h-72 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
                      {dim.items.map((item) => (
                        <button
                          key={item.id}
                          onClick={() => onOpenCi?.(item.id)}
                          className="rounded-md bg-slate-50 px-2 py-1.5 text-left text-xs hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800"
                        >
                          <div className="truncate text-slate-700 dark:text-slate-200">{item.name}</div>
                          <div className="truncate text-[10px] text-slate-400">
                            {item.ci_class || 'Unclassified'}
                            {item.missing?.length ? ` · missing ${item.missing.join(', ')}` : ''}
                            {item.last_seen_at ? ` · last seen ${String(item.last_seen_at).slice(0, 10)}` : ''}
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                  {dim.failing > dim.items.length && (
                    <p className="mt-2 text-[10px] text-slate-400">Showing {dim.items.length} of {dim.failing}.</p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {data.unclassified?.count > 0 && (
        <div className="rounded-xl bg-slate-50 px-3 py-2.5 text-xs text-slate-600 dark:bg-slate-800/60 dark:text-slate-300">
          <strong>{data.unclassified.count} CI{data.unclassified.count === 1 ? '' : 's'} have no class.</strong> {data.unclassified.note}
        </div>
      )}

      {data.by_class?.length > 0 && (
        <div className="card p-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Weakest classes first</h3>
          <div className="space-y-2">
            {data.by_class.map((c) => (
              <div key={c.id}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="truncate text-slate-700 dark:text-slate-200">{c.label}</span>
                  <span className="shrink-0 text-slate-400">{c.clean}/{c.total} clean · {c.score}%</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className={`h-full rounded-full ${c.score >= 90 ? 'bg-emerald-500' : c.score >= 70 ? 'bg-amber-500' : 'bg-red-500'}`}
                    style={{ width: `${c.score}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Loading() {
  return <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Scoring the CMDB…</p>;
}
