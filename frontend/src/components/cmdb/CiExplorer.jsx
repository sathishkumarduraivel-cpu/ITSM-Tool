import { useEffect, useMemo, useState } from 'react';
import { Loader2, Network, ArrowUp, ArrowDown, Search } from 'lucide-react';
import { api } from '../../lib/api.js';
import EmptyState from '../EmptyState.jsx';
import Select from '../Select.jsx';

// The CI Explorer: pick a CI and see what sits above and below it.
//
// Rendered as two opposed columns rather than a force-directed graph. A
// spring layout of a real estate is a hairball nobody can read, and the
// direction of a dependency -- which is the entire point -- is exactly what a
// physics simulation throws away. Up is what this depends on; down is what
// depends on it. That is legible at a glance and stays legible at 200 nodes.
export default function CiExplorer({ onOpenCi }) {
  const [assets, setAssets] = useState([]);
  const [selected, setSelected] = useState('');
  const [depth, setDepth] = useState(2);
  const [graph, setGraph] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/assets').then((d) => setAssets(d.assets || [])).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!selected) { setGraph(null); return; }
    setGraph(null);
    api.get(`/cmdb/ci/${selected}/graph?depth=${depth}`).then(setGraph).catch((e) => setError(e.message));
  }, [selected, depth]);

  const { up, down } = useMemo(() => {
    const nodes = graph?.nodes || [];
    return {
      up: nodes.filter((n) => n.sides.includes('dependency')).sort((a, b) => a.depth - b.depth),
      down: nodes.filter((n) => n.sides.includes('impact')).sort((a, b) => a.depth - b.depth),
    };
  }, [graph]);

  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[240px] flex-1">
          <label className="label">Configuration item</label>
          <Select
            value={selected}
            onChange={setSelected}
            placeholder="Pick a CI to explore…"
            options={assets.map((a) => ({ value: a.id, label: `${a.name} (${a.tag})` }))}
          />
        </div>
        <div>
          <label className="label">Hops</label>
          <Select
            className="w-auto" value={String(depth)} onChange={(v) => setDepth(Number(v))}
            options={[1, 2, 3, 4].map((d) => ({ value: String(d), label: String(d) }))}
          />
        </div>
      </div>

      {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      {!selected && (
        <EmptyState
          icon={Search}
          title="Pick a CI"
          description="Choose a configuration item to see what it depends on and what depends on it."
        />
      )}

      {selected && !graph && (
        <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" /> Walking the graph…
        </p>
      )}

      {graph && (
        <div className="space-y-3">
          <Column
            title="Depends on"
            hint="If one of these fails, the CI below is affected."
            icon={ArrowUp}
            tone="sky"
            nodes={up}
            onOpenCi={onOpenCi}
            empty="Nothing recorded. Until something is, impact analysis stops here."
          />

          <div className="card border-2 border-brand-300 p-4 dark:border-brand-500/40">
            <div className="flex items-center gap-2">
              <Network size={16} className="text-brand-600 dark:text-brand-400" />
              <div>
                <div className="font-display font-semibold text-slate-800 dark:text-slate-100">{graph.root.name}</div>
                <div className="text-xs text-slate-400">
                  {graph.root.tag}{graph.root.ci_class ? ` · ${graph.root.ci_class.label}` : ''}
                </div>
              </div>
            </div>
          </div>

          <Column
            title="Depended on by"
            hint="These are affected if the CI above fails."
            icon={ArrowDown}
            tone="amber"
            nodes={down}
            onOpenCi={onOpenCi}
            empty="Nothing depends on this CI."
          />

          <p className="text-[11px] text-slate-400">
            {graph.edges.length} relationship{graph.edges.length === 1 ? '' : 's'} within {depth} hop{depth === 1 ? '' : 's'}.
            A CI appearing on both sides is part of a loop.
          </p>
        </div>
      )}
    </div>
  );
}

function Column({ title, hint, icon: Icon, tone, nodes, empty, onOpenCi }) {
  const toneCls = tone === 'sky'
    ? 'border-sky-200 bg-sky-50/60 dark:border-sky-500/20 dark:bg-sky-500/5'
    : 'border-amber-200 bg-amber-50/60 dark:border-amber-500/20 dark:bg-amber-500/5';

  return (
    <div className={`rounded-2xl border p-3 ${toneCls}`}>
      <div className="mb-2 flex items-center gap-1.5">
        <Icon size={13} className="text-slate-500 dark:text-slate-400" />
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">{title}</span>
        <span className="text-[11px] text-slate-400">· {hint}</span>
      </div>
      {nodes.length === 0 ? (
        <p className="text-xs text-slate-400">{empty}</p>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {nodes.map((n) => (
            <button
              key={n.id}
              onClick={() => onOpenCi?.(n.id)}
              className="rounded-xl border border-white/60 bg-white/70 p-2.5 text-left transition-colors hover:border-brand-300 dark:border-white/10 dark:bg-slate-900/60 dark:hover:border-brand-500/40"
            >
              <div className="flex items-center gap-1.5">
                {n.ci_class && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: n.ci_class.color || '#94a3b8' }} />}
                <span className="truncate text-sm font-medium text-slate-700 dark:text-slate-200">{n.name}</span>
              </div>
              <div className="mt-0.5 truncate text-[11px] text-slate-400">
                {n.relationship_label} · {n.depth} hop{n.depth === 1 ? '' : 's'}
                {n.sides.length > 1 && <span className="ml-1 text-amber-600 dark:text-amber-400">· in a loop</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
