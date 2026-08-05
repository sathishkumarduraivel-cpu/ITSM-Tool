import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id);
  const unread = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND read = 0").get(req.user.id).c;
  res.json({ notifications: rows, unread });
});

router.post('/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

router.post('/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ---- Notification templates (admin) ----
router.get('/templates', requireAuth, (req, res) => {
  res.json({ templates: db.prepare('SELECT * FROM notification_templates ORDER BY event').all() });
});

router.post('/templates', requireAuth, requireRole('admin'), (req, res) => {
  const { event, channel = 'in_app', subject, body, enabled = true } = req.body;
  if (!event || !body) return res.status(400).json({ error: 'event and body required' });
  const id = uid('tpl');
  db.prepare('INSERT INTO notification_templates (id, event, channel, subject, body, enabled) VALUES (?,?,?,?,?,?)').run(
    id, event, channel, subject || '', body, enabled ? 1 : 0
  );
  res.status(201).json({ id });
});

router.patch('/templates/:id', requireAuth, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM notification_templates WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['event', 'channel', 'subject', 'body', 'enabled'];
  const fields = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : req.body[key]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE notification_templates SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/templates/:id', requireAuth, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM notification_templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
