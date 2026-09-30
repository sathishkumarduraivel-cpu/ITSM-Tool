import { db, uid } from '../db.js';

export class BenchmarkError extends Error {
  constructor(message, status = 400, field_errors) {
    super(message);
    this.status = status;
    if (field_errors) this.field_errors = field_errors;
  }
}

/**
 * The KPI catalogue (§19).
 *
 * Every entry carries its calculation AND its denominator in words, because
 * the specification asks for benchmarks "reported with denominator
 * definitions" — and because most arguments about a service-desk number are
 * really arguments about what was counted. "SLA compliance 94%" means nothing
 * until you know whether tickets with no target counted as passes.
 *
 * `starting` values are the specification's examples. They are a starting
 * point for a customer to baseline against, never a contractual promise, and
 * nothing here treats them as one.
 */
export const KPIS = {
  incident_sla_compliance: {
    label: 'Incident SLA compliance',
    unit: 'percent',
    comparator: 'gte',
    starting: 90,
    calculation: 'Incidents that met their resolution target ÷ incidents that had one × 100',
    denominator: 'Incidents with an SLA target. One with no policy attached is not applicable, not a pass.',
  },
  p1_response_minutes: {
    label: 'P1 first response',
    unit: 'minutes',
    comparator: 'lte',
    starting: 15,
    calculation: 'Mean of (first response − created) for critical incidents',
    denominator: 'Critical incidents somebody actually responded to. Unanswered ones are excluded, so this cannot be improved by ignoring tickets.',
  },
  p1_restore_minutes: {
    label: 'P1 restoration',
    unit: 'minutes',
    comparator: 'lte',
    starting: 240,
    calculation: 'Mean of (resolved − created) for critical incidents',
    denominator: 'Critical incidents that were resolved in the period.',
  },
  p2_response_minutes: {
    label: 'P2 first response',
    unit: 'minutes',
    comparator: 'lte',
    starting: 30,
    calculation: 'Mean of (first response − created) for high incidents',
    denominator: 'High-priority incidents somebody responded to.',
  },
  mtta_minutes: {
    label: 'MTTA — time to acknowledge',
    unit: 'minutes',
    comparator: 'lte',
    starting: 30,
    calculation: 'Mean of (first response − created)',
    denominator: 'Tickets that received a first response.',
  },
  mttr_minutes: {
    label: 'MTTR — time to restore',
    unit: 'minutes',
    comparator: 'lte',
    starting: 480,
    calculation: 'Mean of (resolved − created)',
    denominator: 'Tickets resolved in the period.',
  },
  first_contact_resolution: {
    label: 'First contact resolution',
    unit: 'percent',
    comparator: 'gte',
    starting: 60,
    calculation: 'Resolved without ever being reassigned ÷ resolved × 100',
    denominator: 'Resolved tickets. "Never reassigned" is read from the assignment log — the closest honest reading this data supports.',
  },
  reopen_rate: {
    label: 'Reopen rate',
    unit: 'percent',
    comparator: 'lte',
    starting: 10,
    calculation: 'Tickets reopened at least once ÷ resolved × 100',
    denominator: 'Resolved tickets, not all tickets — an unresolved ticket cannot be reopened.',
  },
  change_success_rate: {
    label: 'Change success rate',
    unit: 'percent',
    comparator: 'gte',
    starting: 90,
    calculation: 'Changes that completed without being backed out ÷ completed changes × 100',
    denominator: 'Changes that actually finished. Ones still in flight are not counted either way.',
  },
  emergency_change_rate: {
    label: 'Emergency changes',
    unit: 'percent',
    comparator: 'lte',
    starting: 15,
    calculation: 'Emergency changes ÷ all changes × 100',
    denominator: 'Every change raised in the period, whatever its outcome.',
  },
  request_sla_compliance: {
    label: 'Request fulfilment against target',
    unit: 'percent',
    comparator: 'gte',
    starting: 90,
    calculation: 'Requests fulfilled within their target ÷ requests with a target × 100',
    denominator: 'Service requests that had a target.',
  },
  knowledge_review_compliance: {
    label: 'Knowledge review compliance',
    unit: 'percent',
    comparator: 'gte',
    starting: 90,
    calculation: 'Articles reviewed by their due date ÷ articles that fell due × 100',
    denominator: 'Published articles whose review date has passed.',
  },
  cmdb_critical_ownership: {
    label: 'Critical CIs with an owner',
    unit: 'percent',
    comparator: 'gte',
    starting: 100,
    calculation: 'Critical CIs with a valid owner ÷ critical CIs × 100',
    denominator: 'Configuration items in service. A retired CI is not counted.',
  },
};

const COMPARATORS = ['gte', 'lte'];
const isoDate = (d) => new Date(d).toISOString().slice(0, 10);
const today = () => isoDate(new Date());

// ---- targets -------------------------------------------------------------

/**
 * The target in force on a given date.
 *
 * Falls back to the specification's starting value when nobody has set one,
 * clearly flagged as a default, so a report never silently invents a target
 * the customer never agreed to.
 */
export function targetFor(workspaceId, kpi, onDate = today()) {
  const spec = KPIS[kpi];
  if (!spec) throw new BenchmarkError(`Unknown KPI: ${kpi}`, 400);
  const row = db.prepare(
    `SELECT * FROM benchmark_targets
     WHERE workspace_id = ? AND kpi = ?
       AND date(effective_from) <= date(?)
       AND (effective_to IS NULL OR date(effective_to) >= date(?))
     ORDER BY date(effective_from) DESC LIMIT 1`
  ).get(workspaceId, kpi, onDate, onDate);

  if (row) return { ...row, is_default: false, unit: spec.unit };
  return {
    kpi, target_value: spec.starting, comparator: spec.comparator,
    effective_from: null, effective_to: null, is_default: true, unit: spec.unit,
    note: 'The specification’s starting value — not a target this workspace has agreed.',
  };
}

export function listTargets(workspaceId, kpi) {
  const rows = kpi
    ? db.prepare('SELECT * FROM benchmark_targets WHERE workspace_id = ? AND kpi = ? ORDER BY date(effective_from) DESC').all(workspaceId, kpi)
    : db.prepare('SELECT * FROM benchmark_targets WHERE workspace_id = ? ORDER BY kpi, date(effective_from) DESC').all(workspaceId);
  return rows;
}

/**
 * Set a target from a date.
 *
 * Whatever was in force before is closed the day before this one starts, so
 * the history stays a continuous timeline: every date has exactly one target,
 * and asking "what were we aiming at in March" always has one answer.
 */
export function setTarget(workspaceId, user, { kpi, target_value, comparator, effective_from, note }) {
  const spec = KPIS[kpi];
  if (!spec) throw new BenchmarkError(`Unknown KPI: ${kpi}`, 400, [{ field: 'kpi', message: 'Not a KPI this app measures' }]);
  const value = Number(target_value);
  if (!Number.isFinite(value)) {
    throw new BenchmarkError('Give the target as a number.', 400, [{ field: 'target_value', message: 'Required' }]);
  }
  if (spec.unit === 'percent' && (value < 0 || value > 100)) {
    throw new BenchmarkError('A percentage target has to be between 0 and 100.', 400, [{ field: 'target_value', message: '0 to 100' }]);
  }
  if (value < 0) throw new BenchmarkError('A target cannot be negative.', 400, [{ field: 'target_value', message: 'Must be zero or more' }]);
  const cmp = comparator || spec.comparator;
  if (!COMPARATORS.includes(cmp)) {
    throw new BenchmarkError('Comparator must be gte or lte.', 400, [{ field: 'comparator', message: 'gte or lte' }]);
  }
  const from = effective_from || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    throw new BenchmarkError('Give the start date as YYYY-MM-DD.', 400, [{ field: 'effective_from', message: 'YYYY-MM-DD' }]);
  }

  db.exec('BEGIN');
  try {
    // Anything that was still open, or that overlaps this start, is closed
    // the day before — so two targets can never both be in force.
    db.prepare(
      `UPDATE benchmark_targets
       SET effective_to = date(?, '-1 day')
       WHERE workspace_id = ? AND kpi = ?
         AND date(effective_from) < date(?)
         AND (effective_to IS NULL OR date(effective_to) >= date(?))`
    ).run(from, workspaceId, kpi, from, from);
    // A target starting on the same day replaces rather than overlaps it.
    db.prepare('DELETE FROM benchmark_targets WHERE workspace_id = ? AND kpi = ? AND date(effective_from) = date(?)')
      .run(workspaceId, kpi, from);
    db.prepare(
      'INSERT INTO benchmark_targets (id, workspace_id, kpi, target_value, comparator, effective_from, note, created_by) VALUES (?,?,?,?,?,?,?,?)'
    ).run(uid('bmt'), workspaceId, kpi, value, cmp, from, String(note || '').trim() || null, user.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return listTargets(workspaceId, kpi);
}

export function deleteTarget(workspaceId, id) {
  const row = db.prepare('SELECT * FROM benchmark_targets WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new BenchmarkError('That target no longer exists.', 404);
  db.prepare('DELETE FROM benchmark_targets WHERE id = ?').run(id);
  // Whatever came before reopens, so the timeline has no hole in it.
  const previous = db.prepare(
    `SELECT id FROM benchmark_targets WHERE workspace_id = ? AND kpi = ? AND date(effective_from) < date(?)
     ORDER BY date(effective_from) DESC LIMIT 1`
  ).get(workspaceId, row.kpi, row.effective_from);
  if (previous) db.prepare('UPDATE benchmark_targets SET effective_to = ? WHERE id = ?').run(row.effective_to, previous.id);
  return listTargets(workspaceId, row.kpi);
}

// ---- measurement ---------------------------------------------------------

const window = (from, to) => ({ from: from || isoDate(new Date(Date.now() - 90 * 86400000)), to: to || today() });

// Each calculator returns { value, numerator, denominator } so a figure can
// always be shown with what it was actually computed from.
const CALCULATORS = {
  incident_sla_compliance(ws, { from, to }) {
    const r = db.prepare(
      `SELECT
         SUM(CASE WHEN sla_due_at IS NOT NULL THEN 1 ELSE 0 END) AS applicable,
         SUM(CASE WHEN sla_due_at IS NOT NULL AND status IN ('resolved','closed')
                   AND datetime(COALESCE(resolved_at, closed_at)) <= datetime(sla_due_at) THEN 1 ELSE 0 END) AS met
       FROM tickets WHERE workspace_id = ? AND type = 'incident' AND deleted_at IS NULL
         AND date(created_at) BETWEEN date(?) AND date(?)`
    ).get(ws, from, to);
    const d = r.applicable || 0;
    return { value: d ? Math.round(((r.met || 0) / d) * 100) : null, numerator: r.met || 0, denominator: d };
  },
  p1_response_minutes: (ws, w) => responseMinutes(ws, w, 'critical'),
  p2_response_minutes: (ws, w) => responseMinutes(ws, w, 'high'),
  p1_restore_minutes(ws, { from, to }) {
    const r = db.prepare(
      `SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 1440) AS avg_minutes, COUNT(*) AS n
       FROM tickets WHERE workspace_id = ? AND type = 'incident' AND priority = 'critical'
         AND resolved_at IS NOT NULL AND deleted_at IS NULL
         AND date(created_at) BETWEEN date(?) AND date(?)`
    ).get(ws, from, to);
    return { value: r.n ? Math.round(r.avg_minutes) : null, numerator: null, denominator: r.n || 0 };
  },
  mtta_minutes(ws, { from, to }) {
    const r = db.prepare(
      `SELECT AVG((julianday(responded_at) - julianday(created_at)) * 1440) AS avg_minutes, COUNT(*) AS n
       FROM tickets WHERE workspace_id = ? AND responded_at IS NOT NULL AND deleted_at IS NULL
         AND date(created_at) BETWEEN date(?) AND date(?)`
    ).get(ws, from, to);
    return { value: r.n ? Math.round(r.avg_minutes) : null, numerator: null, denominator: r.n || 0 };
  },
  mttr_minutes(ws, { from, to }) {
    const r = db.prepare(
      `SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 1440) AS avg_minutes, COUNT(*) AS n
       FROM tickets WHERE workspace_id = ? AND resolved_at IS NOT NULL AND deleted_at IS NULL
         AND date(created_at) BETWEEN date(?) AND date(?)`
    ).get(ws, from, to);
    return { value: r.n ? Math.round(r.avg_minutes) : null, numerator: null, denominator: r.n || 0 };
  },
  first_contact_resolution(ws, { from, to }) {
    const r = db.prepare(
      `SELECT COUNT(*) AS resolved,
              SUM(CASE WHEN (SELECT COUNT(*) FROM assignment_log al WHERE al.ticket_id = t.id) <= 1 THEN 1 ELSE 0 END) AS first_time
       FROM tickets t WHERE t.workspace_id = ? AND t.status IN ('resolved','closed') AND t.deleted_at IS NULL
         AND date(t.created_at) BETWEEN date(?) AND date(?)`
    ).get(ws, from, to);
    const d = r.resolved || 0;
    return { value: d ? Math.round(((r.first_time || 0) / d) * 100) : null, numerator: r.first_time || 0, denominator: d };
  },
  reopen_rate(ws, { from, to }) {
    const r = db.prepare(
      `SELECT COUNT(*) AS resolved, SUM(CASE WHEN COALESCE(reopened_count,0) > 0 THEN 1 ELSE 0 END) AS reopened
       FROM tickets WHERE workspace_id = ? AND status IN ('resolved','closed') AND deleted_at IS NULL
         AND date(created_at) BETWEEN date(?) AND date(?)`
    ).get(ws, from, to);
    const d = r.resolved || 0;
    return { value: d ? Math.round(((r.reopened || 0) / d) * 100) : null, numerator: r.reopened || 0, denominator: d };
  },
  change_success_rate(ws, { from, to }) {
    const r = db.prepare(
      `SELECT COUNT(*) AS completed,
              SUM(CASE WHEN COALESCE(change_state,'') NOT IN ('failed','backed_out') THEN 1 ELSE 0 END) AS succeeded
       FROM tickets WHERE workspace_id = ? AND type = 'change' AND deleted_at IS NULL
         AND status IN ('resolved','closed')
         AND date(created_at) BETWEEN date(?) AND date(?)`
    ).get(ws, from, to);
    const d = r.completed || 0;
    return { value: d ? Math.round(((r.succeeded || 0) / d) * 100) : null, numerator: r.succeeded || 0, denominator: d };
  },
  emergency_change_rate(ws, { from, to }) {
    const r = db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN change_type = 'emergency' THEN 1 ELSE 0 END) AS emergency
       FROM tickets WHERE workspace_id = ? AND type = 'change' AND deleted_at IS NULL
         AND date(created_at) BETWEEN date(?) AND date(?)`
    ).get(ws, from, to);
    const d = r.total || 0;
    return { value: d ? Math.round(((r.emergency || 0) / d) * 100) : null, numerator: r.emergency || 0, denominator: d };
  },
  request_sla_compliance(ws, { from, to }) {
    const r = db.prepare(
      `SELECT SUM(CASE WHEN sla_due_at IS NOT NULL THEN 1 ELSE 0 END) AS applicable,
              SUM(CASE WHEN sla_due_at IS NOT NULL AND status IN ('resolved','closed')
                        AND datetime(COALESCE(resolved_at, closed_at)) <= datetime(sla_due_at) THEN 1 ELSE 0 END) AS met
       FROM tickets WHERE workspace_id = ? AND type = 'request' AND deleted_at IS NULL
         AND date(created_at) BETWEEN date(?) AND date(?)`
    ).get(ws, from, to);
    const d = r.applicable || 0;
    return { value: d ? Math.round(((r.met || 0) / d) * 100) : null, numerator: r.met || 0, denominator: d };
  },
  knowledge_review_compliance(ws) {
    // Not windowed by creation: what matters is which articles are due now.
    const r = db.prepare(
      `SELECT COUNT(*) AS due,
              SUM(CASE WHEN last_reviewed_at IS NOT NULL AND date(last_reviewed_at) >= date(review_due_at) THEN 1 ELSE 0 END) AS reviewed
       FROM kb_articles WHERE workspace_id = ? AND status = 'published'
         AND review_due_at IS NOT NULL AND date(review_due_at) <= date('now')`
    ).get(ws);
    const d = r.due || 0;
    return { value: d ? Math.round(((r.reviewed || 0) / d) * 100) : null, numerator: r.reviewed || 0, denominator: d };
  },
  cmdb_critical_ownership(ws) {
    const r = db.prepare(
      `SELECT COUNT(*) AS critical, SUM(CASE WHEN owner_id IS NOT NULL AND owner_id != '' THEN 1 ELSE 0 END) AS owned
       FROM assets WHERE workspace_id = ? AND COALESCE(status,'') NOT IN ('retired','disposed')`
    ).get(ws);
    const d = r.critical || 0;
    return { value: d ? Math.round(((r.owned || 0) / d) * 100) : null, numerator: r.owned || 0, denominator: d };
  },
};

function responseMinutes(ws, { from, to }, priority) {
  const r = db.prepare(
    `SELECT AVG((julianday(responded_at) - julianday(created_at)) * 1440) AS avg_minutes, COUNT(*) AS n
     FROM tickets WHERE workspace_id = ? AND type = 'incident' AND priority = ?
       AND responded_at IS NOT NULL AND deleted_at IS NULL
       AND date(created_at) BETWEEN date(?) AND date(?)`
  ).get(ws, priority, from, to);
  return { value: r.n ? Math.round(r.avg_minutes) : null, numerator: null, denominator: r.n || 0 };
}

const meets = (value, target, comparator) => {
  if (value === null || value === undefined) return null;
  return comparator === 'lte' ? value <= target : value >= target;
};

/**
 * Measure one KPI over a period, against the target that was in force.
 *
 * The target is looked up at the START of the window, not today, which is the
 * entire point of versioning: a quarter is judged by what the desk was
 * actually aiming at during it.
 */
export function measure(workspaceId, kpi, { from, to } = {}) {
  const spec = KPIS[kpi];
  if (!spec) throw new BenchmarkError(`Unknown KPI: ${kpi}`, 400);
  const w = window(from, to);
  const target = targetFor(workspaceId, kpi, w.from);
  const result = CALCULATORS[kpi](workspaceId, w);
  return {
    kpi,
    label: spec.label,
    unit: spec.unit,
    calculation: spec.calculation,
    denominator_definition: spec.denominator,
    period: w,
    value: result.value,
    numerator: result.numerator,
    denominator: result.denominator,
    target: target.target_value,
    comparator: target.comparator,
    target_is_default: target.is_default,
    target_effective_from: target.effective_from,
    met: meets(result.value, target.target_value, target.comparator),
    // A figure computed from almost nothing is not wrong, but it is not
    // evidence either, and presenting it as a red or green light would be.
    low_confidence: result.denominator !== null && result.denominator < 5,
  };
}

export function scorecard(workspaceId, { from, to } = {}) {
  return Object.keys(KPIS).map((kpi) => measure(workspaceId, kpi, { from, to }));
}

export function benchmarkMeta() {
  return {
    kpis: Object.entries(KPIS).map(([key, k]) => ({ key, ...k })),
    comparators: COMPARATORS,
  };
}
