import { Router } from 'express';
import crypto from 'node:crypto';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { ADAPTERS, testConnection } from '../services/externalSync.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace, requirePermission('integrations.manage'));

function redactAuth(row) {
  const auth = JSON.parse(decrypt(row.auth_config) || '{}');
  const redacted = {};
  for (const key of Object.keys(auth)) redacted[key] = '••••';
  return { ...row, auth_config: redacted, field_mapping: JSON.parse(row.field_mapping || '{}') };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM external_connections WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({ connections: rows.map(redactAuth) });
});

router.post('/', (req, res) => {
  const { platform, name, base_url, auth_config = {}, field_mapping = {}, enabled = true } = req.body;
  if (!platform || !ADAPTERS[platform]) return res.status(400).json({ error: `platform must be one of: ${Object.keys(ADAPTERS).join(', ')}` });
  if (!name || !base_url) return res.status(400).json({ error: 'name and base_url required' });
  const id = uid('xconn');
  const webhookSecret = crypto.randomBytes(24).toString('hex');
  db.prepare(
    'INSERT INTO external_connections (id, workspace_id, platform, name, base_url, auth_config, field_mapping, webhook_secret, enabled) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, req.workspaceId, platform, name, base_url.replace(/\/$/, ''), encrypt(JSON.stringify(auth_config)), JSON.stringify(field_mapping), webhookSecret, enabled ? 1 : 0);
  logAudit(req, { action: 'external_connection.created', entityType: 'external_connection', entityId: id, entityLabel: name, details: { platform, base_url } });
  res.status(201).json({ id });
});

router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM external_connections WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, base_url, auth_config, field_mapping, enabled } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (base_url !== undefined) { fields.push('base_url = ?'); params.push(base_url.replace(/\/$/, '')); }
  if (auth_config !== undefined) {
    // Merge onto the existing decrypted config so leaving a secret field
    // blank when editing preserves the previously saved value.
    const existing = JSON.parse(decrypt(row.auth_config) || '{}');
    const merged = { ...existing, ...auth_config };
    fields.push('auth_config = ?'); params.push(encrypt(JSON.stringify(merged)));
  }
  if (field_mapping !== undefined) { fields.push('field_mapping = ?'); params.push(JSON.stringify(field_mapping)); }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE external_connections SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'external_connection.updated', entityType: 'external_connection', entityId: req.params.id, entityLabel: name || row.name, details: { name, base_url, enabled } });
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM external_connections WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM external_connections WHERE id = ?').run(req.params.id);
  logAudit(req, { action: 'external_connection.deleted', entityType: 'external_connection', entityId: req.params.id, entityLabel: row.name });
  res.json({ ok: true });
});

router.post('/:id/test', async (req, res) => {
  const row = db.prepare('SELECT * FROM external_connections WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await testConnection(row);
    logAudit(req, { action: 'external_connection.tested', entityType: 'external_connection', entityId: req.params.id, entityLabel: row.name, details: { ok: result?.ok } });
    res.json(result);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;
