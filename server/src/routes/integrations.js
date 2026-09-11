import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { sendIntegrationMessage } from '../services/notify.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

function redactConfig(configJson) {
  const config = JSON.parse(decrypt(configJson) || '{}');
  const redacted = { ...config };
  if (redacted.webhook_url) redacted.webhook_url = redacted.webhook_url.slice(0, 24) + '••••';
  if (redacted.api_key) redacted.api_key = '••••';
  if (redacted.pass) redacted.pass = '••••';
  if (redacted.token) redacted.token = '••••';
  if (redacted.password) redacted.password = '••••';
  return redacted;
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM integrations WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({
    integrations: rows.map((r) => ({ ...r, config: redactConfig(r.config) })),
  });
});

router.post('/', requirePermission('integrations.manage'), (req, res) => {
  const { type, name, config = {}, enabled = true } = req.body;
  if (!type || !name) return res.status(400).json({ error: 'type and name required' });
  const id = uid('int');
  db.prepare('INSERT INTO integrations (id, workspace_id, type, name, config, enabled) VALUES (?,?,?,?,?,?)').run(
    id, req.workspaceId, type, name, encrypt(JSON.stringify(config)), enabled ? 1 : 0
  );
  logAudit(req, { action: 'integration.created', entityType: 'integration', entityId: id, entityLabel: name, details: { type } });
  res.status(201).json({ id });
});

router.patch('/:id', requirePermission('integrations.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
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
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE integrations SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'integration.updated', entityType: 'integration', entityId: req.params.id, entityLabel: name || row.name, details: { name, enabled } });
  res.json({ ok: true });
});

router.delete('/:id', requirePermission('integrations.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM integrations WHERE id = ?').run(req.params.id);
  logAudit(req, { action: 'integration.deleted', entityType: 'integration', entityId: req.params.id, entityLabel: row.name });
  res.json({ ok: true });
});

router.post('/:id/test', requirePermission('integrations.manage'), async (req, res) => {
  const row = db.prepare('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const result = await sendIntegrationMessage(row, { text: `Test message from ITSM AI — integration "${row.name}" is wired up correctly.` });
  logAudit(req, { action: 'integration.tested', entityType: 'integration', entityId: req.params.id, entityLabel: row.name, details: { ok: result?.ok } });
  res.json(result);
});

export default router;
