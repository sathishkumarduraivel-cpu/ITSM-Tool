import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, attachWorkspace, requireRole } from '../middleware/auth.js';
import { sendIntegrationMessage } from '../services/notify.js';
import { encrypt, decrypt } from '../services/crypto.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

function redactConfig(configJson) {
  const config = JSON.parse(decrypt(configJson) || '{}');
  const redacted = { ...config };
  if (redacted.webhook_url) redacted.webhook_url = redacted.webhook_url.slice(0, 24) + '••••';
  if (redacted.api_key) redacted.api_key = '••••';
  if (redacted.pass) redacted.pass = '••••';
  return redacted;
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM integrations ORDER BY created_at DESC').all();
  res.json({
    integrations: rows.map((r) => ({ ...r, config: redactConfig(r.config) })),
  });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { type, name, config = {}, enabled = true } = req.body;
  if (!type || !name) return res.status(400).json({ error: 'type and name required' });
  const id = uid('int');
  db.prepare('INSERT INTO integrations (id, workspace_id, type, name, config, enabled) VALUES (?,?,?,?,?,?)').run(
    id, req.workspaceId, type, name, encrypt(JSON.stringify(config)), enabled ? 1 : 0
  );
  res.status(201).json({ id });
});

router.patch('/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, config, enabled } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (config !== undefined) {
    // Merge onto the existing decrypted config rather than replacing it wholesale,
    // so omitting a secret field (e.g. leaving SMTP password blank when editing)
    // preserves the previously saved value instead of wiping it.
    const existing = JSON.parse(decrypt(row.config) || '{}');
    const merged = { ...existing, ...config };
    fields.push('config = ?'); params.push(encrypt(JSON.stringify(merged)));
  }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  params.push(req.params.id);
  db.prepare(`UPDATE integrations SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM integrations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM integrations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/test', requireRole('admin'), async (req, res) => {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const result = await sendIntegrationMessage(row, { text: `Test message from ITSM AI — integration "${row.name}" is wired up correctly.` });
  res.json(result);
});

export default router;
