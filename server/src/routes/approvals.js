import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { notifyUser } from '../services/notifications.js';

const router = Router();

// Approvals visible to me: explicitly assigned to me, or assigned to my role with no specific approver yet.
router.get('/', requireAuth, (req, res) => {
  const { status = 'pending', ticket_id } = req.query;
  let sql = `
    SELECT a.*, t.number, t.title, t.type, t.requester_id, u.name as requester_name
    FROM approvals a
    JOIN tickets t ON t.id = a.ticket_id
    LEFT JOIN users u ON u.id = t.requester_id
    WHERE 1=1
  `;
  const params = [];
  if (status) { sql += ' AND a.status = ?'; params.push(status); }
  if (ticket_id) { sql += ' AND a.ticket_id = ?'; params.push(ticket_id); }
  if (req.user.role !== 'admin') {
    sql += ' AND (a.approver_id = ? OR a.approver_role = ?)';
    params.push(req.user.id, req.user.role);
  }
  sql += ' ORDER BY a.created_at DESC';
  res.json({ approvals: db.prepare(sql).all(...params) });
});

router.post('/:id/decide', requireAuth, (req, res) => {
  const approval = db.prepare('SELECT * FROM approvals WHERE id = ?').get(req.params.id);
  if (!approval) return res.status(404).json({ error: 'Not found' });
  const { status, comments = '' } = req.body;
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });

  db.prepare("UPDATE approvals SET status = ?, comments = ?, decided_at = datetime('now') WHERE id = ?").run(status, comments, req.params.id);

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(approval.ticket_id);
  if (ticket) {
    const remainingPending = db.prepare("SELECT COUNT(*) c FROM approvals WHERE ticket_id = ? AND status = 'pending'").get(ticket.id).c;

    if (status === 'rejected') {
      const isChange = ticket.type === 'change';
      db.prepare(
        `UPDATE tickets SET status = ?, ${isChange ? 'cab_status' : 'status'} = ?, updated_at = datetime('now') WHERE id = ?`
      ).run('closed', 'rejected', ticket.id);
      db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), ticket.id, 'approval_rejected', comments || 'Rejected');
      notifyUser(ticket.requester_id, 'Request rejected', `${ticket.number} — ${ticket.title} was rejected. ${comments || ''}`, `/tickets/${ticket.id}`);
    } else if (remainingPending === 0) {
      if (ticket.type === 'change') {
        db.prepare("UPDATE tickets SET cab_status = 'approved', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
      } else {
        db.prepare("UPDATE tickets SET status = 'open', updated_at = datetime('now') WHERE id = ?").run(ticket.id);
      }
      db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), ticket.id, 'approved', 'All approvals granted');
      notifyUser(ticket.requester_id, 'Request approved', `${ticket.number} — ${ticket.title} was approved.`, `/tickets/${ticket.id}`);
    }
  }

  res.json({ ok: true });
});

export default router;
