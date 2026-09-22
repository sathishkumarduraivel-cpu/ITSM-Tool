// Alerts raised from our own data rather than an external monitoring tool.
//
// These exist because the interesting operational failures in a service desk
// are not host-level: an SLA about to breach, a critical ticket sitting
// unassigned, a queue growing faster than it drains. Nothing external is
// watching for those, and nobody "reads" them into existence, so they are
// evaluated on the alertScheduler tick -- the same justification
// directorySyncScheduler.js documents for being a real background job in an
// app that otherwise computes at read time.
//
// Each monitor funnels through the ordinary ingestAlert() path with a
// synthetic internal source, so an internally-raised alert dedupes,
// escalates and becomes an incident through exactly the same code as a
// Datadog one. There is no second alert pipeline to keep in step.
import { db, uid } from '../db.js';
import { ingestAlert } from './alertIngest.js';

export const MONITOR_TYPES = [
  {
    key: 'sla_at_risk',
    label: 'SLA at risk',
    description: 'Open tickets whose resolution SLA is inside the warning window but not yet breached.',
    thresholdLabel: 'Minutes of SLA remaining',
    defaultThreshold: 30,
  },
  {
    key: 'sla_breached',
    label: 'SLA breached',
    description: 'Open tickets that have passed their resolution SLA.',
    thresholdLabel: 'Number of breached tickets to alert on',
    defaultThreshold: 1,
  },
  {
    key: 'unassigned_critical',
    label: 'Critical ticket unassigned',
    description: 'Critical tickets with no owner for longer than the window.',
    thresholdLabel: 'Number of unassigned critical tickets',
    defaultThreshold: 1,
  },
  {
    key: 'queue_depth',
    label: 'Queue depth',
    description: 'Total open tickets above a ceiling — the queue is growing faster than it drains.',
    thresholdLabel: 'Open ticket count',
    defaultThreshold: 50,
  },
  {
    key: 'reopen_rate',
    label: 'Reopen rate',
    description: 'Tickets reopened within the window, which usually means resolutions are not sticking.',
    thresholdLabel: 'Number of reopens',
    defaultThreshold: 3,
  },
];

const MONITOR_KEYS = new Set(MONITOR_TYPES.map((m) => m.key));
export const isMonitorType = (key) => MONITOR_KEYS.has(key);

// One synthetic source per workspace, created on demand, so internal alerts
// carry a real source_id and therefore participate in dedupe and rule
// matching like any other. Marked source_type 'internal' and given no
// webhook_secret -- nothing can post to it from outside.
export function internalSource(workspaceId) {
  let row = db.prepare("SELECT * FROM alert_sources WHERE workspace_id = ? AND source_type = 'internal' LIMIT 1").get(workspaceId);
  if (!row) {
    const id = uid('alsrc');
    db.prepare(
      `INSERT INTO alert_sources (id, workspace_id, name, source_type, webhook_secret, default_severity, dedupe_window_minutes, max_per_minute, enabled)
       VALUES (?,?,?,'internal',NULL,'high',?,?,1)`
    ).run(id, workspaceId, 'ITSM internal monitors', 120, 0);
    row = db.prepare('SELECT * FROM alert_sources WHERE id = ?').get(id);
  }
  return row;
}

// A SQLite date modifier rather than a JS ISO string. These tables' rows are
// stamped by datetime('now'), whose "YYYY-MM-DD HH:MM:SS" form does not
// string-compare correctly against an ISO string, so every window here is
// expressed as datetime('now', '-N minutes') and evaluated by SQLite.
function windowModifier(monitor) {
  return `-${Math.max(1, Number(monitor.window_minutes) || 60)} minutes`;
}

// Each evaluator returns null (nothing wrong) or the alert payload to raise.
// The dedupe_key is deliberately stable per monitor so a condition that
// stays true for hours produces one alert with a rising occurrence count,
// not one per tick -- that property is what makes a 60-second tick safe.
const EVALUATORS = {
  sla_at_risk(workspaceId, monitor) {
    const minutes = Math.max(1, Number(monitor.threshold) || 30);
    const rows = db.prepare(
      `SELECT number, title FROM tickets
       WHERE workspace_id = ? AND status NOT IN ('resolved','closed') AND COALESCE(is_spam,0) = 0
         AND sla_due_at IS NOT NULL
         AND datetime(sla_due_at) > datetime('now')
         AND datetime(sla_due_at) <= datetime('now', ?)`
    ).all(workspaceId, `+${minutes} minutes`);
    if (!rows.length) return null;
    return {
      title: `${rows.length} ticket(s) within ${minutes} minutes of SLA breach`,
      description: rows.slice(0, 20).map((r) => `${r.number} — ${r.title}`).join('\n'),
      entity: 'service-desk/sla',
      dedupe_key: `internal:${monitor.id}`,
      severity: monitor.severity,
    };
  },

  sla_breached(workspaceId, monitor) {
    const threshold = Math.max(1, Number(monitor.threshold) || 1);
    const rows = db.prepare(
      `SELECT number, title FROM tickets
       WHERE workspace_id = ? AND status NOT IN ('resolved','closed') AND COALESCE(is_spam,0) = 0
         AND sla_due_at IS NOT NULL AND datetime(sla_due_at) <= datetime('now')`
    ).all(workspaceId);
    if (rows.length < threshold) return null;
    return {
      title: `${rows.length} ticket(s) past their resolution SLA`,
      description: rows.slice(0, 20).map((r) => `${r.number} — ${r.title}`).join('\n'),
      entity: 'service-desk/sla',
      dedupe_key: `internal:${monitor.id}`,
      severity: monitor.severity,
    };
  },

  unassigned_critical(workspaceId, monitor) {
    const threshold = Math.max(1, Number(monitor.threshold) || 1);
    const rows = db.prepare(
      `SELECT number, title FROM tickets
       WHERE workspace_id = ? AND priority = 'critical' AND assignee_id IS NULL
         AND status NOT IN ('resolved','closed') AND COALESCE(is_spam,0) = 0
         AND datetime(created_at) <= datetime('now', ?)`
    ).all(workspaceId, windowModifier(monitor));
    if (rows.length < threshold) return null;
    return {
      title: `${rows.length} critical ticket(s) unassigned for over ${monitor.window_minutes} minutes`,
      description: rows.slice(0, 20).map((r) => `${r.number} — ${r.title}`).join('\n'),
      entity: 'service-desk/queue',
      dedupe_key: `internal:${monitor.id}`,
      severity: monitor.severity,
    };
  },

  queue_depth(workspaceId, monitor) {
    const threshold = Math.max(1, Number(monitor.threshold) || 50);
    const { c } = db.prepare(
      `SELECT COUNT(*) c FROM tickets
       WHERE workspace_id = ? AND status NOT IN ('resolved','closed') AND COALESCE(is_spam,0) = 0`
    ).get(workspaceId);
    if (c < threshold) return null;
    return {
      title: `Open queue depth is ${c} (threshold ${threshold})`,
      description: `There are ${c} open tickets in this workspace, at or above the configured ceiling of ${threshold}.`,
      entity: 'service-desk/queue',
      dedupe_key: `internal:${monitor.id}`,
      severity: monitor.severity,
    };
  },

  reopen_rate(workspaceId, monitor) {
    const threshold = Math.max(1, Number(monitor.threshold) || 3);
    // Reopens are visible in ticket_history rather than on the ticket, since
    // a ticket carries only its current status.
    const { c } = db.prepare(
      `SELECT COUNT(*) c FROM ticket_history th JOIN tickets t ON t.id = th.ticket_id
       WHERE t.workspace_id = ? AND th.event = 'reopened'
         AND datetime(th.created_at) >= datetime('now', ?)`
    ).get(workspaceId, windowModifier(monitor));
    if (c < threshold) return null;
    return {
      title: `${c} ticket(s) reopened in the last ${monitor.window_minutes} minutes`,
      description: `Reopen count ${c} is at or above the configured threshold of ${threshold}, which usually means resolutions are not holding.`,
      entity: 'service-desk/quality',
      dedupe_key: `internal:${monitor.id}`,
      severity: monitor.severity,
    };
  },
};

// Evaluates one monitor. Exported so the admin UI can offer a "test now"
// button that runs the real evaluator rather than a description of it.
export function evaluateMonitor(monitor) {
  const evaluator = EVALUATORS[monitor.monitor_type];
  if (!evaluator) return { triggered: false, reason: `Unknown monitor type ${monitor.monitor_type}` };

  const payload = evaluator(monitor.workspace_id, monitor);
  db.prepare("UPDATE internal_alert_monitors SET last_evaluated_at = datetime('now') WHERE id = ?").run(monitor.id);
  if (!payload) return { triggered: false };

  const source = internalSource(monitor.workspace_id);
  const result = ingestAlert(source, payload, { monitorId: monitor.id });
  if (result.action === 'created') {
    db.prepare("UPDATE internal_alert_monitors SET last_triggered_at = datetime('now') WHERE id = ?").run(monitor.id);
  }
  return { triggered: true, ...result, payload };
}

export function evaluateWorkspaceMonitors(workspaceId) {
  const monitors = db.prepare('SELECT * FROM internal_alert_monitors WHERE workspace_id = ? AND enabled = 1').all(workspaceId);
  return monitors.map((m) => ({ monitor: m.name, ...evaluateMonitor(m) }));
}

export function evaluateAllMonitors() {
  const monitors = db.prepare('SELECT * FROM internal_alert_monitors WHERE enabled = 1').all();
  const out = [];
  for (const m of monitors) {
    try {
      out.push({ monitorId: m.id, ...evaluateMonitor(m) });
    } catch (e) {
      console.error(`[alerts] monitor ${m.id} evaluation failed:`, e.message);
    }
  }
  return out;
}
