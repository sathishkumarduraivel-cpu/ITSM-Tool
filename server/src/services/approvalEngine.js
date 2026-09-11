// Shared "what happens when a ticket's approval queue clears" logic, used by
// both the manual decide endpoint (routes/approvals.js) and the auto_approve
// automation action (services/automationEngine.js) so they can't drift apart.
import { db, uid } from '../db.js';
import { notifyUser, renderTemplate } from './notifications.js';
import { stageForBucket } from './lifecycleEngine.js';
import { sendTemplatedEmail, absoluteUrl } from './emailService.js';

export function resolveTicketAfterApprovalChange(ticketId, workspaceId) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ?').get(ticketId, workspaceId);
  if (!ticket) return;
  const remainingPending = db.prepare("SELECT COUNT(*) c FROM approvals WHERE ticket_id = ? AND status = 'pending'").get(ticketId).c;
  if (remainingPending > 0) return;
  const anyRejected = db.prepare("SELECT COUNT(*) c FROM approvals WHERE ticket_id = ? AND status = 'rejected'").get(ticketId).c;
  if (anyRejected > 0) return; // the rejection path already updated ticket state at decide-time

  if (ticket.type === 'change') {
    db.prepare("UPDATE tickets SET cab_status = 'approved', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
  } else {
    // If this type has an active lifecycle and the ticket is sitting in a
    // stage keyed to it (e.g. a catalog request's 'Pending Approval' stage —
    // see LIFECYCLE_TEMPLATES.request in lifecycleEngine.js), move the
    // stage forward in lockstep with status so effectiveStage() doesn't keep
    // resolving the now-stale "Pending Approval" stage after this clears.
    // Falls back to leaving lifecycle_stage untouched (today's behavior) for
    // every workspace/type without one configured.
    const nextStage = stageForBucket(workspaceId, ticket.type, 'open');
    if (nextStage) {
      db.prepare("UPDATE tickets SET status = 'open', lifecycle_stage = ?, updated_at = datetime('now') WHERE id = ?").run(nextStage.key, ticket.id);
    } else {
      db.prepare("UPDATE tickets SET status = 'open', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
    }
  }
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), ticket.id, 'approved', 'All approvals granted');
  const tpl = renderTemplate('change_approved', { number: ticket.number, title: ticket.title }, workspaceId);
  notifyUser(ticket.requester_id, tpl?.subject || 'Request approved', tpl?.body || `${ticket.number} — ${ticket.title} was approved.`, `/tickets/${ticket.id}`, workspaceId);
  const approvedRequester = db.prepare('SELECT name, email FROM users WHERE id = ?').get(ticket.requester_id);
  if (approvedRequester?.email) {
    sendTemplatedEmail(workspaceId, 'approval_approved', approvedRequester.email, {
      'requester.name': approvedRequester.name, 'ticket.number': ticket.number, 'ticket.title': ticket.title, 'ticket.link': absoluteUrl(`/tickets/${ticket.id}`),
    }).catch((e) => console.error('approval approved email error', e));
  }
}

// Auto-approves every pending approval on a ticket, then resolves the ticket
// if that clears the queue. Returns the number of approvals it cleared.
export function autoApprovePending(ticketId, workspaceId) {
  const pending = db.prepare("SELECT id FROM approvals WHERE ticket_id = ? AND status = 'pending'").all(ticketId);
  for (const a of pending) {
    db.prepare("UPDATE approvals SET status = 'approved', comments = ?, decided_at = datetime('now') WHERE id = ?").run('Auto-approved by automation', a.id);
  }
  if (pending.length) resolveTicketAfterApprovalChange(ticketId, workspaceId);
  return pending.length;
}
