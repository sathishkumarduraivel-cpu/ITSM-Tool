const PRIORITY_STYLES = {
  critical: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
  high: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  medium: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400',
  low: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
};

const STATUS_STYLES = {
  open: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400',
  pending_approval: 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400',
  in_progress: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  on_hold: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  resolved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  closed: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

const DEFAULT_STYLE = 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';

export function PriorityBadge({ priority }) {
  return <span className={`badge ${PRIORITY_STYLES[priority] || DEFAULT_STYLE}`}>{priority}</span>;
}

export function StatusBadge({ status }) {
  return <span className={`badge ${STATUS_STYLES[status] || DEFAULT_STYLE}`}>{status?.replace('_', ' ')}</span>;
}

export function TypeBadge({ type }) {
  const colors = {
    incident: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
    request: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400',
    problem: 'bg-purple-50 text-purple-700 dark:bg-purple-500/10 dark:text-purple-400',
    change: 'bg-teal-50 text-teal-700 dark:bg-teal-500/10 dark:text-teal-400',
  };
  return <span className={`badge ${colors[type] || DEFAULT_STYLE}`}>{type}</span>;
}
