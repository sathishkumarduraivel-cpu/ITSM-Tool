// How the catalog is actually performing.
//
// The three questions worth answering, chosen because each one ends in a
// decision: what do people order (so you know what to automate), are we
// meeting the delivery promise we printed on the item (so the promise is
// honest), and where do requests sit waiting (which is almost always an
// approver, not the fulfilment team).
//
// Computed on read from the tickets and approvals that already exist. Nothing
// precomputed, no scheduler -- the same approach the SLA clock and change
// risk take elsewhere in this codebase.
import { db } from '../db.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

// SQLite datetimes have no zone marker, so they are compared as strings and
// parsed as UTC when a duration is needed. Treating them as local time is the
// drift this codebase has been bitten by before.
const parseTs = (v) => (v ? Date.parse(String(v).replace(' ', 'T') + 'Z') : null);
const hoursBetween = (a, b) => {
  const from = parseTs(a); const to = parseTs(b);
  if (!from || !to || to < from) return null;
  return Math.round(((to - from) / 3600000) * 10) / 10;
};

export function catalogOverview(workspaceId, { days = 30 } = {}) {
  const since = daysAgo(days);

  const counts = db.prepare(
    `SELECT
       COUNT(*) total,
       SUM(CASE WHEN status = 'pending_approval' THEN 1 ELSE 0 END) awaiting_approval,
       SUM(CASE WHEN status IN ('resolved','closed') THEN 1 ELSE 0 END) completed,
       SUM(COALESCE(catalog_cost, 0)) total_cost
     FROM tickets
     WHERE workspace_id = ? AND source = 'catalog' AND substr(created_at,1,10) >= ?`
  ).get(workspaceId, since);

  const itemCounts = db.prepare(
    `SELECT
       COUNT(*) total,
       SUM(CASE WHEN COALESCE(status,'published') = 'published' AND enabled = 1 THEN 1 ELSE 0 END) published,
       SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) drafts,
       SUM(CASE WHEN status = 'retired' THEN 1 ELSE 0 END) retired
     FROM catalog_items WHERE workspace_id = ?`
  ).get(workspaceId);

  // An item nobody has ever ordered is either badly named, badly placed, or
  // something nobody needs -- all three worth knowing.
  const neverRequested = db.prepare(
    `SELECT id, name FROM catalog_items
     WHERE workspace_id = ? AND COALESCE(status,'published') = 'published' AND enabled = 1
       AND COALESCE(request_count,0) = 0
     ORDER BY name LIMIT 10`
  ).all(workspaceId);

  const top = db.prepare(
    `SELECT ci.id, ci.name, COUNT(t.id) requests
     FROM tickets t JOIN catalog_items ci ON ci.id = t.catalog_item_id
     WHERE t.workspace_id = ? AND substr(t.created_at,1,10) >= ?
     GROUP BY ci.id ORDER BY requests DESC LIMIT 10`
  ).all(workspaceId, since);

  return {
    days,
    requests: {
      total: counts.total || 0,
      awaiting_approval: counts.awaiting_approval || 0,
      completed: counts.completed || 0,
      total_cost: Math.round((counts.total_cost || 0) * 100) / 100,
    },
    items: itemCounts,
    most_requested: top,
    never_requested: neverRequested,
    delivery: deliveryPerformance(workspaceId, since),
  };
}

/**
 * Did we deliver by the date the item promised.
 *
 * Only requests on items that actually carry a delivery promise are counted;
 * folding in the ones with no target would quietly inflate the figure with
 * rows that could never have been late.
 */
function deliveryPerformance(workspaceId, since) {
  const rows = db.prepare(
    `SELECT t.fulfilment_due_at, t.resolved_at, t.status
     FROM tickets t
     WHERE t.workspace_id = ? AND t.source = 'catalog'
       AND t.fulfilment_due_at IS NOT NULL AND substr(t.created_at,1,10) >= ?`
  ).all(workspaceId, since);

  if (!rows.length) {
    return { measured: 0, on_time: 0, late: 0, outstanding: 0, on_time_rate: null, note: 'No requests on items with a delivery target in this period.' };
  }

  let onTime = 0; let late = 0; let outstanding = 0; let overdueNow = 0;
  const now = Date.now();
  for (const r of rows) {
    if (r.resolved_at) {
      if (parseTs(r.resolved_at) <= parseTs(r.fulfilment_due_at)) onTime += 1; else late += 1;
    } else {
      outstanding += 1;
      if (parseTs(r.fulfilment_due_at) < now) overdueNow += 1;
    }
  }
  const finished = onTime + late;
  return {
    measured: rows.length,
    on_time: onTime,
    late,
    outstanding,
    overdue_now: overdueNow,
    // Rate is over FINISHED requests only. Counting the ones still in flight
    // as on time would make the number look best on the day work stops.
    on_time_rate: finished ? Math.round((onTime / finished) * 1000) / 10 : null,
  };
}

/**
 * Per item: how often, how long, how much, and whether it hit its promise.
 */
export function itemPerformance(workspaceId, { days = 90 } = {}) {
  const since = daysAgo(days);
  const rows = db.prepare(
    `SELECT ci.id, ci.name, ci.delivery_days, ci.cost, ci.currency,
            COUNT(t.id) requests,
            SUM(CASE WHEN t.status IN ('resolved','closed') THEN 1 ELSE 0 END) completed,
            SUM(COALESCE(t.catalog_cost,0)) spend
     FROM catalog_items ci
     LEFT JOIN tickets t ON t.catalog_item_id = ci.id AND substr(t.created_at,1,10) >= ?
     WHERE ci.workspace_id = ?
     GROUP BY ci.id ORDER BY requests DESC, ci.name`
  ).all(since, workspaceId);

  return rows.map((r) => {
    const times = db.prepare(
      `SELECT created_at, resolved_at, fulfilment_due_at FROM tickets
       WHERE catalog_item_id = ? AND resolved_at IS NOT NULL AND substr(created_at,1,10) >= ?`
    ).all(r.id, since);

    const durations = times.map((t) => hoursBetween(t.created_at, t.resolved_at)).filter((h) => h !== null);
    const withTarget = times.filter((t) => t.fulfilment_due_at);
    const onTime = withTarget.filter((t) => parseTs(t.resolved_at) <= parseTs(t.fulfilment_due_at)).length;

    return {
      ...r,
      spend: Math.round((r.spend || 0) * 100) / 100,
      avg_hours_to_complete: durations.length
        ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
        : null,
      on_time_rate: withTarget.length ? Math.round((onTime / withTarget.length) * 1000) / 10 : null,
    };
  });
}

/**
 * Where requests actually wait.
 *
 * Almost always an approver rather than the fulfilment team, which is why
 * this is broken out: "requests are slow" and "one person has fourteen
 * approvals sitting in their inbox" call for completely different responses.
 */
export function approvalBottlenecks(workspaceId, { days = 30 } = {}) {
  const since = daysAgo(days);

  const pending = db.prepare(
    `SELECT a.id, a.approver_id, a.approver_role, a.created_at, t.number, t.title, t.id AS ticket_id,
            u.name AS approver_name
     FROM approvals a
     JOIN tickets t ON t.id = a.ticket_id
     LEFT JOIN users u ON u.id = a.approver_id
     WHERE t.workspace_id = ? AND t.source = 'catalog' AND a.status = 'pending'
     ORDER BY a.created_at ASC`
  ).all(workspaceId);

  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const waiting = pending.map((p) => ({ ...p, waiting_hours: hoursBetween(p.created_at, now) }));

  const byApprover = new Map();
  for (const w of waiting) {
    const key = w.approver_name || `Role: ${w.approver_role || 'admin'}`;
    if (!byApprover.has(key)) byApprover.set(key, { approver: key, pending: 0, oldest_hours: 0 });
    const e = byApprover.get(key);
    e.pending += 1;
    e.oldest_hours = Math.max(e.oldest_hours, w.waiting_hours || 0);
  }

  const decided = db.prepare(
    `SELECT a.created_at, a.decided_at, a.status FROM approvals a
     JOIN tickets t ON t.id = a.ticket_id
     WHERE t.workspace_id = ? AND t.source = 'catalog' AND a.decided_at IS NOT NULL
       AND substr(a.created_at,1,10) >= ?`
  ).all(workspaceId, since);

  const turnarounds = decided.map((d) => hoursBetween(d.created_at, d.decided_at)).filter((h) => h !== null);

  return {
    days,
    pending_total: waiting.length,
    oldest: waiting.slice(0, 10),
    by_approver: [...byApprover.values()].sort((a, b) => b.pending - a.pending),
    avg_decision_hours: turnarounds.length
      ? Math.round((turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length) * 10) / 10
      : null,
    rejected: decided.filter((d) => d.status === 'rejected').length,
    approved: decided.filter((d) => d.status === 'approved').length,
  };
}
