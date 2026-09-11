import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 50').all(req.user.id, req.workspaceId);
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND workspace_id = ? AND read = 0').get(req.user.id, req.workspaceId).c;
  res.json({ notifications: rows, unread });
});

router.post('/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ? AND workspace_id = ?').run(req.params.id, req.user.id, req.workspaceId);
  res.json({ ok: true });
});

router.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND workspace_id = ?').run(req.user.id, req.workspaceId);
  res.json({ ok: true });
});

// ---- Notification templates (admin) ----
router.get('/templates', (req, res) => {
  res.json({ templates: db.prepare('SELECT * FROM notification_templates WHERE workspace_id = ? ORDER BY event').all(req.workspaceId) });
});

router.post('/templates', requirePermission('notifications.manage'), (req, res) => {
  const { event, channel = 'in_app', subject, body, enabled = true } = req.body;
  if (!event || !body) return res.status(400).json({ error: 'event and body required' });
  const id = uid('tpl');
  db.prepare('INSERT INTO notification_templates (id, workspace_id, event, channel, subject, body, enabled) VALUES (?,?,?,?,?,?,?)').run(
    id, req.workspaceId, event, channel, subject || '', body, enabled ? 1 : 0
  );
  logAudit(req, { action: 'notification_template.created', entityType: 'notification_template', entityId: id, entityLabel: `${event} (${channel})` });
  res.status(201).json({ id });
});

router.patch('/templates/:id', requirePermission('notifications.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM notification_templates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
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
  logAudit(req, { action: 'notification_template.updated', entityType: 'notification_template', entityId: req.params.id, entityLabel: `${row.event} (${row.channel})`, details: req.body });
  res.json({ ok: true });
});

router.delete('/templates/:id', requirePermission('notifications.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM notification_templates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM notification_templates WHERE id = ?').run(req.params.id);
  logAudit(req, { action: 'notification_template.deleted', entityType: 'notification_template', entityId: req.params.id, entityLabel: `${row.event} (${row.channel})` });
  res.json({ ok: true });
});

export default router;
