import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { SCOPES, sanitizeScopes, generateApiKey } from '../services/apiKeys.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
// Issuing a credential that can reach this workspace's data from outside is
// exactly the kind of privilege-granting action that stays hard admin-only
// -- same tier as SSO configuration and AI provider credentials, never
// delegable through the custom-roles permission catalog.
router.use(requireAuth, requireWorkspace, requireRole('admin'));

function redact(row) {
  return { ...row, key_hash: undefined, scopes: JSON.parse(row.scopes || '[]') };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({ keys: rows.map(redact), scopes: SCOPES });
});

router.post('/', (req, res) => {
  const { name, scopes = [], expires_at } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const cleanScopes = sanitizeScopes(scopes);
  if (!cleanScopes.length) return res.status(400).json({ error: 'Grant at least one scope — a key with none can do nothing.' });

  const { raw, prefix, hash } = generateApiKey();
  const id = uid('key');
  db.prepare('INSERT INTO api_keys (id, workspace_id, name, key_prefix, key_hash, scopes, created_by, expires_at) VALUES (?,?,?,?,?,?,?,?)').run(
    id, req.workspaceId, name.trim(), prefix, hash, JSON.stringify(cleanScopes), req.user.id, expires_at || null
  );
  logAudit(req, { action: 'api_key.created', entityType: 'api_key', entityId: id, entityLabel: name.trim(), details: { scopes: cleanScopes } });
  // The only moment the raw key is ever readable -- this response is never
  // reconstructable later, same practice as Stripe/GitHub/every real API
  // token issuer, precisely so a leaked database backup alone can't be
  // turned into a usable credential.
  res.status(201).json({ key: redact(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id)), rawKey: raw });
});

router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, scopes, enabled, expires_at } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name.trim()); }
  if (scopes !== undefined) {
    const cleanScopes = sanitizeScopes(scopes);
    if (!cleanScopes.length) return res.status(400).json({ error: 'Grant at least one scope' });
    fields.push('scopes = ?'); params.push(JSON.stringify(cleanScopes));
  }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (expires_at !== undefined) { fields.push('expires_at = ?'); params.push(expires_at || null); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(row.id);
  db.prepare(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'api_key.updated', entityType: 'api_key', entityId: row.id, entityLabel: name || row.name, details: { scopes, enabled } });
  res.json({ key: redact(db.prepare('SELECT * FROM api_keys WHERE id = ?').get(row.id)) });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(row.id);
  logAudit(req, { action: 'api_key.revoked', entityType: 'api_key', entityId: row.id, entityLabel: row.name });
  res.json({ ok: true });
});

export default router;
