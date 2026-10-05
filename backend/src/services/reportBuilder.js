import { db } from '../db.js';

// Each dimension maps to a SQL expression evaluated against the tickets
// table (aliased t) and, for 'assignee', a join to users (aliased u). Kept
// as an allowlist -- group_by is interpolated into the query, so only a
// known-safe expression may ever be used.
export const GROUP_BY_DIMENSIONS = {
  status: { expr: 't.status', label: 'Status', needsUserJoin: false },
  priority: { expr: 't.priority', label: 'Priority', needsUserJoin: false },
  type: { expr: 't.type', label: 'Ticket Type', needsUserJoin: false },
  category: { expr: "COALESCE(t.category, 'Uncategorized')", label: 'Category', needsUserJoin: false },
  team: { expr: "COALESCE(t.team, 'Unassigned')", label: 'Team', needsUserJoin: false },
  assignee: { expr: "COALESCE(u.name, 'Unassigned')", label: 'Assignee', needsUserJoin: true },
  source: { expr: "COALESCE(t.source, 'portal')", label: 'Source', needsUserJoin: false },
  month: { expr: "strftime('%Y-%m', t.created_at)", label: 'Month', needsUserJoin: false },
  week: { expr: "strftime('%Y-W%W', t.created_at)", label: 'Week', needsUserJoin: false },
  day: { expr: "date(t.created_at)", label: 'Day', needsUserJoin: false },
};

// The full metric set a report can show -- computed together in one query
// (cheap; these are simple aggregates over an already-filtered/grouped set)
// so the frontend can freely toggle which columns/series are visible
// without a round trip per metric.
export const METRICS = [
  { key: 'count', label: 'Total tickets' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'breached', label: 'SLA breached' },
  { key: 'avg_resolution_hours', label: 'Avg resolution (hrs)' },
  { key: 'first_response_on_time_pct', label: 'First response on time %' },
  { key: 'avg_csat', label: 'Avg CSAT (out of 5)' },
  // The benchmark measures (§19). MTTA and MTTR are named explicitly rather
  // than left as "avg resolution", because the specification reports them
  // separately and their denominators differ -- MTTA counts only tickets
  // somebody actually responded to, MTTR only those actually resolved.
  { key: 'mtta_hours', label: 'MTTA — time to first response (hrs)' },
  { key: 'mttr_hours', label: 'MTTR — time to resolve (hrs)' },
  { key: 'first_contact_resolution_pct', label: 'First contact resolution %' },
  { key: 'reopen_rate_pct', label: 'Reopen rate %' },
  { key: 'sla_compliance_pct', label: 'SLA compliance %' },
];

const FILTERABLE = ['type', 'priority', 'team', 'category', 'status', 'assignee_id'];

function buildWhere(workspaceId, filters = {}) {
  const clauses = ['t.workspace_id = ?'];
  const params = [workspaceId];
  for (const key of FILTERABLE) {
    if (filters[key]) { clauses.push(`t.${key} = ?`); params.push(filters[key]); }
  }
  if (filters.from) { clauses.push('t.created_at >= ?'); params.push(filters.from); }
  if (filters.to) { clauses.push('t.created_at <= ?'); params.push(filters.to); }
  return { where: clauses.join(' AND '), params };
}

// avg_csat is a correlated subquery, not a joined+grouped column -- a plain
// LEFT JOIN to csat_surveys would fan out COUNT(*) (and every other metric
// in this same SELECT) for any ticket with more than one survey row, since
// the schema has no UNIQUE(ticket_id) stopping that. The subquery averages
// per-ticket first, so it can never distort the surrounding aggregates.
const METRICS_SELECT = `
  COUNT(*) AS count,
  SUM(CASE WHEN t.status IN ('resolved','closed') THEN 1 ELSE 0 END) AS resolved,
  -- Computed live rather than trusting the stored sla_breached column, which
  -- is only opportunistically stamped when a ticket is fetched through
  -- routes/tickets.js (see services/sla.js's stampSlaBreach) and so can't be
  -- relied on for a ticket a report includes but nobody has ever individually
  -- opened -- this mirrors exactly what stampSlaBreach itself computes.
  SUM(CASE
    WHEN t.sla_due_at IS NULL THEN 0
        -- datetime() on BOTH sides: sla_due_at is stored as an ISO string with a
    -- 'T' separator, while datetime('now') and the stamped resolved_at use a
    -- space. Compared as plain strings a space sorts before 'T', so a ticket
    -- that breached earlier the SAME DAY read as not breached     -- the miss only
    -- became visible once the due date fell on an earlier calendar date.
    WHEN t.status IN ('resolved','closed') THEN (CASE WHEN datetime(COALESCE(t.resolved_at, t.closed_at)) > datetime(t.sla_due_at) THEN 1 ELSE 0 END)
    ELSE (CASE WHEN datetime('now') > datetime(t.sla_due_at) THEN 1 ELSE 0 END)
  END) AS breached,
  AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 ELSE NULL END) AS avg_resolution_hours,
  SUM(CASE WHEN t.responded_at IS NOT NULL THEN 1 ELSE 0 END) AS responded_count,
  SUM(CASE WHEN t.responded_at IS NOT NULL AND (t.response_due_at IS NULL OR t.responded_at <= t.response_due_at) THEN 1 ELSE 0 END) AS responded_on_time,
  AVG((SELECT AVG(rating) FROM csat_surveys WHERE ticket_id = t.id)) AS avg_csat,
  -- Acknowledgement and restoration, each averaged only over the tickets that
  -- actually reached that point. Dividing by everything would quietly improve
  -- the figure every time a ticket was ignored.
  AVG(CASE WHEN t.responded_at IS NOT NULL THEN (julianday(t.responded_at) - julianday(t.created_at)) * 24 ELSE NULL END) AS mtta_hours,
  AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 ELSE NULL END) AS mttr_hours,
  -- Resolved without ever being handed on. assignment_log records every
  -- reassignment, so "never reassigned" is the closest honest reading of
  -- first contact resolution this data supports.
  SUM(CASE WHEN t.status IN ('resolved','closed')
             AND (SELECT COUNT(*) FROM assignment_log al WHERE al.ticket_id = t.id) <= 1
           THEN 1 ELSE 0 END) AS fcr_count,
  SUM(CASE WHEN COALESCE(t.reopened_count, 0) > 0 THEN 1 ELSE 0 END) AS reopened_any,
  -- Only tickets that had a target count towards compliance; one with no
  -- policy attached is not a pass, it is not applicable.
  SUM(CASE WHEN t.sla_due_at IS NOT NULL THEN 1 ELSE 0 END) AS sla_applicable
`;

function deriveMetrics(r) {
  return {
    count: r.count,
    // SQL's SUM over zero rows is NULL, not 0. For a count of things that
    // happened, "none happened" is a fact worth stating, and leaving it null
    // made a period with no tickets indistinguishable from one we could not
    // measure -- a scorecard comparing against it simply dropped its trend.
    resolved: r.resolved ?? 0,
    breached: r.breached ?? 0,
    // The averages stay null on purpose: nothing was resolved, so there is no
    // average resolution time, and printing 0 would claim an instant fix.
    avg_resolution_hours: r.avg_resolution_hours,
    first_response_on_time_pct: r.responded_count > 0 ? Math.round((r.responded_on_time / r.responded_count) * 100) : null,
    avg_csat: r.avg_csat,
    mtta_hours: r.mtta_hours,
    mttr_hours: r.mttr_hours,
    // Each of these is a rate, so each needs its own denominator rather than
    // the row's total count.
    first_contact_resolution_pct: (r.resolved ?? 0) > 0 ? Math.round(((r.fcr_count ?? 0) / r.resolved) * 100) : null,
    reopen_rate_pct: (r.resolved ?? 0) > 0 ? Math.round(((r.reopened_any ?? 0) / r.resolved) * 100) : null,
    sla_compliance_pct: (r.sla_applicable ?? 0) > 0
      ? Math.round((((r.sla_applicable ?? 0) - (r.breached ?? 0)) / r.sla_applicable) * 100)
      : null,
  };
}

export function runCustomReport(workspaceId, { group_by, filters = {} } = {}) {
  const dim = GROUP_BY_DIMENSIONS[group_by];
  if (!dim) throw new Error(`group_by must be one of: ${Object.keys(GROUP_BY_DIMENSIONS).join(', ')}`);
  const { where, params } = buildWhere(workspaceId, filters);
  const join = dim.needsUserJoin ? 'LEFT JOIN users u ON u.id = t.assignee_id' : '';

  const sql = `
    SELECT ${dim.expr} AS group_key, ${METRICS_SELECT}
    FROM tickets t
    ${join}
    WHERE ${where}
    GROUP BY group_key
    ORDER BY group_key
  `;
  return db.prepare(sql).all(...params).map((r) => ({ group_key: r.group_key, ...deriveMetrics(r) }));
}

// Same window length immediately before `from` -- e.g. filters {from:
// '2026-08-01', to: '2026-08-31'} compares against 2026-07-02..2026-07-31.
// No explicit range given -> trailing 30 days vs. the 30 before that, a
// sensible default for "how are we trending" without the caller having to
// think about it.
export function previousPeriod(filters = {}) {
  let { from, to } = filters;
  if (!from || !to) {
    const now = new Date();
    to = now.toISOString().slice(0, 10);
    from = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
  }
  const fromD = new Date(`${from}T00:00:00Z`);
  const toD = new Date(`${to}T00:00:00Z`);
  const spanMs = Math.max(toD - fromD, 86400000);
  const prevTo = new Date(fromD.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - spanMs);
  return {
    current: { from, to },
    previous: { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) },
  };
}

// A true two-dimension crosstab (row x column -> count) -- e.g. Team down
// the side, Priority across the top. This is the one shape a flat group-by
// table can't express at all; ServiceNow calls this report type "Pivot
// Table" and it's also what powers the multi-series trend chart below
// (row=time period, column=whatever series you want broken out).
export function runPivotReport(workspaceId, { rowDim, colDim, filters = {} } = {}) {
  const rd = GROUP_BY_DIMENSIONS[rowDim];
  const cd = GROUP_BY_DIMENSIONS[colDim];
  if (!rd) throw new Error(`row must be one of: ${Object.keys(GROUP_BY_DIMENSIONS).join(', ')}`);
  if (!cd) throw new Error(`column must be one of: ${Object.keys(GROUP_BY_DIMENSIONS).join(', ')}`);
  const { where, params } = buildWhere(workspaceId, filters);
  const join = (rd.needsUserJoin || cd.needsUserJoin) ? 'LEFT JOIN users u ON u.id = t.assignee_id' : '';

  const sql = `
    SELECT ${rd.expr} AS row_key, ${cd.expr} AS col_key, COUNT(*) AS count
    FROM tickets t
    ${join}
    WHERE ${where}
    GROUP BY row_key, col_key
  `;
  const raw = db.prepare(sql).all(...params);
  const rowKeys = [...new Set(raw.map((r) => r.row_key))].sort();
  const colKeys = [...new Set(raw.map((r) => r.col_key))].sort();
  const matrix = Object.fromEntries(rowKeys.map((r) => [r, {}]));
  for (const row of raw) matrix[row.row_key][row.col_key] = row.count;

  const rowTotals = Object.fromEntries(rowKeys.map((r) => [r, colKeys.reduce((s, c) => s + (matrix[r][c] || 0), 0)]));
  const colTotals = Object.fromEntries(colKeys.map((c) => [c, rowKeys.reduce((s, r) => s + (matrix[r][c] || 0), 0)]));
  const grandTotal = Object.values(rowTotals).reduce((s, v) => s + v, 0);

  return { rowLabel: rd.label, colLabel: cd.label, rowKeys, colKeys, matrix, rowTotals, colTotals, grandTotal };
}

// Currently-open tickets bucketed by how long they've been open -- a classic
// backlog-health view that a flexible group-by can't express (it's a
// computed bucket, not a stored column).
export function runBacklogAging(workspaceId) {
  const rows = db.prepare(`
    SELECT
      CASE
        WHEN (julianday('now') - julianday(created_at)) < 1 THEN '0-1 days'
        WHEN (julianday('now') - julianday(created_at)) < 3 THEN '1-3 days'
        WHEN (julianday('now') - julianday(created_at)) < 7 THEN '3-7 days'
        WHEN (julianday('now') - julianday(created_at)) < 30 THEN '7-30 days'
        ELSE '30+ days'
      END AS bucket,
      COUNT(*) AS count
    FROM tickets
    WHERE workspace_id = ? AND status NOT IN ('resolved', 'closed')
    GROUP BY bucket
  `).all(workspaceId);
  const order = ['0-1 days', '1-3 days', '3-7 days', '7-30 days', '30+ days'];
  return order.map((bucket) => rows.find((r) => r.bucket === bucket) || { bucket, count: 0 });
}

// ---- Shapes the analytics cards need -------------------------------------

// One row of every metric for the filtered set, with no grouping at all.
// A scorecard asks "what is this number right now", and grouping then
// summing in JavaScript would get avg_resolution_hours and avg_csat wrong:
// averaging per-group averages weights a group of three tickets the same as
// a group of three hundred. This aggregates once, over the whole set.
export function runTotals(workspaceId, filters = {}) {
  const { where, params } = buildWhere(workspaceId, filters);
  const row = db.prepare(`SELECT ${METRICS_SELECT} FROM tickets t WHERE ${where}`).get(...params);
  return deriveMetrics(row || { count: 0, resolved: 0, breached: 0, responded_count: 0, responded_on_time: 0 });
}

// Grouped by one or two dimensions, with the full metric set on every row.
// Two dimensions is what a trend broken out by series needs (period down one
// axis, team or priority across the other) and what a table with a secondary
// grouping needs. runCustomReport stays as the one-dimension entry point it
// has always been.
export function runGrouped(workspaceId, { dims = [], filters = {} } = {}) {
  const resolved = dims.map((key) => {
    const dim = GROUP_BY_DIMENSIONS[key];
    if (!dim) throw new Error(`Unknown dimension: ${key}`);
    return { key, ...dim };
  });
  if (!resolved.length) throw new Error('At least one dimension is required');
  const { where, params } = buildWhere(workspaceId, filters);
  const join = resolved.some((d) => d.needsUserJoin) ? 'LEFT JOIN users u ON u.id = t.assignee_id' : '';
  const selects = resolved.map((d, i) => `${d.expr} AS key_${i}`).join(', ');
  const groupBy = resolved.map((_, i) => `key_${i}`).join(', ');

  const rows = db.prepare(`
    SELECT ${selects}, ${METRICS_SELECT}
    FROM tickets t
    ${join}
    WHERE ${where}
    GROUP BY ${groupBy}
    ORDER BY ${groupBy}
  `).all(...params);

  return rows.map((r) => ({
    keys: resolved.map((_, i) => r[`key_${i}`]),
    group_key: r.key_0,
    series_key: resolved.length > 1 ? r.key_1 : null,
    ...deriveMetrics(r),
  }));
}

// The periods a trend should show even where nothing happened. Without this
// a month with no tickets is simply missing from the SQL result, and a line
// chart then draws straight from the month before to the month after --
// which reads as "steady" when it should read as a gap.
export function periodsBetween(timeDim, from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const out = [];
  const iso = (d) => d.toISOString().slice(0, 10);
  if (timeDim === 'day') {
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(iso(d));
  } else if (timeDim === 'week') {
    // %W is the week number with Monday as day 1, matching the SQL above.
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 7)) {
      const jan1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const week = Math.floor((((d - jan1) / 86400000) + jan1.getUTCDay()) / 7);
      out.push(`${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`);
    }
  } else {
    for (let d = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1)); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) {
      out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
  }
  return [...new Set(out)];
}
