const PRIORITY_STYLES = {
  critical: 'bg-red-50 text-red-600',
  high: 'bg-amber-50 text-amber-700',
  medium: 'bg-brand-50 text-brand-700',
  low: 'bg-slate-100 text-slate-600',
};

const STATUS_STYLES = {
  open: 'bg-brand-50 text-brand-700',
  pending_approval: 'bg-purple-50 text-purple-700',
  in_progress: 'bg-amber-50 text-amber-700',
  on_hold: 'bg-slate-100 text-slate-600',
  resolved: 'bg-emerald-50 text-emerald-700',
  closed: 'bg-slate-200 text-slate-600',
};

export function PriorityBadge({ priority }) {
  return <span className={`badge ${PRIORITY_STYLES[priority] || 'bg-slate-100 text-slate-600'}`}>{priority}</span>;
}

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_STYLES[status] || 'bg-slate-100 text-slate-600'}`}>{status?.replace('_', ' ')}</span>;
}

export function TypeBadge({ type }) {
  const colors = { incident: 'bg-red-50 text-red-600', request: 'bg-brand-50 text-brand-700', problem: 'bg-purple-50 text-purple-700', change: 'bg-teal-50 text-teal-700' };
  return <span className={`badge ${colors[type] || 'bg-slate-100 text-slate-600'}`}>{type}</span>;
}
