// One calm, neutral badge style everywhere — type, status, category, and
// most priorities all read as plain information, not an alarm. Color is
// spent in exactly one place: high/critical priority, so the only thing
// that visually jumps out is the thing that actually needs attention.
const NEUTRAL_STYLE = 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300';

const PRIORITY_STYLES = {
  critical: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
  high: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  medium: NEUTRAL_STYLE,
  low: NEUTRAL_STYLE,
};

export function PriorityBadge({ priority }) {
  return <span className={`badge ${PRIORITY_STYLES[priority] || NEUTRAL_STYLE}`}>{priority}</span>;
}

export function StatusBadge({ status }) {
  return <span className={`badge ${NEUTRAL_STYLE}`}>{status?.replace('_', ' ')}</span>;
}

export function TypeBadge({ type }) {
  return <span className={`badge ${NEUTRAL_STYLE}`}>{type}</span>;
}

const SEVERITY_STYLES = {
  sev1: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
  sev2: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  sev3: NEUTRAL_STYLE,
};

export function SeverityBadge({ severity }) {
  return <span className={`badge ${SEVERITY_STYLES[severity] || NEUTRAL_STYLE}`}>{severity?.toUpperCase()}</span>;
}

const MI_STATUS_STYLES = {
  active: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
  monitoring: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  resolved: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  closed: NEUTRAL_STYLE,
};

export function MiStatusBadge({ status }) {
  return <span className={`badge ${MI_STATUS_STYLES[status] || NEUTRAL_STYLE}`}>{status?.replace('_', ' ')}</span>;
}
