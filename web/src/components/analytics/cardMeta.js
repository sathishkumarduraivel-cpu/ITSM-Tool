import {
  Hash, TrendingUp, BarChart3, PieChart as PieChartIcon, Table2, Grid3x3,
} from 'lucide-react';

export const CHART_COLORS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444',
  '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#84cc16',
];

export const CARD_ICONS = {
  scorecard: Hash,
  trend: TrendingUp,
  bar: BarChart3,
  donut: PieChartIcon,
  table: Table2,
  pivot: Grid3x3,
};

// How wide a card may be, on the same 12-column grid the server stores.
export const SPANS = [
  { value: 3, label: 'Quarter' },
  { value: 4, label: 'Third' },
  { value: 6, label: 'Half' },
  { value: 8, label: 'Two thirds' },
  { value: 12, label: 'Full width' },
];

// Tailwind needs whole class names at build time, so these are spelled out
// rather than composed as `col-span-${n}` -- which would be purged and leave
// every card the same width.
export const SPAN_CLASS = {
  3: 'col-span-12 sm:col-span-6 xl:col-span-3',
  4: 'col-span-12 sm:col-span-6 xl:col-span-4',
  6: 'col-span-12 lg:col-span-6',
  8: 'col-span-12 xl:col-span-8',
  12: 'col-span-12',
};

// A count and an average are not written the same way, and rounding an
// average to a whole number throws away the thing that made it interesting.
export function formatMetric(value, metricKey, kind) {
  if (value === null || value === undefined) return '—';
  if (kind === 'percentage') return `${Math.round(value)}%`;
  if (metricKey === 'avg_csat') return `${Number(value).toFixed(1)} / 5`;
  if (kind === 'average') return Number(value).toFixed(1);
  return Number(value).toLocaleString();
}

// Short form for an axis tick or a dense table cell, where the full number
// would collide with its neighbour.
export function compactNumber(value) {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (Math.abs(n) >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Percentage change, with the direction judged against what the metric
// wants: a rising breach count is a fall in service, not a rise.
export function describeDelta(current, previous, lowerIsBetter) {
  if (current === null || current === undefined || previous === null || previous === undefined) return null;
  if (previous === 0) {
    if (current === 0) return { pct: 0, direction: 'flat', good: null };
    // From nothing to something has no meaningful percentage, and printing
    // "+100%" or "+∞%" would be inventing one.
    return { pct: null, direction: 'up', good: !lowerIsBetter };
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const direction = Math.abs(pct) < 0.5 ? 'flat' : (pct > 0 ? 'up' : 'down');
  if (direction === 'flat') return { pct, direction, good: null };
  return { pct, direction, good: direction === 'up' ? !lowerIsBetter : lowerIsBetter };
}

// A period key as the query produced it, made readable. '2026-03' is fine in
// a URL and poor on an axis.
export function formatPeriod(key, timeDim) {
  if (!key) return '';
  if (timeDim === 'month') {
    const [y, m] = String(key).split('-');
    const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
    if (Number.isNaN(date.getTime())) return key;
    return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }
  if (timeDim === 'day') {
    const date = new Date(`${key}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return key;
    return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  return String(key).replace('-W', ' wk ');
}

export const titleCase = (s) => String(s ?? '')
  .replace(/_/g, ' ')
  .replace(/\b\w/g, (c) => c.toUpperCase());
