import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { runSync, testProvider } from '../services/directorySync.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
const TYPES = ['ldap', 'microsoft_graph'];

// Never delegable -- same reasoning as SSO provider config (routes/sso.js):
// standing up something that provisions accounts and can deactivate people
// is exactly the kind of privilege-granting action that stays hard admin-only.
router.use(requireAuth, requireWorkspace, requireRole('admin'));

function redactConfig(provider) {
  const config = JSON.parse(decrypt(provider.config) || '{}');
  const redacted = { ...config };
  if (redacted.bindPassword) redacted.bindPassword = '••••';
  if (redacted.client_secret) redacted.client_secret = '••••';
  return redacted;
}

function redact(row) {
  return { ...row, config: redactConfig(row) };
}

function validateConfig(type, config) {
  if (type === 'ldap') {
    if (!config.url || !config.bindDN || !config.bindPassword || !config.baseDN) {
      return 'url, bindDN, bindPassword and baseDN are required for an LDAP directory.';
    }
  } else if (type === 'microsoft_graph') {
    if (!config.tenant_id || !config.client_id || !config.client_secret) {
      return 'tenant_id, client_id and client_secret are required for a Microsoft Graph directory.';
    }
  }
  return null;
}

// A blank secret field in an edit means "keep the current value" (same
// merge-on-patch convention integrations.js and sso.js already use) --
// otherwise every edit would force re-typing the bind password / client
// secret just to change an unrelated field like the sync interval.
function mergeConfig(existingProvider, incoming) {
  const existing = JSON.parse(decrypt(existingProvider.config) || '{}');
  const merged = { ...existing, ...incoming };
  if (!incoming.bindPassword) merged.bindPassword = existing.bindPassword;
  if (!incoming.client_secret) merged.client_secret = existing.client_secret;
  return merged;
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM directory_providers WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  res.json({ providers: rows.map(redact), types: TYPES });
});

router.post('/', (req, res) => {
  const {
    type, name, config = {}, sync_interval_minutes = 0,
    auto_provision_role = 'requester', default_custom_role_id, default_team, enabled = true,
  } = req.body;
  if (!TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${TYPES.join(', ')}` });
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!['requester', 'agent'].includes(auto_provision_role)) return res.status(400).json({ error: 'auto_provision_role must be requester or agent' });
  const configError = validateConfig(type, config);
  if (configError) return res.status(400).json({ error: configError });
  if (default_custom_role_id) {
    // Same cross-tenant escalation check as groups.js's default_custom_role_id
    // -- without it, a custom_roles id borrowed from another workspace this
    // admin also happens to run could grant that role's permissions to every
    // account this directory ever provisions here.
    const cr = db.prepare('SELECT id FROM custom_roles WHERE id = ? AND workspace_id = ?').get(default_custom_role_id, req.workspaceId);
    if (!cr) return res.status(400).json({ error: 'Custom role not found in this workspace' });
  }

  const id = uid('dir');
  db.prepare(
    `INSERT INTO directory_providers (id, workspace_id, type, name, config, sync_interval_minutes, auto_provision_role, default_custom_role_id, default_team, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, type, name, encrypt(JSON.stringify(config)), Number(sync_interval_minutes) || 0, auto_provision_role, default_custom_role_id || null, default_team || null, enabled ? 1 : 0);
  logAudit(req, { action: 'directory_provider.created', entityType: 'directory_provider', entityId: id, entityLabel: name, details: { type } });
  res.status(201).json({ provider: redact(db.prepare('SELECT * FROM directory_providers WHERE id = ?').get(id)) });
});

router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM directory_providers WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, config, sync_interval_minutes, auto_provision_role, default_custom_role_id, default_team, enabled } = req.body;
  if (auto_provision_role !== undefined && !['requester', 'agent'].includes(auto_provision_role)) {
    return res.status(400).json({ error: 'auto_provision_role must be requester or agent' });
  }
  if (default_custom_role_id) {
    const cr = db.prepare('SELECT id FROM custom_roles WHERE id = ? AND workspace_id = ?').get(default_custom_role_id, req.workspaceId);
    if (!cr) return res.status(400).json({ error: 'Custom role not found in this workspace' });
  }
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (config !== undefined) {
    const merged = mergeConfig(row, config);
    const configError = validateConfig(row.type, merged);
    if (configError) return res.status(400).json({ error: configError });
    fields.push('config = ?'); params.push(encrypt(JSON.stringify(merged)));
  }
  if (sync_interval_minutes !== undefined) { fields.push('sync_interval_minutes = ?'); params.push(Number(sync_interval_minutes) || 0); }
  if (auto_provision_role !== undefined) { fields.push('auto_provision_role = ?'); params.push(auto_provision_role); }
  if (default_custom_role_id !== undefined) { fields.push('default_custom_role_id = ?'); params.push(default_custom_role_id || null); }
  if (default_team !== undefined) { fields.push('default_team = ?'); params.push(default_team || null); }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(row.id);
  db.prepare(`UPDATE directory_providers SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'directory_provider.updated', entityType: 'directory_provider', entityId: row.id, entityLabel: name || row.name, details: { sync_interval_minutes, auto_provision_role, enabled } });
  res.json({ provider: redact(db.prepare('SELECT * FROM directory_providers WHERE id = ?').get(row.id)) });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM directory_providers WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM directory_providers WHERE id = ?').run(row.id);
  logAudit(req, { action: 'directory_provider.deleted', entityType: 'directory_provider', entityId: row.id, entityLabel: row.name });
  res.json({ ok: true });
});

// Bind/connect + a small sample search -- never writes anything, purely a
// "did I configure this right" check before the first real sync.
router.post('/:id/test', async (req, res) => {
  const row = db.prepare('SELECT * FROM directory_providers WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const result = await testProvider(row);
  res.json(result);
});

router.post('/:id/sync', async (req, res) => {
  const row = db.prepare('SELECT * FROM directory_providers WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  try {
    const result = await runSync(row.id);
    logAudit(req, { action: 'directory_provider.synced', entityType: 'directory_provider', entityId: row.id, entityLabel: row.name, details: result });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:id/log', (req, res) => {
  const row = db.prepare('SELECT id FROM directory_providers WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const logs = db.prepare('SELECT * FROM directory_sync_logs WHERE provider_id = ? ORDER BY created_at DESC LIMIT 50').all(row.id);
  res.json({ logs });
});

export default router;
