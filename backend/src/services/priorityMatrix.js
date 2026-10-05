import { db, uid } from '../db.js';
import { listFieldOptions } from './ticketFields.js';

export class PriorityError extends Error {
  constructor(message, status = 400, field_errors) {
    super(message);
    this.status = status;
    if (field_errors) this.field_errors = field_errors;
  }
}

// The four priority values are locked in the Field Manager because SLA
// targets, escalation ranking and major-incident promotion all key off them.
// The grid may therefore only ever produce one of these.
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];

// The starting grid from the specification's baseline (§5.4). Where the spec
// gives a band ("P2/P3") the more urgent of the two is taken: under-grading a
// ticket costs service, over-grading costs a little attention, and the grid
// is meant to be tuned against real data afterwards anyway.
const BASELINE = {
  'high|high': 'critical',
  'high|medium': 'high',
  'high|low': 'high',
  'medium|high': 'high',
  'medium|medium': 'medium',
  'medium|low': 'medium',
  'low|high': 'medium',
  'low|medium': 'low',
  'low|low': 'low',
};

const key = (impact, urgency) => `${impact}|${urgency}`;

// Ranks are only used to fill combinations the baseline does not name --
// which happens as soon as an admin adds a fourth impact value. Position in
// the configured option list is the ranking: the Field Manager already orders
// these, so the grid inherits that order rather than inventing its own.
function positionRank(values, value) {
  const i = values.indexOf(value);
  if (i === -1 || values.length < 2) return 0.5;
  return i / (values.length - 1);
}

// A combination nobody configured still needs an answer when the grid is
// first built. Combining the two positions and mapping onto the four
// priorities gives a defensible starting point that an admin can then
// correct -- far better than leaving most of a 5x5 grid blank.
function inferPriority(impacts, urgencies, impact, urgency) {
  const named = BASELINE[key(impact, urgency)];
  if (named) return named;
  const score = (positionRank(impacts, impact) + positionRank(urgencies, urgency)) / 2;
  if (score >= 0.84) return 'critical';
  if (score >= 0.6) return 'high';
  if (score >= 0.3) return 'medium';
  return 'low';
}

// listFieldOptions already excludes inactive options and seeds the
// defaults on first use.
const optionValues = (workspaceId, field) => listFieldOptions(workspaceId, field).map((o) => o.value);

// Fills any combination that has no row yet, on first use and afterwards.
//
// It fills GAPS rather than seeding only an empty grid, for two reasons.
// A blank cell is not a neutral state: priority stops deriving for it, so
// tickets with that combination quietly keep whatever priority they had,
// which looks like the feature is broken. And adding a fourth impact value
// in the Field Manager would otherwise leave a whole row blank until someone
// noticed. An inferred starting value that an admin can correct is far more
// useful than a hole.
//
// (It also has to work this way: an "is the grid empty?" guard meant that
// setting a single cell on a fresh workspace made the grid non-empty and so
// permanently prevented the rest of it from ever being seeded.)
export function ensureMatrix(workspaceId) {
  const impacts = optionValues(workspaceId, 'impact');
  const urgencies = optionValues(workspaceId, 'urgency');
  if (!impacts.length || !urgencies.length) return;
  const have = new Set(
    db.prepare('SELECT impact, urgency FROM priority_matrix WHERE workspace_id = ?').all(workspaceId)
      .map((r) => key(r.impact, r.urgency))
  );
  const gaps = [];
  for (const impact of impacts) {
    for (const urgency of urgencies) {
      if (!have.has(key(impact, urgency))) gaps.push([impact, urgency]);
    }
  }
  if (!gaps.length) return;
  const stmt = db.prepare('INSERT OR IGNORE INTO priority_matrix (id, workspace_id, impact, urgency, priority) VALUES (?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (const [impact, urgency] of gaps) {
      stmt.run(uid('pmx'), workspaceId, impact, urgency, inferPriority(impacts, urgencies, impact, urgency));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// The grid as the admin screen needs it: the axes in their configured order,
// plus any row whose impact or urgency value no longer exists as an option,
// reported separately rather than quietly dropped -- a stale row still
// decides priority for tickets that hold that value.
export function getMatrix(workspaceId) {
  ensureMatrix(workspaceId);
  const impacts = listFieldOptions(workspaceId, 'impact');
  const urgencies = listFieldOptions(workspaceId, 'urgency');
  const rows = db.prepare('SELECT impact, urgency, priority FROM priority_matrix WHERE workspace_id = ?').all(workspaceId);
  const cells = Object.fromEntries(rows.map((r) => [key(r.impact, r.urgency), r.priority]));

  const impactValues = impacts.map((o) => o.value);
  const urgencyValues = urgencies.map((o) => o.value);
  const orphans = rows.filter((r) => !impactValues.includes(r.impact) || !urgencyValues.includes(r.urgency));
  const missing = [];
  for (const i of impactValues) {
    for (const u of urgencyValues) if (cells[key(i, u)] === undefined) missing.push({ impact: i, urgency: u });
  }

  return {
    impacts, urgencies, cells,
    priorities: listFieldOptions(workspaceId, 'priority'),
    orphans,
    missing,
  };
}

export function setCell(workspaceId, impact, urgency, priority) {
  if (!PRIORITIES.includes(priority)) {
    throw new PriorityError(`Priority must be one of: ${PRIORITIES.join(', ')}`, 400, [{ field: 'priority', message: 'Not a priority' }]);
  }
  if (!optionValues(workspaceId, 'impact').includes(impact)) {
    throw new PriorityError('That impact value is not configured.', 400, [{ field: 'impact', message: 'Unknown impact' }]);
  }
  if (!optionValues(workspaceId, 'urgency').includes(urgency)) {
    throw new PriorityError('That urgency value is not configured.', 400, [{ field: 'urgency', message: 'Unknown urgency' }]);
  }
  const existing = db.prepare('SELECT id FROM priority_matrix WHERE workspace_id = ? AND impact = ? AND urgency = ?').get(workspaceId, impact, urgency);
  if (existing) db.prepare('UPDATE priority_matrix SET priority = ? WHERE id = ?').run(priority, existing.id);
  else db.prepare('INSERT INTO priority_matrix (id, workspace_id, impact, urgency, priority) VALUES (?,?,?,?,?)').run(uid('pmx'), workspaceId, impact, urgency, priority);
  return getMatrix(workspaceId);
}

export function setMatrix(workspaceId, cells) {
  if (!Array.isArray(cells) || !cells.length) throw new PriorityError('Send the cells to set.', 400);
  db.exec('BEGIN');
  try {
    for (const c of cells) setCell(workspaceId, c.impact, c.urgency, c.priority);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getMatrix(workspaceId);
}

// Reset to the baseline, used by the admin screen's "start again" action.
export function resetMatrix(workspaceId) {
  db.prepare('DELETE FROM priority_matrix WHERE workspace_id = ?').run(workspaceId);
  ensureMatrix(workspaceId);
  return getMatrix(workspaceId);
}

// The grid's answer for a combination, or null when it cannot say -- either
// half is missing, or nobody has configured that pairing. Null means "leave
// the priority alone", never "default to medium".
export function derivePriority(workspaceId, impact, urgency) {
  if (!impact || !urgency) return null;
  ensureMatrix(workspaceId);
  const row = db.prepare('SELECT priority FROM priority_matrix WHERE workspace_id = ? AND impact = ? AND urgency = ?').get(workspaceId, impact, urgency);
  return row ? row.priority : null;
}

/**
 * Works out what a ticket's priority should become, given what is changing.
 *
 * The rule the whole feature rests on: priority follows the grid unless
 * somebody has deliberately overruled it, and overruling it costs a written
 * reason. That keeps the grid meaningful -- an override you have to justify
 * is an exception, an override you can make silently is just a second way to
 * set priority, and then the grid decides nothing.
 *
 * Returns the fields to write plus a description of what happened, so the
 * caller can record it in history without re-deriving the reasoning.
 */
export function resolvePriority(workspaceId, current, incoming, user) {
  const impact = incoming.impact !== undefined ? incoming.impact : current?.impact;
  const urgency = incoming.urgency !== undefined ? incoming.urgency : current?.urgency;
  const wasOverridden = !!current?.priority_overridden;

  // An explicit priority in the payload that disagrees with the grid is an
  // override attempt.
  const askedFor = incoming.priority;
  const derived = derivePriority(workspaceId, impact, urgency);

  if (askedFor !== undefined && askedFor !== null && askedFor !== '') {
    if (!PRIORITIES.includes(askedFor)) {
      throw new PriorityError(`Priority must be one of: ${PRIORITIES.join(', ')}`, 400, [{ field: 'priority', message: 'Not a priority' }]);
    }
    // Asking for exactly what the grid says is not an override; it is
    // agreement, and it should not demand a justification.
    if (derived !== null && askedFor === derived) {
      return {
        fields: { priority: derived, urgency, impact, priority_overridden: 0, priority_override_reason: null, priority_override_by: null, priority_override_at: null },
        change: wasOverridden ? { kind: 'override_cleared', priority: derived } : null,
      };
    }
    if (derived !== null && askedFor !== derived) {
      const reason = String(incoming.priority_override_reason || '').trim();
      if (!reason) {
        throw new PriorityError(
          `Impact and urgency give ${derived}. Setting ${askedFor} instead needs a reason.`,
          400,
          [{ field: 'priority_override_reason', message: 'Say why the grid is wrong for this ticket' }]
        );
      }
      return {
        fields: {
          priority: askedFor, urgency, impact,
          priority_overridden: 1,
          priority_override_reason: reason,
          priority_override_by: user?.id || null,
          priority_override_at: new Date().toISOString(),
        },
        change: { kind: 'overridden', priority: askedFor, derived, reason },
      };
    }
    // Nothing to derive from, so a directly-set priority is simply the value.
    return { fields: { priority: askedFor, urgency, impact }, change: null };
  }

  // No priority in the payload. Re-derive, unless a human has overruled it --
  // in which case changing impact or urgency must not quietly undo their
  // decision behind their back.
  if (derived === null) return { fields: { urgency, impact }, change: null };
  if (wasOverridden) {
    return {
      fields: { urgency, impact },
      change: (impact !== current?.impact || urgency !== current?.urgency)
        ? { kind: 'override_held', priority: current.priority, derived }
        : null,
    };
  }
  if (derived === current?.priority) return { fields: { urgency, impact }, change: null };
  return {
    fields: { priority: derived, urgency, impact, priority_overridden: 0 },
    change: { kind: 'derived', priority: derived, from: current?.priority ?? null },
  };
}

// How often the grid is being overruled, and for which combinations. A grid
// that is overruled constantly is not describing how this desk actually
// triages, and that is worth surfacing rather than leaving in the data.
export function overrideReport(workspaceId, { days = 90 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const total = db.prepare(
    "SELECT COUNT(*) c FROM tickets WHERE workspace_id = ? AND created_at >= ? AND urgency IS NOT NULL AND impact IS NOT NULL"
  ).get(workspaceId, since).c;
  const overridden = db.prepare(
    'SELECT COUNT(*) c FROM tickets WHERE workspace_id = ? AND created_at >= ? AND priority_overridden = 1'
  ).get(workspaceId, since).c;
  const combos = db.prepare(
    `SELECT impact, urgency, priority, COUNT(*) c
     FROM tickets
     WHERE workspace_id = ? AND created_at >= ? AND priority_overridden = 1
     GROUP BY impact, urgency, priority
     ORDER BY c DESC
     LIMIT 10`
  ).all(workspaceId, since);
  return {
    days,
    graded: total,
    overridden,
    override_rate: total > 0 ? Math.round((overridden / total) * 100) : null,
    combinations: combos.map((r) => ({
      ...r,
      grid_says: derivePriority(workspaceId, r.impact, r.urgency),
    })),
  };
}
