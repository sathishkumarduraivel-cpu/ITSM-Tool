import { PauseCircle, AlertTriangle, CircleCheck, Clock, Timer } from 'lucide-react';

const TONE = {
  running: { bar: 'bg-brand-500', text: 'text-slate-700 dark:text-slate-200', label: 'Running' },
  paused: { bar: 'bg-slate-400', text: 'text-slate-500', label: 'Paused' },
  breached: { bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: 'Breached' },
  missed: { bar: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: 'Missed' },
  met: { bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: 'Met' },
};

const LABELS = {
  response: 'First response',
  resolution: 'Resolution',
  ola_response: 'Internal response (OLA)',
  ola_resolution: 'Internal resolution (OLA)',
};

// "4h 20m" reads faster than "260 minutes" at a glance, which is the only way
// anyone reads a countdown.
function duration(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  const m = Math.abs(Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

function Target({ t, thresholds }) {
  if (!t) return null;
  const tone = TONE[t.state] || TONE.running;
  // The bar is capped at 100% so it cannot overflow its track; the number
  // beside it is not, because a target blown by 300% should say so.
  const width = Math.min(100, Math.max(2, t.consumed_pct ?? 0));

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-slate-600 dark:text-slate-300">{LABELS[t.target] || t.target}</span>
        <span className={`flex items-center gap-1 font-medium ${tone.text}`}>
          {t.state === 'met' && <CircleCheck size={12} />}
          {(t.state === 'breached' || t.state === 'missed') && <AlertTriangle size={12} />}
          {t.state === 'paused' && <PauseCircle size={12} />}
          {t.state === 'breached' || t.state === 'missed'
            ? `over by ${duration(t.over_by_minutes)}`
            : t.state === 'met' ? 'met' : `${duration(t.remaining_minutes)} left`}
        </span>
      </div>
      <div className="relative h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        {/* Where each warning threshold sits, so "75%" is a place on the bar
            rather than a number in a settings screen. */}
        {thresholds?.map((th) => (
          <span key={th} className="absolute top-0 h-full w-px bg-slate-300 dark:bg-slate-600" style={{ left: `${th}%` }} />
        ))}
        <div className={`h-full rounded-full ${tone.bar} transition-all`} style={{ width: `${width}%` }} />
      </div>
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span>{t.consumed_pct === null ? '' : `${t.consumed_pct}% of the allowance used`}</span>
        <span>{t.done_at ? 'finished' : t.due_at ? new Date(t.due_at).toLocaleString() : ''}</span>
      </div>
    </div>
  );
}

/**
 * The ticket's clocks, as the specification asks them to be reportable:
 * elapsed, remaining, percentage consumed, whether it is paused and why, and
 * the internal target kept separate from the one promised to the customer.
 */
export default function SlaPanel({ sla, ticket }) {
  if (!sla || (!sla.response && !sla.resolution)) {
    return (
      <div className="card space-y-2 p-4 text-sm">
        <h3 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">SLA</h3>
        <p className="text-xs text-slate-400">No policy matched this ticket, so it carries no target.</p>
        {ticket?.source && (
          <div className="flex justify-between text-slate-500"><span>Source</span><span className="capitalize text-slate-700 dark:text-slate-200">{ticket.source}</span></div>
        )}
      </div>
    );
  }

  return (
    <div className="card space-y-3 p-4 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <Timer size={14} /> SLA
        </h3>
        {sla.policy_name && <span className="text-[10px] text-slate-400">{sla.policy_name}</span>}
      </div>

      {sla.paused && (
        <div className="flex items-start gap-2 rounded-lg bg-slate-100 px-2.5 py-2 text-xs dark:bg-slate-800">
          <PauseCircle size={13} className="mt-0.5 shrink-0 text-slate-500" />
          <div>
            <p className="font-medium text-slate-700 dark:text-slate-200">The clock is stopped</p>
            <p className="mt-0.5 text-slate-500 dark:text-slate-400">
              {sla.pause_reason || 'Waiting on something outside the desk'}
              {sla.paused_since && ` — since ${new Date(sla.paused_since).toLocaleString()}`}
            </p>
          </div>
        </div>
      )}

      <Target t={sla.response} thresholds={sla.thresholds} />
      <Target t={sla.resolution} thresholds={sla.thresholds} />

      {(sla.ola_response || sla.ola_resolution) && (
        <div className="space-y-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <p className="text-[10px] uppercase tracking-wide text-slate-400">Internal targets</p>
          <Target t={sla.ola_response} thresholds={sla.thresholds} />
          <Target t={sla.ola_resolution} thresholds={sla.thresholds} />
        </div>
      )}

      <div className="space-y-1.5 border-t border-slate-100 pt-2.5 text-xs dark:border-slate-800">
        {sla.paused_minutes > 0 && (
          <div className="flex justify-between text-slate-500">
            <span className="flex items-center gap-1"><Clock size={11} /> Time paused</span>
            <span className="text-slate-700 dark:text-slate-200">{duration(sla.paused_minutes)}</span>
          </div>
        )}
        {sla.business_hours_only && (
          <p className="text-[11px] text-slate-400">Measured in working hours, so evenings, weekends and holidays do not count.</p>
        )}
        {sla.breach_reason && <p className="text-[11px] text-red-500">{sla.breach_reason}</p>}
      </div>
    </div>
  );
}
