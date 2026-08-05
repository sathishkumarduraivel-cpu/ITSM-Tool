import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, attachWorkspace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

router.get('/tickets-summary', (req, res) => {
  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as month, COUNT(*) c,
      SUM(CASE WHEN status IN ('resolved','closed') THEN 1 ELSE 0 END) resolved
    FROM tickets GROUP BY month ORDER BY month
  `).all();
  const byAgent = db.prepare(`
    SELECT u.name, COUNT(*) total,
      SUM(CASE WHEN t.status IN ('resolved','closed') THEN 1 ELSE 0 END) resolved,
      SUM(CASE WHEN t.sla_due_at < datetime('now') AND t.status NOT IN ('resolved','closed') THEN 1 ELSE 0 END) breached
    FROM tickets t JOIN users u ON u.id = t.assignee_id GROUP BY t.assignee_id ORDER BY total DESC
  `).all();
  const avgResolutionHours = db.prepare(`
    SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24) avg_hours
    FROM tickets WHERE resolved_at IS NOT NULL
  `).get();
  const csat = db.prepare('SELECT AVG(rating) avg_rating, COUNT(*) responses FROM csat_surveys').get();
  res.json({ byMonth, byAgent, avgResolutionHours: avgResolutionHours.avg_hours, csat });
});

router.get('/csat', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, t.number, t.title FROM csat_surveys c JOIN tickets t ON t.id = c.ticket_id ORDER BY c.created_at DESC
  `).all();
  res.json({ surveys: rows });
});

router.get('/export/tickets.csv', (req, res) => {
  const rows = db.prepare('SELECT number, type, title, status, priority, category, team, created_at, resolved_at FROM tickets ORDER BY created_at DESC').all();
  const header = 'Number,Type,Title,Status,Priority,Category,Team,Created,Resolved';
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [r.number, r.type, r.title, r.status, r.priority, r.category, r.team, r.created_at, r.resolved_at].map(esc).join(','));
  const csv = [header, ...lines].join('\n');
  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', 'attachment; filename="tickets.csv"');
  res.send(csv);
});

export default router;
