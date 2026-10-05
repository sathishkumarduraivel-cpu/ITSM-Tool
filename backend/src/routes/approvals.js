import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import { notifyUser, renderTemplate } from '../services/notifications.js';
import { resolveTicketAfterApprovalChange } from '../services/approvalEngine.js';
import { sendTemplatedEmail } from '../services/emailService.js';
import {
  DelegationError, canDecideApproval, visibleApprovalClause, delegatorsFor, delegatesOf,
  listDelegations, createDelegation, revokeDelegation,
} from '../services/approvalDelegation.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

// Approvals visible to me: explicitly assigned to me, or assigned to my role with no specific approver yet.
router.get('/', (req, res) => {
  const { status = 'pending', ticket_id, type, requester_id } = req.query;
  let sql = `
    SELECT a.*, t.number, t.title, t.type, t.requester_id, u.name as requester_name
    FROM approvals a
    JOIN tickets t ON t.id = a.ticket_id
    LEFT JOIN users u ON u.id = t.requester_id
    WHERE t.workspace_id = ?
  `;
  const params = [req.workspaceId];
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  if (ticket_id) { sql += ' AND a.ticket_id = ?'; params.push(ticket_id); }
  if (type) { sql += ' AND t.type = ?'; params.push(type); }
  if (requester_id) { sql += ' AND t.requester_id = ?'; params.push(requester_id); }
  // An admin sees everything; everybody else sees their own plus anything
  // delegated to them while that cover is in force.
  let delegators = [];
  if (req.user.role !== 'admin') {
    const clause = visibleApprovalClause(req.workspaceId, req.user);
    sql += ` AND ${clause.sql}`;
    params.push(...clause.params);
    delegators = clause.delegators;
  } else {
    delegators = delegatorsFor(req.workspaceId, req.user.id).map((d) => d.from_user_id);
  }
  sql += ' ORDER BY a.created_at DESC';
  const rows = db.prepare(sql).all(...params);
  // Marked rather than silently mixed in: deciding something because you are
  // covering for somebody is a different act from deciding your own, and the
  // queue should say which is which before you click.
  const covered = new Set(delegators);
  res.json({
    approvals: rows.map((r) => ({
      ...r,
      via_delegation: !!(r.approver_id && r.approver_id !== req.user.id && covered.has(r.approver_id)),
    })),
    acting_for: delegatorsFor(req.workspaceId, req.user.id),
  });
});

// ---- delegation -----------------------------------------------------------

// Everything I need to reason about cover: what I have handed out, what has
// been handed to me, and (for an admin) every arrangement in the workspace.
router.get('/delegations', (req, res) => {
  const scope = req.query.scope === 'all' && req.user.role === 'admin' ? 'all' : 'mine';
  res.json({
    scope,
    mine: listDelegations(req.workspaceId, { fromUserId: req.user.id, includeExpired: req.query.include_expired === '1' }),
    to_me: listDelegations(req.workspaceId, { toUserId: req.user.id, includeExpired: req.query.include_expired === '1' }),
    all: scope === 'all' ? listDelegations(req.workspaceId, { includeExpired: req.query.include_expired === '1' }) : undefined,
    acting_for: delegatorsFor(req.workspaceId, req.user.id),
    delegated_to: delegatesOf(req.workspaceId, req.user.id),
  });
});

router.post('/delegations', (req, res) => {
  try {
    const row = createDelegation(req.workspaceId, req.user, req.body || {});
    logAudit(req, {
      action: 'approval_delegation.created', entityType: 'approval_delegation', entityId: row.id,
      entityLabel: `${row.from_name} → ${row.to_name}`,
      details: `Approvals covered by ${row.to_name}${row.starts_at ? ` from ${row.starts_at}` : ''}${row.ends_at ? ` until ${row.ends_at}` : ' until revoked'}`,
    });
    res.status(201).json({ delegation: row });
  } catch (e) {
    if (e instanceof DelegationError) return res.status(e.status).json({ error: e.message, field_errors: e.field_errors });
    throw e;
  }
});

router.delete('/delegations/:id', (req, res) => {
  try {
    const row = revokeDelegation(req.workspaceId, req.user, req.params.id);
    logAudit(req, {
      action: 'approval_delegation.revoked', entityType: 'approval_delegation', entityId: row.id,
      entityLabel: `${row.from_name} → ${row.to_name}`, details: 'Cover ended',
    });
    res.json({ delegation: row });
  } catch (e) {
    if (e instanceof DelegationError) return res.status(e.status).json({ error: e.message, field_errors: e.field_errors });
    throw e;
  }
});

router.post('/:id/decide', (req, res) => {
  const approval = db.prepare(
    `SELECT a.* FROM approvals a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ? AND t.workspace_id = ?`
  ).get(req.params.id, req.workspaceId);
  if (!approval) return res.status(404).json({ error: 'Not found' });
  const { status, comments = '' } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ?').get(approval.ticket_id, req.workspaceId);

  // Who may decide this, and are they doing it in their own right or as
  // somebody's cover?
  //
  // This endpoint previously checked only that the approval existed in the
  // workspace. Any member could therefore decide any approval -- including
  // approving their own request, since a ticket hands its own approval rows
  // (and so their ids) to the person who raised it.
  const verdict = canDecideApproval(req.workspaceId, approval, req.user, ticket);
  if (!verdict.allowed) return res.status(verdict.status || 403).json({ error: verdict.reason });

  const onBehalfOf = verdict.on_behalf_of
    ? db.prepare('SELECT id, name FROM users WHERE id = ?').get(verdict.on_behalf_of)
    : null;

  db.prepare(
    "UPDATE approvals SET status = ?, comments = ?, decided_at = datetime('now'), decided_by = ?, decided_for = ? WHERE id = ?"
  ).run(status, comments, req.user.id, onBehalfOf?.id || null, req.params.id);

  logAudit(req, {
    action: `approval.${status}`, entityType: 'approval', entityId: approval.id,
    entityLabel: ticket ? `${ticket.number} — ${ticket.title}` : approval.id,
    details: onBehalfOf
      ? `${status} by ${req.user.name} covering for ${onBehalfOf.name}${comments ? `: ${comments}` : ''}`
      : `${status} by ${req.user.name}${comments ? `: ${comments}` : ''}`,
  });

  if (ticket) {
    // The decision is on the ticket's own history too, naming the delegate
    // AND the approver they stood in for -- "approved by Priya" is a
    // different fact from "approved by Priya, covering for Dev".
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
      uid('h'), ticket.id, `approval_${status}`,
      onBehalfOf
        ? `${status === 'approved' ? 'Approved' : 'Rejected'} by ${req.user.name}, covering for ${onBehalfOf.name}`
        : `${status === 'approved' ? 'Approved' : 'Rejected'} by ${req.user.name}`,
    );
    if (status === 'rejected') {
      // A change tracks rejection on its own cab_status column (status
      // itself just becomes 'closed'); anything else has no such column, so
      // status is the only thing that changes. The previous version built
      // this as one dynamic SET clause that, for the non-change branch,
      // assigned `status` twice in the same statement ("SET status = ?,
      // status = ?") -- SQLite keeps only the last assignment, so a
      // rejected request/incident/problem silently ended up with the
      // invalid status value 'rejected' (not one of this app's real
      // statuses) instead of 'closed'.
      const isChange = ticket.type === 'change';
      if (isChange) {
        db.prepare("UPDATE tickets SET status = 'closed', cab_status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
      } else {
        db.prepare("UPDATE tickets SET status = 'closed', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
      }
      db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), ticket.id, 'approval_rejected', comments || 'Rejected');
      const tpl = renderTemplate('change_rejected', { number: ticket.number, title: ticket.title }, req.workspaceId);
      notifyUser(ticket.requester_id, tpl?.subject || 'Request rejected', tpl?.body || `${ticket.number} — ${ticket.title} was rejected. ${comments || ''}`, `/tickets/${ticket.id}`, req.workspaceId);
      const rejectedRequester = db.prepare('SELECT name, email FROM users WHERE id = ?').get(ticket.requester_id);
      if (rejectedRequester?.email) {
        sendTemplatedEmail(req.workspaceId, 'approval_rejected', rejectedRequester.email, {
          'requester.name': rejectedRequester.name, 'ticket.number': ticket.number, 'ticket.title': ticket.title,
          'comment.body': comments || 'No reason was provided.', 'ticket.link': `${req.protocol}://${req.get('host')}/tickets/${ticket.id}`,
        }).catch((e) => console.error('approval rejected email error', e));
      }
    } else {
      resolveTicketAfterApprovalChange(ticket.id, req.workspaceId);
    }
  }

  res.json({ ok: true });
});

export default router;
