import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { sendIntegrationMessage } from '../services/notify.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM integrations ORDER BY created_at DESC').all();
  res.json({
    integrations: rows.map((r) => {
      const config = JSON.parse(r.config || '{}');
      // redact secrets in list view
      const redacted = { ...config };
      if (redacted.webhook_url) redacted.webhook_url = redacted.webhook_url.slice(0, 24) + '••••';
      if (redacted.api_key) redacted.api_key = '••••';
      return { ...r, config: redacted };
    }),
  });
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const { type, name, config = {}, enabled = true } = req.body;
  if (!type || !name) return res.status(400).json({ error: 'type and name required' });
  const id = uid('int');
  db.prepare('INSERT INTO integrations (id, type, name, config, enabled) VALUES (?,?,?,?,?)').run(
    id, type, name, JSON.stringify(config), enabled ? 1 : 0
  );
  res.status(201).json({ id });
});

router.patch('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, config, enabled } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (config !== undefined) { fields.push('config = ?'); params.push(JSON.stringify(config)); }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  params.push(req.params.id);
  db.prepare(`UPDATE integrations SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM integrations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/test', requireAuth, requireRole('admin'), async (req, res) => {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const result = await sendIntegrationMessage(row, { text: `Test message from ITSM AI — integration "${row.name}" is wired up correctly.` });
  res.json(result);
});

export default router;
