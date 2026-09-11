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
    WHEN t.status IN ('resolved','closed') THEN (CASE WHEN COALESCE(t.resolved_at, t.closed_at) > t.sla_due_at THEN 1 ELSE 0 END)
    ELSE (CASE WHEN datetime('now') > t.sla_due_at THEN 1 ELSE 0 END)
  END) AS breached,
  AVG(CASE WHEN t.resolved_at IS NOT NULL THEN (julianday(t.resolved_at) - julianday(t.created_at)) * 24 ELSE NULL END) AS avg_resolution_hours,
  SUM(CASE WHEN t.responded_at IS NOT NULL THEN 1 ELSE 0 END) AS responded_count,
  SUM(CASE WHEN t.responded_at IS NOT NULL AND (t.response_due_at IS NULL OR t.responded_at <= t.response_due_at) THEN 1 ELSE 0 END) AS responded_on_time,
  AVG((SELECT AVG(rating) FROM csat_surveys WHERE ticket_id = t.id)) AS avg_csat
`;

function deriveMetrics(r) {
  return {
    count: r.count,
    resolved: r.resolved,
    breached: r.breached,
    avg_resolution_hours: r.avg_resolution_hours,
    first_response_on_time_pct: r.responded_count > 0 ? Math.round((r.responded_on_time / r.responded_count) * 100) : null,
    avg_csat: r.avg_csat,
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
