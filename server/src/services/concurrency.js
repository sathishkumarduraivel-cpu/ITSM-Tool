import { db } from '../db.js';

/**
 * Optimistic locking (§4.2, §23).
 *
 * The problem this solves is quiet: two agents open the same ticket, both
 * edit, both save, and the second write silently erases the first. Nobody
 * sees an error — the work simply is not there any more. During a major
 * incident, when several people are deliberately working the same record,
 * this is the normal case rather than an edge case.
 *
 * The approach is optimistic rather than locking the row: a client sends back
 * the version it loaded, and a write against a stale version is refused. That
 * keeps every read cheap and never leaves a record locked by someone who
 * closed their laptop.
 *
 * A refusal is only useful if the person can act on it, so a conflict comes
 * back with what actually changed, who changed it and when — enough to decide
 * whether to re-apply an edit or abandon it.
 */
export class ConflictError extends Error {
  constructor(message, conflict) {
    super(message);
    this.status = 409;
    this.conflict = conflict;
  }
}

// Only tables this module has been given a version column are lockable, so a
// typo cannot silently disable the check.
const LOCKABLE = new Set(['tickets', 'major_incidents']);

const assertLockable = (table) => {
  if (!LOCKABLE.has(table)) throw new Error(`${table} has no version column — add one before locking it`);
};

/**
 * Compare the version a client is writing against with the stored one.
 *
 * A caller that sends no version at all is allowed through: the API has
 * plenty of legitimate non-interactive clients (automations, the public API,
 * monitoring integrations) that have no user staring at a stale form, and
 * forcing a version on them would break every one of them for no benefit.
 * The check protects the case it is meant to protect — a human editing a form
 * they loaded a while ago.
 */
export function checkVersion(table, id, expected, { fields = [], current } = {}) {
  assertLockable(table);
  if (expected === undefined || expected === null || expected === '') return null;
  const wanted = Number(expected);
  if (!Number.isFinite(wanted)) return null;

  const row = current || db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) return null;
  const actual = Number(row.row_version ?? 1);
  if (wanted === actual) return null;

  throw new ConflictError(
    'Somebody else changed this while you were editing it.',
    describeConflict(table, row, fields)
  );
}

// What changed, so the message can be specific rather than a shrug. The
// fields the caller was trying to write are named first, because those are
// the ones whose loss the person will actually notice.
function describeConflict(table, row, attemptedFields) {
  const editor = row.updated_by
    ? db.prepare('SELECT name FROM users WHERE id = ?').get(row.updated_by)
    : null;
  const recent = table === 'tickets'
    ? db.prepare('SELECT event, detail, created_at FROM ticket_history WHERE ticket_id = ? ORDER BY created_at DESC LIMIT 5').all(row.id)
    : [];
  return {
    current_version: Number(row.row_version ?? 1),
    updated_at: row.updated_at || null,
    updated_by: row.updated_by || null,
    updated_by_name: editor?.name || null,
    // The values as they stand now, limited to what this write was touching,
    // so a client can show "theirs vs yours" without fetching the record again.
    current_values: Object.fromEntries(
      attemptedFields.filter((f) => f in row).map((f) => [f, row[f]])
    ),
    recent_changes: recent,
  };
}

// Added to every UPDATE this module guards. Returned as SQL fragments rather
// than run separately so the bump lands in the same statement as the change --
// there is no window in which a row is written but still holds its old
// version.
export function versionBump(userId) {
  return {
    sql: ['row_version = COALESCE(row_version, 1) + 1', 'updated_by = ?'],
    params: [userId ?? null],
  };
}

export const currentVersion = (table, id) => {
  assertLockable(table);
  const row = db.prepare(`SELECT row_version FROM ${table} WHERE id = ?`).get(id);
  return row ? Number(row.row_version ?? 1) : null;
};
