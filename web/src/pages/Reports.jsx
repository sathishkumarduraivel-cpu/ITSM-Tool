import { useEffect, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import {
  Download, Star, Clock, SlidersHorizontal, Save, Trash2, Play, Loader2, LayoutList, Bot, BookOpen, Ticket,
  BarChart3, LineChart as LineChartIcon, PieChart as PieChartIcon, Table2, Hash, Grid3x3,
  TrendingUp, TrendingDown, Minus, Lock, Users2, Printer, Sparkles, Rows3, RefreshCw, ArrowUpRight, Activity, CircleCheck, CalendarDays,
} from 'lucide-react';
import { api, getStoredToken } from '../lib/api.js';
import Select from '../components/Select.jsx';

const AGING_COLORS = ['#22c55e', '#84cc16', '#f59e0b', '#f97316', '#ef4444'];
const CHART_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16'];

const CHART_TYPES = [
  { key: 'bar', label: 'Bar', icon: BarChart3 },
  { key: 'line', label: 'Line', icon: LineChartIcon },
  { key: 'pie', label: 'Pie', icon: PieChartIcon },
  { key: 'donut', label: 'Donut', icon: Grid3x3 },
  { key: 'table', label: 'Table only', icon: Table2 },
  { key: 'scorecard', label: 'Scorecard', icon: Hash },
];

const METRIC_FORMAT = {
  count: (v) => v ?? 0,
  resolved: (v) => v ?? 0,
  breached: (v) => v ?? 0,
  avg_resolution_hours: (v) => (v ? `${v.toFixed(1)}h` : '—'),
  first_response_on_time_pct: (v) => (v === null || v === undefined ? '—' : `${v}%`),
  avg_csat: (v) => (v ? `${v.toFixed(1)} / 5` : '—'),
};

// Curated, one-click reports matching the named report types real ITSM
// tools (ServiceNow, Freshservice) ship out of the box -- runs the same
// custom-report engine underneath, just pre-configured so nobody has to
// know which dimension/chart combination produces "Agent Leaderboard".
const REPORT_GALLERY = [
  { key: 'sla-priority', name: 'SLA Compliance by Priority', icon: BarChart3, group_by: 'priority', chart_type: 'bar', metrics: ['count', 'breached'] },
  { key: 'sla-team', name: 'SLA Compliance by Team', icon: BarChart3, group_by: 'team', chart_type: 'bar', metrics: ['count', 'breached'] },
  { key: 'agent-leaderboard', name: 'Agent Performance Leaderboard', icon: Users2, group_by: 'assignee', chart_type: 'bar', metrics: ['count', 'resolved', 'avg_resolution_hours'] },
  { key: 'volume-trend', name: 'Ticket Volume Trend', icon: LineChartIcon, group_by: 'month', chart_type: 'line', metrics: ['count', 'resolved'] },
  { key: 'first-response', name: 'First Response Performance', icon: BarChart3, group_by: 'team', chart_type: 'bar', metrics: ['first_response_on_time_pct'] },
  { key: 'csat-category', name: 'CSAT by Category', icon: Star, group_by: 'category', chart_type: 'bar', metrics: ['avg_csat'] },
  { key: 'by-source', name: 'Tickets by Source', icon: PieChartIcon, group_by: 'source', chart_type: 'pie', metrics: ['count'] },
  { key: 'by-type', name: 'Tickets by Type', icon: PieChartIcon, group_by: 'type', chart_type: 'donut', metrics: ['count'] },
];

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function DeltaBadge({ current, previous }) {
  if (previous === null || previous === undefined || current === null || current === undefined) return null;
  if (previous === 0 && current === 0) return null;
  const pct = previous === 0 ? 100 : Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return <span className="inline-flex items-center gap-0.5 text-[11px] text-slate-400"><Minus size={10} /> 0%</span>;
  const up = pct > 0;
  return (
    <span className={`inline-flex items-center gap-0.5 text-[11px] font-medium ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
      {up ? <TrendingUp size={10} /> : <TrendingDown size={10} />} {up ? '+' : ''}{pct}%
    </span>
  );
}

function ReportGallery({ onRun }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={16} className="text-brand-600 dark:text-brand-400" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Report gallery</h3>
        <span className="text-xs text-slate-400">— common reports, one click</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
        {REPORT_GALLERY.map((t) => (
          <button
            key={t.key}
            onClick={() => onRun(t)}
            className="flex items-center gap-2 text-left bg-slate-50 dark:bg-slate-800/60 hover:bg-brand-50 dark:hover:bg-brand-500/10 rounded-lg px-3 py-2.5 transition-colors group"
          >
            <t.icon size={15} className="text-slate-400 group-hover:text-brand-600 dark:group-hover:text-brand-400 shrink-0" />
            <span className="text-xs font-medium text-slate-700 dark:text-slate-200">{t.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ReportBuilder({ galleryPick, onGalleryHandled }) {
  const [dimensions, setDimensions] = useState([]);
  const [metricsCatalog, setMetricsCatalog] = useState([]);
  const [options, setOptions] = useState(null);
  const [saved, setSaved] = useState([]);
  const [groupBy, setGroupBy] = useState('status');
  const [filters, setFilters] = useState({ type: '', priority: '', team: '', category: '', status: '', assignee_id: '', from: '', to: '' });
  const [chartType, setChartType] = useState('bar');
  const [activeMetrics, setActiveMetrics] = useState(['count', 'resolved', 'breached']);
  const [compare, setCompare] = useState(false);
  const [result, setResult] = useState(null); // { rows, previousRows?, currentRange?, previousRange? }
  const [running, setRunning] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saveFolder, setSaveFolder] = useState('');
  const [saveVisibility, setSaveVisibility] = useState('shared');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const loadMeta = async () => {
    const [d, o, s] = await Promise.all([api.get('/reports/dimensions'), api.get('/reports/filter-options'), api.get('/reports/saved')]);
    setDimensions(d.dimensions);
    setMetricsCatalog(d.metrics);
    setOptions(o);
    setSaved(s.reports);
  };
  useEffect(() => { loadMeta(); }, []);

  const queryString = (extra = {}) => {
    const params = new URLSearchParams({ group_by: groupBy, ...extra });
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
    return params.toString();
  };

  const run = async (overrides = {}) => {
    const gb = overrides.group_by || groupBy;
    setRunning(true);
    setError('');
    try {
      const data = await api.get(`/reports/custom?${queryString({ group_by: gb, ...(compare ? { compare: 1 } : {}) })}`);
      setResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  // A gallery card sets group_by/chart type/metrics then runs immediately --
  // driven from the parent so the gallery itself stays a dumb button grid.
  useEffect(() => {
    if (!galleryPick) return;
    setGroupBy(galleryPick.group_by);
    setChartType(galleryPick.chart_type);
    setActiveMetrics(galleryPick.metrics);
    setFilters({ type: '', priority: '', team: '', category: '', status: '', assignee_id: '', from: '', to: '' });
    setCompare(false);
    (async () => {
      setRunning(true);
      setError('');
      try {
        const params = new URLSearchParams({ group_by: galleryPick.group_by });
        const data = await api.get(`/reports/custom?${params.toString()}`);
        setResult(data);
      } catch (e) {
        setError(e.message);
      } finally {
        setRunning(false);
        onGalleryHandled();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [galleryPick]);

  const exportCsv = async () => {
    const resp = await fetch(`/api/reports/custom/export.csv?${queryString()}`, {
      headers: { authorization: `Bearer ${getStoredToken()}` },
    });
    downloadBlob(await resp.blob(), `report-${groupBy}.csv`);
  };

  const openPrintView = () => {
    window.open(`/reports/print?mode=custom&${queryString()}&metrics=${activeMetrics.join(',')}&chart=${chartType}`, '_blank');
  };

  const saveReport = async () => {
    if (!saveName.trim()) return;
    setSaving(true);
    try {
      await api.post('/reports/saved', { name: saveName.trim(), group_by: groupBy, filters, folder: saveFolder.trim() || null, visibility: saveVisibility, chart_type: chartType });
      setSaveName('');
      setSaveFolder('');
      loadMeta();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const runSaved = async (r) => {
    setGroupBy(r.config.group_by);
    setFilters({ type: '', priority: '', team: '', category: '', status: '', assignee_id: '', from: '', to: '', ...r.config.filters });
    setChartType(r.chart_type || 'bar');
    setCompare(false);
    setRunning(true);
    try {
      const data = await api.get(`/reports/saved/${r.id}/run`);
      setResult({ rows: data.rows });
    } finally {
      setRunning(false);
    }
  };

  const deleteSaved = async (r) => {
    if (!confirm(`Delete saved report "${r.name}"?`)) return;
    try { await api.del(`/reports/saved/${r.id}`); loadMeta(); } catch (e) { setError(e.message); }
  };

  const toggleMetric = (key) => setActiveMetrics((prev) => prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]);

  // Hooks must run unconditionally on every render, so this has to come
  // before the `if (!options) return null` guard below -- computing it
  // this way (not useMemo) is simple enough that memoizing wouldn't buy
  // anything anyway.
  const previousByKey = result?.previousRows ? Object.fromEntries(result.previousRows.map((r) => [r.group_key, r])) : null;

  if (!options) return null;
  const dimLabel = dimensions.find((d) => d.key === groupBy)?.label || groupBy;
  const rows = result?.rows;

  const foldersOf = (list) => {
    const map = new Map();
    for (const r of list) {
      const key = r.folder || 'Uncategorized';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(r);
    }
    return [...map.entries()];
  };

  return (
    <div className="card p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <SlidersHorizontal size={16} className="text-brand-600 dark:text-brand-400" />
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Custom report builder</h3>
        </div>
        <div className="flex items-center gap-1 bg-slate-100 dark:bg-slate-800 rounded-lg p-1">
          {CHART_TYPES.map((c) => (
            <button
              key={c.key}
              onClick={() => setChartType(c.key)}
              title={c.label}
              className={`p-1.5 rounded-md transition-colors ${chartType === c.key ? 'bg-white dark:bg-slate-700 text-brand-600 dark:text-brand-400 shadow-sm' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
            >
              <c.icon size={14} />
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm" className="w-auto min-w-[160px]" value={groupBy} onChange={setGroupBy}
          options={dimensions.map((d) => ({ value: d.key, label: `Group by ${d.label}` }))}
        />
        <button onClick={() => setShowFilters((s) => !s)} className="btn-secondary text-xs">
          {showFilters ? 'Hide filters' : 'Filters'}
        </button>
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 cursor-pointer select-none">
          <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare to previous period
        </label>
        <button onClick={() => run()} disabled={running} className="btn-primary text-xs ml-auto">
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Run
        </button>
      </div>

      {showFilters && (
        <div className="flex flex-wrap items-center gap-2 bg-slate-50 dark:bg-slate-800/40 rounded-lg p-2.5">
          <Select size="sm" className="w-auto min-w-[110px]" placeholder="Any type" value={filters.type} onChange={(v) => setFilters({ ...filters, type: v })} options={options.types} />
          <Select size="sm" className="w-auto min-w-[120px]" placeholder="Any priority" value={filters.priority} onChange={(v) => setFilters({ ...filters, priority: v })} options={options.priorities} />
          <Select
            size="sm" className="w-auto min-w-[120px]" placeholder="Any status" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })}
            options={options.statuses.map((s) => ({ value: s, label: s.replace('_', ' ') }))}
          />
          <Select size="sm" className="w-auto min-w-[120px]" placeholder="Any team" value={filters.team} onChange={(v) => setFilters({ ...filters, team: v })} options={options.teams} />
          <Select size="sm" className="w-auto min-w-[130px]" placeholder="Any category" value={filters.category} onChange={(v) => setFilters({ ...filters, category: v })} options={options.categories} />
          <input type="date" className="input w-auto py-1.5 text-sm" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
          <span className="text-slate-400 text-xs">to</span>
          <input type="date" className="input w-auto py-1.5 text-sm" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        {metricsCatalog.map((m) => (
          <label key={m.key} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
            <input type="checkbox" checked={activeMetrics.includes(m.key)} onChange={() => toggleMetric(m.key)} /> {m.label}
          </label>
        ))}
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

      {rows && (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-1 min-w-[240px]">
              <input className="input w-40 py-1.5 text-sm" placeholder="Save as…" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
              <input className="input w-32 py-1.5 text-sm" placeholder="Folder (optional)" value={saveFolder} onChange={(e) => setSaveFolder(e.target.value)} />
              <Select
                size="sm" className="w-auto min-w-[100px]" value={saveVisibility} onChange={setSaveVisibility}
                options={[{ value: 'shared', label: 'Shared' }, { value: 'private', label: 'Private' }]}
              />
              <button onClick={saveReport} disabled={saving || !saveName.trim()} className="btn-secondary text-xs shrink-0"><Save size={12} /> Save</button>
            </div>
            <div className="flex items-center gap-1.5">
              <button onClick={openPrintView} className="btn-secondary text-xs"><Printer size={13} /> Print / PDF</button>
              <button onClick={exportCsv} className="btn-secondary text-xs"><Download size={13} /> CSV</button>
            </div>
          </div>

          {rows.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-6">No tickets match these filters.</p>
          ) : chartType === 'scorecard' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {activeMetrics.map((key) => {
                const isRate = key === 'avg_resolution_hours' || key === 'first_response_on_time_pct' || key === 'avg_csat';
                const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined);
                const value = isRate
                  ? (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null)
                  : rows.reduce((s, r) => s + (r[key] || 0), 0);
                return (
                  <div key={key} className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-4">
                    <div className="text-xs text-slate-400 mb-1">{metricsCatalog.find((m) => m.key === key)?.label}</div>
                    <div className="text-2xl font-display font-semibold text-slate-800 dark:text-slate-100">{METRIC_FORMAT[key](value)}</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <>
              <ResponsiveContainer width="100%" height={240}>
                {chartType === 'line' ? (
                  <LineChart data={rows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="group_key" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                    <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" allowDecimals={false} />
                    <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
                    {activeMetrics.filter((k) => !['avg_resolution_hours', 'first_response_on_time_pct', 'avg_csat'].includes(k)).map((k, i) => (
                      <Line key={k} type="monotone" dataKey={k} name={metricsCatalog.find((m) => m.key === k)?.label} stroke={CHART_COLORS[i]} strokeWidth={2} dot={{ r: 3 }} />
                    ))}
                  </LineChart>
                ) : chartType === 'pie' || chartType === 'donut' ? (
                  <PieChart>
                    <Pie
                      data={rows}
                      dataKey={activeMetrics[0] || 'count'}
                      nameKey="group_key"
                      cx="50%" cy="50%"
                      outerRadius={90}
                      innerRadius={chartType === 'donut' ? 55 : 0}
                      label={(e) => e.group_key}
                    >
                      {rows.map((r, i) => <Cell key={r.group_key} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                ) : (
                  <BarChart data={rows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="group_key" tick={{ fontSize: 11 }} stroke="#94a3b8" />
                    <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" allowDecimals={false} />
                    <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
                    {activeMetrics.filter((k) => !['avg_resolution_hours', 'first_response_on_time_pct', 'avg_csat'].includes(k)).map((k, i) => (
                      <Bar key={k} dataKey={k} name={metricsCatalog.find((m) => m.key === k)?.label} fill={CHART_COLORS[i]} radius={[4, 4, 0, 0]} />
                    ))}
                  </BarChart>
                )}
              </ResponsiveContainer>

              {chartType !== 'table' && result?.currentRange && (
                <p className="text-xs text-slate-400 text-center -mt-2">
                  {result.currentRange.from} → {result.currentRange.to}
                  {result.previousRange && ` · compared to ${result.previousRange.from} → ${result.previousRange.to}`}
                </p>
              )}

              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
                    <tr>
                      <th className="text-left px-3 py-1.5 font-medium">{dimLabel}</th>
                      {activeMetrics.map((k) => <th key={k} className="text-left px-3 py-1.5 font-medium">{metricsCatalog.find((m) => m.key === k)?.label}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.group_key} className="border-t border-slate-100 dark:border-slate-800">
                        <td className="px-3 py-1.5 font-medium text-slate-800 dark:text-slate-100">{r.group_key}</td>
                        {activeMetrics.map((k) => (
                          <td key={k} className={`px-3 py-1.5 ${k === 'breached' ? 'text-red-600 dark:text-red-400' : 'text-slate-600 dark:text-slate-300'}`}>
                            <span className="flex items-center gap-1.5">
                              {METRIC_FORMAT[k](r[k])}
                              {previousByKey && <DeltaBadge current={r[k]} previous={previousByKey[r.group_key]?.[k]} />}
                            </span>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {saved.length > 0 && (
        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-2.5">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1.5"><LayoutList size={13} /> Saved reports</div>
          {foldersOf(saved).map(([folder, list]) => (
            <div key={folder}>
              <div className="text-xs text-slate-400 mb-1">{folder}</div>
              <div className="flex flex-wrap gap-2">
                {list.map((r) => (
                  <div key={r.id} className="flex items-center gap-1.5 bg-slate-50 dark:bg-slate-800/60 rounded-lg pl-3 pr-1.5 py-1">
                    {r.visibility === 'private' && <Lock size={10} className="text-slate-400" />}
                    <button onClick={() => runSaved(r)} className="text-sm text-slate-700 dark:text-slate-200 hover:text-brand-600 dark:hover:text-brand-400">{r.name}</button>
                    {r.mine && <button onClick={() => deleteSaved(r)} className="text-slate-400 hover:text-red-500 p-1"><Trash2 size={12} /></button>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Two-dimension crosstab -- ServiceNow calls this report type "Pivot
// Table". Nothing else in this builder can show "how many of each
// priority, broken down by team" as one grid with row/column totals; this
// is the one genuinely new shape, not just a restyle of the group-by report.
function PivotBuilder() {
  const [dimensions, setDimensions] = useState([]);
  const [rowDim, setRowDim] = useState('team');
  const [colDim, setColDim] = useState('priority');
  const [pivot, setPivot] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.get('/reports/dimensions').then((d) => setDimensions(d.dimensions)); }, []);

  const run = async () => {
    setRunning(true);
    setError('');
    try {
      setPivot(await api.get(`/reports/pivot?row=${rowDim}&column=${colDim}`));
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  const exportCsv = async () => {
    const resp = await fetch(`/api/reports/pivot/export.csv?row=${rowDim}&column=${colDim}`, {
      headers: { authorization: `Bearer ${getStoredToken()}` },
    });
    downloadBlob(await resp.blob(), `pivot-${rowDim}-by-${colDim}.csv`);
  };

  // Heat-tint each cell relative to the grid's own max so patterns jump out
  // without needing a separate legend -- darker means "more tickets here".
  const maxCell = pivot ? Math.max(1, ...pivot.rowKeys.flatMap((r) => pivot.colKeys.map((c) => pivot.matrix[r][c] || 0))) : 1;
  const cellTint = (v) => {
    if (!v) return '';
    const alpha = 0.08 + (v / maxCell) * 0.35;
    return `rgba(99, 102, 241, ${alpha})`;
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Rows3 size={16} className="text-brand-600 dark:text-brand-400" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Pivot table</h3>
        <span className="text-xs text-slate-400">— cross-tabulate any two dimensions</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm" className="w-auto min-w-[150px]" value={rowDim} onChange={setRowDim}
          options={dimensions.map((d) => ({ value: d.key, label: `Rows: ${d.label}` }))}
        />
        <Select
          size="sm" className="w-auto min-w-[150px]" value={colDim} onChange={setColDim}
          options={dimensions.map((d) => ({ value: d.key, label: `Columns: ${d.label}` }))}
        />
        <button onClick={run} disabled={running} className="btn-primary text-xs">
          {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Run
        </button>
        {pivot && <button onClick={exportCsv} className="btn-secondary text-xs ml-auto"><Download size={13} /> CSV</button>}
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

      {pivot && (
        pivot.rowKeys.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">No tickets match.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr>
                  <th className="text-left px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide sticky left-0 bg-white dark:bg-slate-900">{pivot.rowLabel} \ {pivot.colLabel}</th>
                  {pivot.colKeys.map((c) => <th key={c} className="text-center px-3 py-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">{c}</th>)}
                  <th className="text-center px-3 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">Total</th>
                </tr>
              </thead>
              <tbody>
                {pivot.rowKeys.map((r) => (
                  <tr key={r} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-3 py-1.5 font-medium text-slate-800 dark:text-slate-100 sticky left-0 bg-white dark:bg-slate-900">{r}</td>
                    {pivot.colKeys.map((c) => (
                      <td key={c} className="text-center px-3 py-1.5 text-slate-700 dark:text-slate-200 tabular-nums" style={{ backgroundColor: cellTint(pivot.matrix[r][c]) }}>
                        {pivot.matrix[r][c] || 0}
                      </td>
                    ))}
                    <td className="text-center px-3 py-1.5 font-semibold text-slate-800 dark:text-slate-100 tabular-nums">{pivot.rowTotals[r]}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-200 dark:border-slate-700">
                  <td className="px-3 py-1.5 font-semibold text-slate-800 dark:text-slate-100 sticky left-0 bg-white dark:bg-slate-900">Total</td>
                  {pivot.colKeys.map((c) => <td key={c} className="text-center px-3 py-1.5 font-semibold text-slate-800 dark:text-slate-100 tabular-nums">{pivot.colTotals[c]}</td>)}
                  <td className="text-center px-3 py-1.5 font-bold text-slate-900 dark:text-white tabular-nums">{pivot.grandTotal}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function SelfServiceStats() {
  const [stats, setStats] = useState(null);
  useEffect(() => { api.get('/self-service/stats').then(setStats).catch(() => setStats(null)); }, []);
  if (!stats || stats.total === 0) return null;

  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5"><Bot size={15} /> Self-service chatbot deflection</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-0.5">Conversations</div>
          <div className="text-xl font-semibold text-slate-800 dark:text-slate-100">{stats.total}</div>
        </div>
        <div className="bg-emerald-50 dark:bg-emerald-500/10 rounded-lg p-3">
          <div className="text-xs text-emerald-600 dark:text-emerald-400 mb-0.5 flex items-center gap-1"><BookOpen size={11} /> Deflected</div>
          <div className="text-xl font-semibold text-emerald-700 dark:text-emerald-400">{stats.deflectionRate}%</div>
        </div>
        <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-0.5 flex items-center gap-1"><Ticket size={11} /> Escalated to ticket</div>
          <div className="text-xl font-semibold text-slate-800 dark:text-slate-100">{stats.escalated}</div>
        </div>
        <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3">
          <div className="text-xs text-slate-400 mb-0.5">Still open</div>
          <div className="text-xl font-semibold text-slate-800 dark:text-slate-100">{stats.open}</div>
        </div>
      </div>
    </div>
  );
}

function BacklogAging() {
  const [buckets, setBuckets] = useState(null);
  useEffect(() => { api.get('/reports/backlog-aging').then((d) => setBuckets(d.buckets)); }, []);
  if (!buckets) return null;
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (total === 0) return null;

  return (
    <div className="card p-4">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Backlog aging — open tickets by age</h3>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={buckets} layout="vertical" margin={{ left: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" horizontal={false} />
          <XAxis type="number" tick={{ fontSize: 12 }} stroke="#94a3b8" allowDecimals={false} />
          <YAxis type="category" dataKey="bucket" tick={{ fontSize: 12 }} stroke="#94a3b8" width={70} />
          <Tooltip />
          <Bar dataKey="count" radius={[0, 4, 4, 0]}>
            {buckets.map((b, i) => <Cell key={b.bucket} fill={AGING_COLORS[i]} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function Reports() {
  const [summary, setSummary] = useState(null);
  const [csatList, setCsatList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [galleryPick, setGalleryPick] = useState(null);

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [s, c] = await Promise.all([api.get('/reports/tickets-summary'), api.get('/reports/csat')]);
      setSummary(s);
      setCsatList(c.surveys);
    } catch (e) {
      // Without this catch, a failed request left `loading` stuck true
      // forever -- "Loading reports…" with no error and no way to recover.
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const exportCsv = async () => {
    setExporting(true);
    try {
      const resp = await fetch('/api/reports/export/tickets.csv', {
        headers: { authorization: `Bearer ${getStoredToken()}` },
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tickets.csv';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <div className="text-slate-400 text-sm py-20 text-center">Loading reports…</div>;
  if (loadError) {
    return (
      <div className="max-w-sm mx-auto py-20 text-center space-y-3">
        <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
        <button onClick={load} className="btn-secondary text-xs mx-auto">Retry</button>
      </div>
    );
  }

  const byMonthData = summary.byMonth.map((m) => ({ month: m.month, created: m.c, resolved: m.resolved }));
  const assignedTickets = summary.byAgent.reduce((sum, agent) => sum + agent.total, 0);
  const resolvedTickets = summary.byAgent.reduce((sum, agent) => sum + agent.resolved, 0);
  const breachedTickets = summary.byAgent.reduce((sum, agent) => sum + agent.breached, 0);
  const resolutionRate = assignedTickets ? Math.round((resolvedTickets / assignedTickets) * 100) : 0;
  const slaRate = assignedTickets ? Math.max(0, Math.round(((assignedTickets - breachedTickets) / assignedTickets) * 100)) : 100;
  const bestAgent = [...summary.byAgent].sort((a, b) => b.resolved - a.resolved)[0];
  const lastMonth = byMonthData.at(-1);

  return (
    <div className="space-y-6 pb-8">
      <section className="relative overflow-hidden rounded-3xl border border-brand-200/70 bg-gradient-to-br from-brand-700 via-brand-600 to-cyan-600 px-5 py-6 text-white shadow-glow-brand sm:px-7 sm:py-7 dark:border-brand-400/20">
        <div className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-white/10 blur-2xl" />
        <div className="absolute bottom-0 right-20 h-28 w-72 rounded-full bg-cyan-300/20 blur-3xl" />
        <div className="relative flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div>
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-cyan-100"><Activity size={14} /> Operations intelligence</div>
            <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Reports command center</h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-blue-100">A live view of service performance, workload health, and the signals that need your team’s attention.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={load} className="btn bg-white/15 text-white ring-1 ring-white/25 hover:bg-white/25"><RefreshCw size={14} /> Refresh data</button>
            <button onClick={exportCsv} disabled={exporting} className="btn bg-white text-brand-700 shadow-lg hover:bg-blue-50"><Download size={14} /> {exporting ? 'Preparing…' : 'Export data'}</button>
          </div>
        </div>
        <div className="relative mt-7 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-white/15 pt-4 text-xs text-blue-100">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" /> Live operational data</span>
          <span className="inline-flex items-center gap-1.5"><CalendarDays size={13} /> Updated on demand</span>
          <span>{lastMonth ? `${lastMonth.month}: ${lastMonth.created} new tickets` : 'No monthly volume yet'}</span>
        </div>
      </section>

      <section className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200 shadow-card dark:border-white/10 dark:bg-white/10 lg:grid-cols-4">
        {[
          { label: 'Tickets handled', value: assignedTickets, detail: `${resolvedTickets} resolved`, icon: Ticket, tone: 'text-brand-600 dark:text-brand-400', bg: 'bg-brand-50 dark:bg-brand-500/10' },
          { label: 'Resolution rate', value: `${resolutionRate}%`, detail: 'of assigned workload', icon: CircleCheck, tone: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-500/10' },
          { label: 'SLA adherence', value: `${slaRate}%`, detail: breachedTickets ? `${breachedTickets} breaches flagged` : 'No breaches flagged', icon: Activity, tone: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-500/10' },
          { label: 'Customer sentiment', value: summary.csat.avg_rating ? `${summary.csat.avg_rating.toFixed(1)}/5` : '—', detail: `${summary.csat.responses} survey responses`, icon: Star, tone: 'text-violet-600 dark:text-violet-400', bg: 'bg-violet-50 dark:bg-violet-500/10' },
        ].map(({ label, value, detail, icon: Icon, tone, bg }) => (
          <div key={label} className="bg-white p-4 dark:bg-slate-900/90 sm:p-5">
            <div className="flex items-start justify-between gap-3"><span className="text-xs font-medium text-slate-500 dark:text-slate-400">{label}</span><span className={`grid h-8 w-8 place-items-center rounded-lg ${bg} ${tone}`}><Icon size={16} /></span></div>
            <div className="mt-4 text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{value}</div>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">{detail}</p>
          </div>
        ))}
      </section>

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="card p-5 xl:col-span-2">
          <div className="mb-5 flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-400">Workload momentum</p><h2 className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">Created vs. resolved</h2><p className="mt-1 text-xs text-slate-400">Monthly flow of incoming and completed work</p></div><span className="rounded-lg bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">{byMonthData.length} periods</span></div>
          <ResponsiveContainer width="100%" height={280}><BarChart data={byMonthData} barGap={5}><CartesianGrid strokeDasharray="4 4" stroke="#e2e8f0" vertical={false} /><XAxis dataKey="month" tick={{ fontSize: 11 }} stroke="#94a3b8" axisLine={false} tickLine={false} /><YAxis tick={{ fontSize: 11 }} stroke="#94a3b8" allowDecimals={false} axisLine={false} tickLine={false} /><Tooltip cursor={{ fill: 'rgba(99, 102, 241, 0.06)' }} /><Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 12 }} /><Bar name="Created" dataKey="created" fill="#bfdbfe" radius={[6, 6, 0, 0]} /><Bar name="Resolved" dataKey="resolved" fill="#4f46e5" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>
        </div>
        <div className="card overflow-hidden">
          <div className="border-b border-slate-100 px-5 py-4 dark:border-slate-800"><p className="text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-400">Performance signal</p><h2 className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">Team snapshot</h2></div>
          <div className="space-y-5 p-5">
            <div><div className="mb-2 flex items-center justify-between text-sm"><span className="text-slate-600 dark:text-slate-300">SLA compliance</span><strong className="text-slate-900 dark:text-white">{slaRate}%</strong></div><div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-cyan-400" style={{ width: `${slaRate}%` }} /></div></div>
            <div><div className="mb-2 flex items-center justify-between text-sm"><span className="text-slate-600 dark:text-slate-300">Resolution efficiency</span><strong className="text-slate-900 dark:text-white">{resolutionRate}%</strong></div><div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"><div className="h-full rounded-full bg-gradient-to-r from-brand-500 to-violet-500" style={{ width: `${resolutionRate}%` }} /></div></div>
            <div className="rounded-xl border border-brand-100 bg-brand-50/70 p-3.5 dark:border-brand-500/20 dark:bg-brand-500/10"><div className="flex items-center gap-2 text-xs font-semibold text-brand-700 dark:text-brand-300"><TrendingUp size={14} /> Leading contributor</div><div className="mt-2 flex items-end justify-between"><div><div className="font-semibold text-slate-800 dark:text-slate-100">{bestAgent?.name || 'No activity yet'}</div><div className="mt-0.5 text-xs text-slate-500">{bestAgent ? `${bestAgent.resolved} tickets resolved` : 'Awaiting ticket data'}</div></div><ArrowUpRight size={18} className="text-brand-500" /></div></div>
          </div>
        </div>
      </section>

      <section className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <BacklogAging />
        <SelfServiceStats />
      </section>

      <ReportGallery onRun={setGalleryPick} />

      <ReportBuilder galleryPick={galleryPick} onGalleryHandled={() => setGalleryPick(null)} />

      <PivotBuilder />

      <div className="card overflow-hidden overflow-x-auto">
        <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 dark:border-slate-800"><div><p className="text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-400">Delivery capacity</p><h3 className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">Agent performance</h3></div><span className="text-xs text-slate-400">Sorted by team activity</span></div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Agent</th>
              <th className="text-left px-4 py-2 font-medium">Total</th>
              <th className="text-left px-4 py-2 font-medium">Resolved</th>
              <th className="text-left px-4 py-2 font-medium">Breached</th>
            </tr>
          </thead>
          <tbody>
            {summary.byAgent.map((a) => (
              <tr key={a.name} className="row-interactive border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-100"><span className="mr-2 inline-grid h-7 w-7 place-items-center rounded-full bg-brand-50 text-[10px] font-bold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">{a.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span>{a.name}</td>
                <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{a.total}</td>
                <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{a.resolved}</td>
                <td className="px-4 py-2 text-red-600 dark:text-red-400">{a.breached}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card p-5">
        <div className="mb-4 flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-wider text-brand-600 dark:text-brand-400">Voice of customer</p><h3 className="mt-1 text-lg font-semibold text-slate-800 dark:text-slate-100">Recent CSAT feedback</h3></div><div className="flex items-center gap-1 text-amber-500"><Star size={15} className="fill-current" /><span className="text-sm font-bold">{summary.csat.avg_rating ? summary.csat.avg_rating.toFixed(1) : '—'}</span></div></div>
        {csatList.length === 0 && <p className="text-sm text-slate-400">No feedback submitted yet.</p>}
        <div className="space-y-2">
          {csatList.slice(0, 10).map((c) => (
            <div key={c.id} className="flex items-start gap-3 bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3">
              <div className="flex gap-0.5 shrink-0">
                {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={13} className={n <= c.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'} />)}
              </div>
              <div className="text-sm text-slate-600 dark:text-slate-300">
                <span className="font-mono text-xs text-slate-400 mr-1">{c.number}</span>
                {c.comment || <span className="text-slate-400 italic">No comment</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
