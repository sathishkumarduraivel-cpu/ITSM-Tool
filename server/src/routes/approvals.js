import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import { notifyUser, renderTemplate } from '../services/notifications.js';
import { resolveTicketAfterApprovalChange } from '../services/approvalEngine.js';
import { sendTemplatedEmail } from '../services/emailService.js';

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
  if (req.user.role !== 'admin') {
    sql += ' AND (a.approver_id = ? OR a.approver_role = ?)';
    params.push(req.user.id, req.user.role);
  }
  sql += ' ORDER BY a.created_at DESC';
  res.json({ approvals: db.prepare(sql).all(...params) });
});

router.post('/:id/decide', (req, res) => {
  const approval = db.prepare(
    `SELECT a.* FROM approvals a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ? AND t.workspace_id = ?`
  ).get(req.params.id, req.workspaceId);
  if (!approval) return res.status(404).json({ error: 'Not found' });
  const { status, comments = '' } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });

  db.prepare("UPDATE approvals SET status = ?, comments = ?, decided_at = datetime('now') WHERE id = ?").run(status, comments, req.params.id);

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ?').get(approval.ticket_id, req.workspaceId);
  if (ticket) {
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
