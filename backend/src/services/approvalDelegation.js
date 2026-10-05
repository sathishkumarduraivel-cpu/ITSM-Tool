// Approval delegation: cover for an approver who is away, and the answer to
// the question the decide endpoint never used to ask -- may THIS person
// decide THIS approval?
//
// Those two things belong together. A delegate is only meaningful if there is
// a rule about who may decide; without one, delegation is decoration, because
// everybody could already decide everything.
import { db, uid } from '../db.js';

export class DelegationError extends Error {
  constructor(message, status = 400, field_errors = null) {
    super(message);
    this.status = status;
    if (field_errors) this.field_errors = field_errors;
  }
}

const today = () => new Date().toISOString().slice(0, 10);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function activeMember(workspaceId, userId) {
  return db.prepare(
    `SELECT u.id, u.name, u.email, wm.role
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND wm.user_id = ? AND wm.active = 1`
  ).get(workspaceId, userId);
}

// A delegation is in force when it has not been revoked and the date falls
// inside its window. Both ends are inclusive, and an open end means it runs
// until revoked -- compared as plain YYYY-MM-DD strings, which sort
// correctly and sidestep the timezone question entirely for a date-only
// window.
const IN_FORCE = `
  revoked_at IS NULL
  AND (starts_at IS NULL OR starts_at <= :on)
  AND (ends_at IS NULL OR ends_at >= :on)
`;

/**
 * The people whose approvals this user may currently act on.
 *
 * One hop only, by design -- see the table comment in db.js.
 */
export function delegatorsFor(workspaceId, userId, onDate = today()) {
  if (!userId) return [];
  return db.prepare(
    `SELECT d.id, d.from_user_id, u.name AS from_name, u.email AS from_email, d.starts_at, d.ends_at, d.reason
     FROM approval_delegations d
     JOIN users u ON u.id = d.from_user_id
     WHERE d.workspace_id = ? AND d.to_user_id = ? AND ${IN_FORCE.replace(/:on/g, '?')}
     ORDER BY u.name`
  ).all(workspaceId, userId, onDate, onDate);
}

/** The people this user has handed their approvals to. */
export function delegatesOf(workspaceId, userId, onDate = today()) {
  if (!userId) return [];
  return db.prepare(
    `SELECT d.id, d.to_user_id, u.name AS to_name, u.email AS to_email, d.starts_at, d.ends_at, d.reason
     FROM approval_delegations d
     JOIN users u ON u.id = d.to_user_id
     WHERE d.workspace_id = ? AND d.from_user_id = ? AND ${IN_FORCE.replace(/:on/g, '?')}
     ORDER BY u.name`
  ).all(workspaceId, userId, onDate, onDate);
}

export function listDelegations(workspaceId, { fromUserId = null, toUserId = null, includeExpired = false } = {}) {
  const where = ['d.workspace_id = ?'];
  const params = [workspaceId];
  if (fromUserId) { where.push('d.from_user_id = ?'); params.push(fromUserId); }
  if (toUserId) { where.push('d.to_user_id = ?'); params.push(toUserId); }
  if (!includeExpired) {
    where.push('d.revoked_at IS NULL');
    where.push('(d.ends_at IS NULL OR d.ends_at >= ?)');
    params.push(today());
  }
  const rows = db.prepare(
    `SELECT d.*, f.name AS from_name, f.email AS from_email, t.name AS to_name, t.email AS to_email,
            c.name AS created_by_name
     FROM approval_delegations d
     JOIN users f ON f.id = d.from_user_id
     JOIN users t ON t.id = d.to_user_id
     LEFT JOIN users c ON c.id = d.created_by
     WHERE ${where.join(' AND ')}
     ORDER BY d.created_at DESC`
  ).all(...params);
  const on = today();
  return rows.map((r) => ({
    ...r,
    in_force: !r.revoked_at
      && (!r.starts_at || r.starts_at <= on)
      && (!r.ends_at || r.ends_at >= on),
  }));
}

/**
 * Hand an approver's decisions to somebody else.
 *
 * You may delegate your own; an admin may arrange cover for anyone, because
 * the person who needed cover is usually the one who is already away.
 */
export function createDelegation(workspaceId, actor, body = {}) {
  const fromUserId = body.from_user_id || actor.id;
  const isAdmin = actor.role === 'admin';
  if (fromUserId !== actor.id && !isAdmin) {
    throw new DelegationError('Only an admin can delegate somebody else’s approvals.', 403);
  }

  const from = activeMember(workspaceId, fromUserId);
  if (!from) throw new DelegationError('That person is not in this workspace', 400, [{ field: 'from_user_id', message: 'Not a member' }]);

  const to = activeMember(workspaceId, body.to_user_id);
  if (!to) throw new DelegationError('Choose who should cover the approvals', 400, [{ field: 'to_user_id', message: 'Not a member of this workspace' }]);

  if (to.id === from.id) {
    throw new DelegationError('Somebody cannot cover their own approvals', 400, [{ field: 'to_user_id', message: 'Pick a different person' }]);
  }
  // A requester has no approval queue of their own, but they can legitimately
  // be named as an approver on a catalog stage, so they are allowed here.
  // What is refused is the inactive member -- cover that can never be acted on.

  const starts = body.starts_at || null;
  const ends = body.ends_at || null;
  for (const [field, value] of [['starts_at', starts], ['ends_at', ends]]) {
    if (value && !DATE_ONLY.test(value)) {
      throw new DelegationError('Dates must be written as YYYY-MM-DD', 400, [{ field, message: 'Use YYYY-MM-DD' }]);
    }
  }
  if (starts && ends && ends < starts) {
    throw new DelegationError('The end date cannot be before the start date', 400, [{ field: 'ends_at', message: 'Must not be before the start' }]);
  }
  // A window that has already closed would be recorded as cover and never
  // apply to anything, which reads as working.
  if (ends && ends < today()) {
    throw new DelegationError('That window has already passed', 400, [{ field: 'ends_at', message: 'Pick a date from today onwards' }]);
  }

  // Two overlapping delegations between the same pair say nothing new and
  // make revoking ambiguous -- you revoke one and the cover is still on.
  const clash = db.prepare(
    `SELECT id, starts_at, ends_at FROM approval_delegations
     WHERE workspace_id = ? AND from_user_id = ? AND to_user_id = ? AND revoked_at IS NULL
       AND (ends_at IS NULL OR ends_at >= ?)
       AND (? IS NULL OR starts_at IS NULL OR starts_at <= ?)`
  ).get(workspaceId, from.id, to.id, starts || today(), ends, ends);
  if (clash) {
    throw new DelegationError(
      `${to.name} already covers ${from.name}’s approvals over that period. Revoke that one first.`,
      409,
    );
  }

  const id = uid('apd');
  db.prepare(
    `INSERT INTO approval_delegations (id, workspace_id, from_user_id, to_user_id, starts_at, ends_at, reason, created_by)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, workspaceId, from.id, to.id, starts, ends, body.reason || null, actor.id);

  return listDelegations(workspaceId, { includeExpired: true }).find((d) => d.id === id);
}

export function revokeDelegation(workspaceId, actor, id) {
  const row = db.prepare('SELECT * FROM approval_delegations WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new DelegationError('That delegation no longer exists', 404);
  if (row.revoked_at) throw new DelegationError('That delegation has already been revoked', 409);
  // The approver whose decisions these are, the person covering them, and an
  // admin can all end it. The delegate is included on purpose: being handed
  // somebody else's authority is not something you should be unable to decline.
  const mayRevoke = actor.role === 'admin' || actor.id === row.from_user_id || actor.id === row.to_user_id;
  if (!mayRevoke) throw new DelegationError('That is not yours to revoke', 403);

  db.prepare("UPDATE approval_delegations SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ?").run(actor.id, id);
  return listDelegations(workspaceId, { includeExpired: true }).find((d) => d.id === id);
}

/**
 * May this person decide this approval, and if so, on whose behalf?
 *
 * Returns { allowed, on_behalf_of, reason }. `on_behalf_of` is the approver
 * being covered when the caller is acting as a delegate, and null when they
 * are deciding in their own right.
 */
export function canDecideApproval(workspaceId, approval, user, ticket = null) {
  if (approval.status && approval.status !== 'pending') {
    return { allowed: false, status: 409, reason: `This was already ${approval.status}.` };
  }

  // Nobody approves their own request, including an admin. An approval you
  // can grant yourself is not a control, it is a formality -- and the whole
  // reason delegation exists is so that being unable to decide your own
  // request has an answer other than deciding it anyway.
  const subject = ticket && (ticket.requester_id === user.id || ticket.requested_for_id === user.id);
  if (subject) {
    return {
      allowed: false,
      status: 403,
      reason: 'You cannot approve a request that is yours. Ask another approver, or have this approval delegated.',
    };
  }

  // The person actually named on the row.
  if (approval.approver_id && approval.approver_id === user.id) {
    return { allowed: true, on_behalf_of: null };
  }

  // Covering for the person named on the row.
  if (approval.approver_id) {
    const covering = delegatorsFor(workspaceId, user.id).find((d) => d.from_user_id === approval.approver_id);
    if (covering) return { allowed: true, on_behalf_of: approval.approver_id };
  }

  // A role-based approval with nobody named: anybody holding that role can
  // take it, which is what "Anyone with a role" means. An admin counts for
  // an agent-role approval too, since admin is the wider role.
  if (!approval.approver_id && approval.approver_role) {
    if (user.role === approval.approver_role) return { allowed: true, on_behalf_of: null };
    if (user.role === 'admin') return { allowed: true, on_behalf_of: null };
  }

  // An admin can always unblock a stuck approval -- but as themselves, on the
  // record, not silently as the named approver.
  if (user.role === 'admin') return { allowed: true, on_behalf_of: null };

  return {
    allowed: false,
    status: 403,
    reason: 'This approval is not yours to decide.',
  };
}

/**
 * The approvals this user can act on: their own, plus everything delegated
 * to them. Returned as the SQL fragment the list endpoint needs, so the
 * queue and the decide check cannot drift apart.
 */
export function visibleApprovalClause(workspaceId, user) {
  const delegators = delegatorsFor(workspaceId, user.id).map((d) => d.from_user_id);
  const ids = [user.id, ...delegators];
  const placeholders = ids.map(() => '?').join(',');
  return {
    sql: `(a.approver_id IN (${placeholders}) OR (a.approver_id IS NULL AND a.approver_role = ?))`,
    params: [...ids, user.role],
    delegators,
  };
}
