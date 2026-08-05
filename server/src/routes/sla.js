import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, attachWorkspace, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

router.get('/policies', (req, res) => {
  res.json({ policies: db.prepare('SELECT * FROM sla_policies ORDER BY created_at DESC').all() });
});

router.post('/policies', requireRole('admin'), (req, res) => {
  const { name, priority, category, team, response_minutes = 60, resolution_minutes = 1440, business_hours_only = false, enabled = true } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid('sla');
  db.prepare(
    `INSERT INTO sla_policies (id, workspace_id, name, priority, category, team, response_minutes, resolution_minutes, business_hours_only, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, name, priority || null, category || null, team || null, response_minutes, resolution_minutes, business_hours_only ? 1 : 0, enabled ? 1 : 0);
  res.status(201).json({ id });
});

router.patch('/policies/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM sla_policies WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['name', 'priority', 'category', 'team', 'response_minutes', 'resolution_minutes', 'business_hours_only', 'enabled'];
  const fields = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : req.body[key]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE sla_policies SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/policies/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM sla_policies WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM sla_policies WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/business-hours', (req, res) => {
  res.json({ businessHours: db.prepare('SELECT * FROM business_hours ORDER BY day_of_week').all() });
});

router.put('/business-hours', requireRole('admin'), (req, res) => {
  const { hours = [] } = req.body; // [{day_of_week, start_time, end_time}]
  db.prepare('DELETE FROM business_hours').run();
  for (const h of hours) {
    db.prepare('INSERT INTO business_hours (id, workspace_id, day_of_week, start_time, end_time) VALUES (?,?,?,?,?)').run(
      uid('bh'), req.workspaceId, h.day_of_week, h.start_time, h.end_time
    );
  }
  res.json({ ok: true });
});

// Tickets currently at risk of breaching (due within 2 hours) or already breached.
router.get('/at-risk', (req, res) => {
  const rows = db.prepare(`
    SELECT id, number, title, priority, status, sla_due_at, response_due_at, responded_at
    FROM tickets
    WHERE status NOT IN ('resolved', 'closed')
      AND (
        sla_due_at < datetime('now', '+2 hours')
        OR (response_due_at < datetime('now') AND responded_at IS NULL)
      )
    ORDER BY sla_due_at ASC
  `).all();
  res.json({ tickets: rows });
});

export default router;
