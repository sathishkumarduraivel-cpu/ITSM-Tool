import { useEffect, useState } from 'react';
import { Loader2, Briefcase, ChevronRight, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api.js';
import EmptyState from '../EmptyState.jsx';

// Service maps: what each business service is actually built on.
//
// Drawn as layers rather than a free-form graph. During an incident the
// question is "how far down does this go and what is at each level", and a
// node-and-edge picture answers that worse than a stack does -- you end up
// tracing lines with a finger. The Explorer view is there for when the
// topology itself is the question.
export default function ServiceMapView({ onOpenCi }) {
  const [services, setServices] = useState(null);
  const [selected, setSelected] = useState(null);
  const [map, setMap] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/cmdb/services')
      .then((d) => {
        setServices(d.services || []);
        if (d.services?.length) setSelected(d.services[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setMap(null);
    api.get(`/cmdb/service-map/${selected}`).then(setMap).catch((e) => setError(e.message));
  }, [selected]);

  if (error) return <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>;
  if (!services) return <Loading />;

  if (!services.length) {
    return (
      <EmptyState
        icon={Briefcase}
        title="No business services yet"
        description="Create a CI on the Business Service class, then link the applications and infrastructure that support it. This is what turns an inventory into something that can answer 'what breaks if this fails'."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
      <div className="space-y-1">
        {services.map((s) => (
          <button
            key={s.id}
            onClick={() => setSelected(s.id)}
            className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
              selected === s.id
                ? 'border-brand-300 bg-brand-50 dark:border-brand-500/40 dark:bg-brand-500/10'
                : 'border-slate-200 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-slate-800/60'
            }`}
          >
            <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{s.name}</div>
            <div className="mt-0.5 text-[11px] text-slate-400">
              {s.mapped
                ? `${s.supporting_ci_count} supporting CI${s.supporting_ci_count === 1 ? '' : 's'}`
                : /* The single most useful thing this screen can point at. */
                  <span className="text-amber-600 dark:text-amber-400">nothing mapped</span>}
            </div>
          </button>
        ))}
      </div>

      <div>
        {!map ? <Loading /> : (
          <div className="space-y-4">
            <div className="card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">{map.root.name}</h3>
                  <p className="text-xs text-slate-400">{map.summary.total} CIs underneath, across {map.layers.length} layer{map.layers.length === 1 ? '' : 's'}</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {map.summary.by_class.map((c) => (
                    <span key={c.key} className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      {c.count} {c.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {!map.summary.mapped ? (
              <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                <span>
                  Nothing is mapped under this service. When it breaks, nobody will be able to answer what it depends on —
                  open the service and add what it runs on under Relationships.
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                {map.layers.map((layer) => (
                  <div key={layer.depth}>
                    <div className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      <ChevronRight size={11} /> Layer {layer.depth}
                    </div>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {layer.nodes.map((n) => (
                        <button
                          key={n.id}
                          onClick={() => onOpenCi?.(n.id)}
                          className="card-flat rounded-xl border border-slate-200 p-2.5 text-left transition-colors hover:border-brand-300 dark:border-white/10 dark:hover:border-brand-500/40"
                        >
                          <div className="flex items-center gap-1.5">
                            {n.ci_class && (
                              <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: n.ci_class.color || '#94a3b8' }} />
                            )}
                            <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{n.name}</span>
                          </div>
                          <div className="mt-0.5 truncate text-[11px] text-slate-400">
                            {n.ci_class?.label || 'Unclassified'} · {n.relationship_label}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Loading() {
  return (
    <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
      <Loader2 size={16} className="animate-spin" /> Loading…
    </p>
  );
}
