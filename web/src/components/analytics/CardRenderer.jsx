import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Inbox } from 'lucide-react';
import {
  CHART_COLORS, formatMetric, compactNumber, describeDelta, formatPeriod, titleCase,
} from './cardMeta.js';

const tooltipStyle = {
  contentStyle: {
    borderRadius: 12,
    border: '1px solid rgba(148,163,184,0.25)',
    fontSize: 12,
    background: 'rgba(255,255,255,0.97)',
    color: '#0f172a',
    boxShadow: '0 8px 24px rgba(15,23,42,0.12)',
  },
};

const axis = { tick: { fontSize: 11, fill: 'currentColor' }, stroke: 'currentColor', strokeOpacity: 0.18 };

function Empty({ message = 'No data in this period' }) {
  return (
    <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 text-slate-400 dark:text-slate-500">
      <Inbox size={18} />
      <p className="text-xs">{message}</p>
    </div>
  );
}

function Broken({ error }) {
  return (
    <div className="flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 px-4 text-center text-amber-600 dark:text-amber-400">
      <AlertTriangle size={18} />
      <p className="text-xs">{error}</p>
      <p className="text-[11px] text-slate-400">Edit this card to put it right — the rest of the report is unaffected.</p>
    </div>
  );
}

// ---- scorecard -----------------------------------------------------------

function Scorecard({ data, metricLabel }) {
  const delta = data.previous !== undefined
    ? describeDelta(data.value, data.previous, data.lower_is_better)
    : null;
  const Icon = delta?.direction === 'up' ? TrendingUp : delta?.direction === 'down' ? TrendingDown : Minus;
  // Colour follows whether the movement is good, which is not the same as
  // whether it is upward.
  const tone = delta?.good === null || !delta
    ? 'text-slate-400'
    : delta.good ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';

  return (
    <div className="flex h-full flex-col justify-center">
      <div className="font-display text-3xl font-semibold tabular-nums text-slate-800 dark:text-slate-100">
        {formatMetric(data.value, data.metric, data.kind)}
      </div>
      <div className="mt-1 text-[11px] uppercase tracking-wide text-slate-400">{metricLabel}</div>
      {delta && (
        <div className={`mt-2 flex items-center gap-1 text-xs font-medium ${tone}`}>
          <Icon size={13} />
          <span>
            {delta.pct === null
              ? 'new in this period'
              : delta.direction === 'flat' ? 'no real change' : `${Math.abs(delta.pct).toFixed(1)}%`}
          </span>
          <span className="font-normal text-slate-400">
            vs {formatMetric(data.previous, data.metric, data.kind)} before
          </span>
        </div>
      )}
    </div>
  );
}

// ---- trend ---------------------------------------------------------------

function Trend({ data, metricLabel, timeDim, height }) {
  if (!data.rows?.length) return <Empty />;
  const series = data.series?.length ? data.series : ['value'];
  const single = series.length === 1 && series[0] === 'value';
  const rows = data.rows.map((r) => ({ ...r, label: formatPeriod(r.period, timeDim) }));
  const Chart = data.style === 'area' ? AreaChart : LineChart;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <Chart data={rows} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s} id={`grad-${s}-${i}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} vertical={false} />
        <XAxis dataKey="label" {...axis} />
        <YAxis {...axis} tickFormatter={compactNumber} width={44} />
        <Tooltip
          {...tooltipStyle}
          formatter={(v, name) => [formatMetric(v, data.metric, null), single ? metricLabel : titleCase(name)]}
        />
        {!single && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {series.map((s, i) => (data.style === 'area' ? (
          <Area
            key={s} type="monotone" dataKey={s} name={single ? metricLabel : s}
            stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2}
            fill={`url(#grad-${s}-${i})`}
          />
        ) : (
          <Line
            key={s} type="monotone" dataKey={s} name={single ? metricLabel : s}
            stroke={CHART_COLORS[i % CHART_COLORS.length]} strokeWidth={2}
            dot={{ r: 2.5 }} activeDot={{ r: 4 }}
          />
        )))}
      </Chart>
    </ResponsiveContainer>
  );
}

// ---- bar -----------------------------------------------------------------

function BarCard({ data, metricLabels, height }) {
  if (!data.rows?.length) return <Empty />;
  const horizontal = data.orientation === 'horizontal';
  const rows = data.rows.map((r) => ({ ...r, label: titleCase(r.group_key) }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={rows}
        layout={horizontal ? 'vertical' : 'horizontal'}
        margin={{ top: 6, right: 10, left: horizontal ? 8 : -18, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" strokeOpacity={0.12} vertical={!horizontal} horizontal={horizontal} />
        {horizontal ? <XAxis type="number" {...axis} tickFormatter={compactNumber} /> : <XAxis dataKey="label" {...axis} />}
        {horizontal
          ? <YAxis type="category" dataKey="label" {...axis} width={96} />
          : <YAxis {...axis} tickFormatter={compactNumber} width={44} />}
        <Tooltip {...tooltipStyle} formatter={(v, name) => [compactNumber(v), name]} />
        {data.metrics.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
        {data.metrics.map((m, i) => (
          <Bar
            key={m} dataKey={m} name={metricLabels[m] || m}
            fill={CHART_COLORS[i % CHART_COLORS.length]}
            radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
            maxBarSize={34}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---- donut ---------------------------------------------------------------

function Donut({ data, height }) {
  if (!data.rows?.length || !data.total) return <Empty />;
  const rows = data.rows.map((r) => ({ ...r, label: titleCase(r.group_key) }));

  return (
    <div className="flex h-full items-center gap-3">
      <div className="min-w-0 flex-1">
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie data={rows} dataKey="value" nameKey="label" innerRadius="58%" outerRadius="86%" paddingAngle={2} stroke="none">
              {rows.map((r, i) => <Cell key={r.group_key} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip
              {...tooltipStyle}
              formatter={(v, name) => [`${compactNumber(v)} (${Math.round((v / data.total) * 100)}%)`, name]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      {/* A legend as a list rather than under the chart: the share matters as
          much as the colour, and a chart legend has nowhere to put it. */}
      <div className="w-[46%] shrink-0 space-y-1 overflow-y-auto pr-1" style={{ maxHeight: height }}>
        {rows.map((r, i) => (
          <div key={r.group_key} className="flex items-center gap-1.5 text-[11px]">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
            <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300" title={r.label}>{r.label}</span>
            <span className="shrink-0 tabular-nums font-medium text-slate-700 dark:text-slate-200">
              {Math.round((r.value / data.total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- table ---------------------------------------------------------------

function TableCard({ data, metricLabels, metricKinds }) {
  if (!data.rows?.length) return <Empty />;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-slate-400">
            <th className="px-2 pb-1.5 font-medium">{data.dimension_label}</th>
            {data.metrics.map((m) => (
              <th key={m} className="px-2 pb-1.5 text-right font-medium">{metricLabels[m] || m}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.group_key} className="border-t border-slate-100 dark:border-slate-800">
              <td className="max-w-[220px] truncate px-2 py-1.5 font-medium text-slate-700 dark:text-slate-200" title={titleCase(r.group_key)}>
                {titleCase(r.group_key)}
              </td>
              {data.metrics.map((m) => (
                <td key={m} className="px-2 py-1.5 text-right tabular-nums text-slate-600 dark:text-slate-300">
                  {formatMetric(r[m], m, metricKinds[m])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.total_rows > data.rows.length && (
        <p className="px-2 pt-2 text-[11px] text-slate-400">
          Showing {data.rows.length} of {data.total_rows}. Raise the row limit to see more.
        </p>
      )}
    </div>
  );
}

// ---- pivot / heatmap -----------------------------------------------------

function Pivot({ data }) {
  if (!data.rowKeys?.length || !data.colKeys?.length) return <Empty />;
  const peak = Math.max(...data.rowKeys.flatMap((r) => data.colKeys.map((c) => data.matrix[r]?.[c] || 0)), 1);
  // Shaded by share of the busiest cell, so the eye finds the concentration
  // without having to read every number.
  const tint = (v) => (v ? `rgba(99,102,241,${0.08 + (v / peak) * 0.55})` : 'transparent');

  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-slate-400">
            <th className="px-2 pb-1.5 text-left font-medium">{data.rowLabel}</th>
            {data.colKeys.map((c) => (
              <th key={c} className="px-2 pb-1.5 text-center font-medium">{titleCase(c)}</th>
            ))}
            <th className="px-2 pb-1.5 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {data.rowKeys.map((r) => (
            <tr key={r} className="border-t border-slate-100 dark:border-slate-800">
              <td className="max-w-[160px] truncate px-2 py-1.5 font-medium text-slate-700 dark:text-slate-200" title={titleCase(r)}>
                {titleCase(r)}
              </td>
              {data.colKeys.map((c) => (
                <td
                  key={c}
                  className="px-2 py-1.5 text-center tabular-nums text-slate-700 dark:text-slate-200"
                  style={{ backgroundColor: tint(data.matrix[r]?.[c] || 0) }}
                >
                  {data.matrix[r]?.[c] || '—'}
                </td>
              ))}
              <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                {data.rowTotals[r]}
              </td>
            </tr>
          ))}
          <tr className="border-t border-slate-200 dark:border-slate-700">
            <td className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-slate-400">Total</td>
            {data.colKeys.map((c) => (
              <td key={c} className="px-2 py-1.5 text-center font-semibold tabular-nums text-slate-800 dark:text-slate-100">
                {data.colTotals[c]}
              </td>
            ))}
            <td className="px-2 py-1.5 text-right font-bold tabular-nums text-slate-800 dark:text-slate-100">{data.grandTotal}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ---- dispatcher ----------------------------------------------------------

// `meta` is the server's catalogue of metrics/dimensions, so labels always
// match what the server actually computed rather than a copy kept in step by
// hand.
export default function CardRenderer({ card, result, meta, compact = false }) {
  if (!result) {
    return (
      <div className="flex h-full min-h-[120px] items-center justify-center">
        <div className="h-full w-full animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800/60" />
      </div>
    );
  }
  if (result.error) return <Broken error={result.error} />;

  const data = result.data;
  const metricLabels = Object.fromEntries((meta?.metrics || []).map((m) => [m.key, m.label]));
  const metricKinds = Object.fromEntries((meta?.metrics || []).map((m) => [m.key, m.kind]));
  const height = compact ? 150 : (card.span >= 8 ? 240 : 190);

  switch (card.card_type) {
    case 'scorecard':
      return <Scorecard data={data} metricLabel={metricLabels[data.metric] || data.metric} />;
    case 'trend':
      return <Trend data={data} metricLabel={metricLabels[data.metric] || data.metric} timeDim={card.config.time_dim} height={height} />;
    case 'bar':
      return <BarCard data={data} metricLabels={metricLabels} height={height} />;
    case 'donut':
      return <Donut data={data} height={height} />;
    case 'table':
      return <TableCard data={data} metricLabels={metricLabels} metricKinds={metricKinds} />;
    case 'pivot':
      return <Pivot data={data} />;
    default:
      return <Broken error={`This report contains a card type this version does not know how to draw (${card.card_type}).`} />;
  }
}
