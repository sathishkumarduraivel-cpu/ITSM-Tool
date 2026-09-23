// Change KPIs. The flow diagram says "Update Metrics (KPIs / SLA)" without
// naming any, so these are the ones a change manager is actually asked for
// in a service review -- and each is answerable from data this module now
// records rather than requiring a new counter.
//
// Computed on read rather than incremented on write: a counter that drifts
// from the tickets it counts is worse than no counter, and these queries are
// indexed single-table scans over one workspace.
import { db } from '../db.js';

// SQLite writes datetime('now') without a zone marker, so JS would parse it
// as local time -- the same trap fixed in web/src/lib/dates.js and
// alertRules.js. Every comparison here is therefore done in SQL.
const WINDOW_SQL = "datetime(t.created_at) >= datetime('now', ?)";

export function computeMetrics(workspaceId, { days = 90 } = {}) {
  const window = `-${Math.max(1, Number(days) || 90)} days`;
  const q = (sql, ...params) => db.prepare(sql).get(workspaceId, ...params);

  const totals = q(
    `SELECT
       COUNT(*) total,
       SUM(CASE WHEN t.change_state = 'closed' THEN 1 ELSE 0 END) closed,
       SUM(CASE WHEN t.change_state = 'rolled_back' THEN 1 ELSE 0 END) rolled_back,
       SUM(CASE WHEN t.change_type = 'emergency' THEN 1 ELSE 0 END) emergency,
       SUM(CASE WHEN t.change_type = 'standard' THEN 1 ELSE 0 END) standard,
       SUM(CASE WHEN t.freeze_override_reason IS NOT NULL THEN 1 ELSE 0 END) freeze_overrides
     FROM tickets t
     WHERE t.workspace_id = ? AND t.type = 'change' AND ${WINDOW_SQL}`,
    window
  );

  // Success is judged from the PIR where one exists, because that is the
  // considered answer; a change with no PIR that reached Closed without a
  // rollback counts as successful.
  const outcomes = q(
    `SELECT
       SUM(CASE WHEN p.outcome = 'successful' THEN 1 ELSE 0 END) successful,
       SUM(CASE WHEN p.outcome = 'successful_with_issues' THEN 1 ELSE 0 END) with_issues,
       SUM(CASE WHEN p.outcome = 'failed' THEN 1 ELSE 0 END) failed,
       SUM(CASE WHEN p.caused_incident = 1 THEN 1 ELSE 0 END) caused_incident,
       COUNT(p.id) reviewed
     FROM tickets t JOIN change_pir p ON p.ticket_id = t.id
     WHERE t.workspace_id = ? AND t.type = 'change' AND ${WINDOW_SQL}`,
    window
  );

  const implemented = q(
    `SELECT COUNT(*) c FROM tickets t
     WHERE t.workspace_id = ? AND t.type = 'change'
       AND t.change_state IN ('implemented','closed') AND ${WINDOW_SQL}`,
    window
  ).c;

  // Lead time: request to implementation start, in hours. Averaged in SQL
  // via julianday so no JS date parsing is involved.
  const lead = q(
    `SELECT AVG((julianday(t.actual_start) - julianday(t.created_at)) * 24) avg_hours
     FROM tickets t
     WHERE t.workspace_id = ? AND t.type = 'change'
       AND t.actual_start IS NOT NULL AND ${WINDOW_SQL}`,
    window
  );

  const approvalSla = q(
    `SELECT
       COUNT(*) total,
       SUM(CASE WHEN COALESCE(a.sla_breached,0) = 1 THEN 1 ELSE 0 END) breached
     FROM approvals a JOIN tickets t ON t.id = a.ticket_id
     WHERE t.workspace_id = ? AND t.type = 'change' AND a.sla_due_at IS NOT NULL AND ${WINDOW_SQL}`,
    window
  );

  const pct = (numerator, denominator) =>
    (denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null);

  const total = totals.total || 0;
  // A change is "unsuccessful" if it rolled back or its PIR says it failed.
  const unsuccessful = (totals.rolled_back || 0) + (outcomes.failed || 0);

  return {
    window_days: Number(days) || 90,
    total,
    closed: totals.closed || 0,
    in_flight: total - (totals.closed || 0),
    implemented,
    rolled_back: totals.rolled_back || 0,

    // The headline number in any change review.
    success_rate_pct: pct(Math.max(0, implemented - unsuccessful), implemented),
    rollback_rate_pct: pct(totals.rolled_back || 0, implemented),
    // A high emergency ratio means change management is being bypassed.
    emergency_ratio_pct: pct(totals.emergency || 0, total),
    // A high standard ratio is good: more pre-approved, less CAB time.
    standard_ratio_pct: pct(totals.standard || 0, total),
    caused_incident_count: outcomes.caused_incident || 0,
    change_caused_incident_pct: pct(outcomes.caused_incident || 0, outcomes.reviewed || 0),

    avg_lead_time_hours: lead.avg_hours === null ? null : Math.round(lead.avg_hours * 10) / 10,

    approval_sla: {
      total: approvalSla.total || 0,
      breached: approvalSla.breached || 0,
      attainment_pct: approvalSla.total > 0
        ? Math.round(((approvalSla.total - approvalSla.breached) / approvalSla.total) * 1000) / 10
        : null,
    },

    // Surfaced as a governance number, not hidden: a freeze that is pierced
    // routinely is not a freeze.
    freeze_overrides: totals.freeze_overrides || 0,

    pir: {
      reviewed: outcomes.reviewed || 0,
      successful: outcomes.successful || 0,
      with_issues: outcomes.with_issues || 0,
      failed: outcomes.failed || 0,
      outstanding: db.prepare(
        `SELECT COUNT(*) c FROM tickets t LEFT JOIN change_pir p ON p.ticket_id = t.id
         WHERE t.workspace_id = ? AND t.type = 'change' AND COALESCE(t.pir_required,0) = 1
           AND t.change_state IN ('implemented','rolled_back')
           AND (p.id IS NULL OR p.completed_at IS NULL)`
      ).get(workspaceId).c,
    },
  };
}

// Counts per state, for the pipeline board's column headers.
export function stateCounts(workspaceId) {
  const rows = db.prepare(
    `SELECT COALESCE(change_state, 'new') state, COUNT(*) c
     FROM tickets WHERE workspace_id = ? AND type = 'change' GROUP BY COALESCE(change_state, 'new')`
  ).all(workspaceId);
  return rows.reduce((acc, r) => ({ ...acc, [r.state]: r.c }), {});
}

// Volume and outcome by month, for the trend chart.
export function monthlyTrend(workspaceId, { months = 6 } = {}) {
  return db.prepare(
    `SELECT strftime('%Y-%m', t.created_at) month,
            COUNT(*) raised,
            SUM(CASE WHEN t.change_state = 'closed' THEN 1 ELSE 0 END) closed,
            SUM(CASE WHEN t.change_state = 'rolled_back' THEN 1 ELSE 0 END) rolled_back,
            SUM(CASE WHEN t.change_type = 'emergency' THEN 1 ELSE 0 END) emergency
     FROM tickets t
     WHERE t.workspace_id = ? AND t.type = 'change'
       AND datetime(t.created_at) >= datetime('now', ?)
     GROUP BY month ORDER BY month ASC`
  ).all(workspaceId, `-${Math.max(1, Number(months) || 6)} months`);
}
