import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertTriangle, RotateCcw, Info, TrendingUp } from 'lucide-react';
import { api } from '../../lib/api.js';
import Select from '../Select.jsx';

const TONE = {
  low: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  critical: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
};

// The grid that turns "how badly does it hurt" and "how fast must it stop"
// into the one number the service desk actually queues by.
export default function PriorityMatrixTab({ setError }) {
  const [grid, setGrid] = useState(null);
  const [report, setReport] = useState(null);
  const [saving, setSaving] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const [g, r] = await Promise.all([
        api.get('/priority-matrix'),
        api.get('/priority-matrix/overrides').catch(() => null),
      ]);
      setGrid(g);
      setReport(r);
    } catch (e) { setError?.(e.message); }
  }, [setError]);
  useEffect(() => { load(); }, [load]);

  const setCell = async (impact, urgency, priority) => {
    const cellKey = `${impact}|${urgency}`;
    setSaving(cellKey);
    setNotice('');
    try {
      const next = await api.put('/priority-matrix/cell', { impact, urgency, priority });
      setGrid(next);
      setNotice('Saved. New tickets are graded by the updated grid from now on.');
    } catch (e) { setError?.(e.message); }
    finally { setSaving(null); }
  };

  const reset = async () => {
    if (!confirm('Return every combination to the baseline grid? Tickets already raised keep the priority they have.')) return;
    setResetting(true);
    try { setGrid(await api.post('/priority-matrix/reset', {})); setNotice('The grid is back to its baseline.'); }
    catch (e) { setError?.(e.message); }
    finally { setResetting(false); }
  };

  if (!grid) return <div className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 size={15} className="animate-spin" /> Loading the grid…</div>;

  const priorityOptions = grid.priorities.map((p) => ({ value: p.value, label: p.label }));

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-xs text-slate-500 dark:text-slate-400">
        Priority is worked out from Impact and Urgency rather than typed in, so two people reporting the
        same thing get the same answer. Pick what each combination should grade as. Changing a cell affects
        tickets raised from then on — it never silently re-grades work already in flight. An agent can still
        overrule the grid on a single ticket, but has to say why, and you can see how often that happens below.
      </p>

      {notice && (
        <div className="flex items-start gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
          <Info size={14} className="mt-0.5 shrink-0" /> {notice}
        </div>
      )}

      {!!grid.orphans?.length && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {grid.orphans.length} row{grid.orphans.length === 1 ? '' : 's'} in the grid use an impact or urgency
            value that no longer exists in the Field Manager. They still decide priority for any ticket holding
            that value, so they are worth cleaning up.
          </span>
        </div>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <th className="px-4 py-2.5 text-left font-medium">Impact ↓ / Urgency →</th>
              {grid.urgencies.map((u) => (
                <th key={u.value} className="px-3 py-2.5 text-center font-medium">{u.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.impacts.map((i) => (
              <tr key={i.value} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2.5 font-medium text-slate-700 dark:text-slate-200">{i.label}</td>
                {grid.urgencies.map((u) => {
                  const cellKey = `${i.value}|${u.value}`;
                  const value = grid.cells[cellKey];
                  return (
                    <td key={u.value} className="px-2 py-2 text-center">
                      <div className="relative inline-block min-w-[120px]">
                        <Select
                          value={value || ''}
                          onChange={(v) => setCell(i.value, u.value, v)}
                          options={priorityOptions}
                          placeholder="Not set"
                          size="sm"
                          className={value ? TONE[value] : ''}
                        />
                        {saving === cellKey && (
                          <Loader2 size={12} className="absolute -right-4 top-1/2 -translate-y-1/2 animate-spin text-slate-400" />
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={reset} disabled={resetting} className="btn-secondary text-xs">
          {resetting ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Reset to baseline
        </button>
        <span className="text-[11px] text-slate-400">
          The baseline follows the ITIL starting grid — high impact with high urgency is critical.
        </span>
      </div>

      {report && (
        <div className="card p-4">
          <div className="mb-2 flex items-center gap-2">
            <TrendingUp size={14} className="text-slate-400" />
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">How often the grid is overruled</h3>
            <span className="text-[11px] text-slate-400">last {report.days} days</span>
          </div>
          {report.graded === 0 ? (
            <p className="text-xs text-slate-400">No tickets have been graded with both impact and urgency yet.</p>
          ) : (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-300">
                <strong className="tabular-nums">{report.override_rate}%</strong> of graded tickets
                ({report.overridden} of {report.graded}) were given a priority other than the one the grid chose.
                {report.override_rate > 20 && ' A rate this high usually means the grid does not match how this desk really triages.'}
              </p>
              {!!report.combinations.length && (
                <table className="mt-3 w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
                      <th className="pb-1.5 font-medium">Impact</th>
                      <th className="pb-1.5 font-medium">Urgency</th>
                      <th className="pb-1.5 font-medium">Grid says</th>
                      <th className="pb-1.5 font-medium">Agents chose</th>
                      <th className="pb-1.5 text-right font-medium">Times</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.combinations.map((c, idx) => (
                      <tr key={idx} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="py-1.5 text-slate-600 dark:text-slate-300">{c.impact || '—'}</td>
                        <td className="py-1.5 text-slate-600 dark:text-slate-300">{c.urgency || '—'}</td>
                        <td className="py-1.5"><span className={`badge ${TONE[c.grid_says] || ''}`}>{c.grid_says || '—'}</span></td>
                        <td className="py-1.5"><span className={`badge ${TONE[c.priority] || ''}`}>{c.priority}</span></td>
                        <td className="py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">{c.c}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
