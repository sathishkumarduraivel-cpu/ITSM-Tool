import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { buildWorkspaceBackup, snapshotRawDatabase, cleanupSnapshot, dbFileSizeBytes } from '../services/backup.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

const SETTINGS_KEY = 'company_profile';

router.get('/settings', (req, res) => {
  const row = db.prepare('SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ?').get(req.workspaceId, SETTINGS_KEY);
  const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(req.workspaceId);
  const defaults = { name: workspace?.name || '', support_email: '', timezone: 'UTC', default_priority: 'medium' };
  const saved = row ? JSON.parse(row.value) : {};
  res.json({ settings: { ...defaults, ...saved } });
});

router.patch('/settings', requireRole('admin'), (req, res) => {
  const { name, support_email, timezone, default_priority } = req.body;
  const value = JSON.stringify({ name, support_email, timezone, default_priority });
  db.prepare(
    `INSERT INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(req.workspaceId, SETTINGS_KEY, value);
  if (name) db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, req.workspaceId);
  res.json({ ok: true });
});

// A quick summary (row counts, whether a full-instance snapshot is even an
// option for this account) so the Backups screen can show something useful
// before anyone actually triggers a download.
router.get('/backup/summary', requireRole('admin'), (req, res) => {
  const { meta } = buildWorkspaceBackup(req.workspaceId);
  res.json({
    workspace: meta.workspace,
    counts: meta.counts,
    canDownloadDatabase: !!req.user.is_super_admin,
    dbSizeBytes: req.user.is_super_admin ? dbFileSizeBytes() : null,
  });
});

// Workspace-scoped JSON export -- any workspace admin, not just a
// super-admin, since this only ever contains data that workspace's own
// admin can already see through the normal UI. See services/backup.js for
// exactly what is (and deliberately isn't) included.
router.get('/backup/export', requireRole('admin'), (req, res) => {
  const backup = buildWorkspaceBackup(req.workspaceId);
  const slug = (backup.meta.workspace.slug || 'workspace').replace(/[^a-z0-9-]/gi, '-');
  logAudit(req, { action: 'backup.exported', entityType: 'workspace', entityId: req.workspaceId, entityLabel: backup.meta.workspace.name, details: { counts: backup.meta.counts } });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="itsm-ai-backup-${slug}-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(backup, null, 2));
});

// The raw SQLite file, via VACUUM INTO for a guaranteed-consistent snapshot
// rather than a live filesystem copy -- see services/backup.js. Spans every
// workspace in this instance, so it's gated to super-admins only, unlike the
// JSON export above. Genuinely important given this app's Render deployment
// has no persistent disk (see index.js's auto-seed-on-boot comment) -- this
// is the one way to actually get data OFF an ephemeral instance.
// Platform-operator concern, not a per-workspace one -- see error_log's own
// comment in db.js for why this is super-admin-gated the same way the raw
// database backup below is, rather than requireRole('admin').
router.get('/errors', (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Only a super-admin can view the error log.' });
  const rows = db.prepare('SELECT * FROM error_log ORDER BY created_at DESC LIMIT 200').all();
  res.json({ errors: rows });
});

router.delete('/errors', (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Only a super-admin can clear the error log.' });
  db.prepare('DELETE FROM error_log').run();
  logAudit(req, { action: 'error_log.cleared', entityType: 'system' });
  res.json({ ok: true });
});

// Grant/revoke the platform-wide super-admin flag on a user account.
// Deliberately gated the same way as /errors and /backup/database above
// (super-admin only, NOT requireRole('admin')) -- a regular workspace admin
// must never be able to hand this power to themselves or anyone else.
// is_super_admin lives on `users`, not `workspace_members`, since it isn't
// scoped to any one workspace.
router.patch('/users/:id/super-admin', (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Only a super-admin can grant or revoke super-admin access.' });
  const target = db.prepare('SELECT id, email FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const value = req.body.is_super_admin ? 1 : 0;
  // Same self-protection as DELETE /auth/users/:id's self-removal guard --
  // without it, the last super-admin could lock everyone (including
  // themselves) out of the raw-backup/error-log features with no UI left to
  // undo it (recovery would mean editing the database directly again).
  if (!value && req.params.id === req.user.id) {
    return res.status(400).json({ error: "You can't revoke your own super-admin access." });
  }
  db.prepare('UPDATE users SET is_super_admin = ? WHERE id = ?').run(value, target.id);
  logAudit(req, { action: value ? 'user.super_admin_granted' : 'user.super_admin_revoked', entityType: 'user', entityId: target.id, entityLabel: target.email });
  res.json({ ok: true });
});

router.get('/backup/database', (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Only a super-admin can download the full database.' });
  let tmpPath;
  try {
    tmpPath = snapshotRawDatabase();
  } catch (e) {
    return res.status(500).json({ error: 'Could not snapshot the database: ' + e.message });
  }
  logAudit(req, { action: 'backup.database_downloaded', entityType: 'workspace' });
  res.download(tmpPath, `itsm-ai-database-${new Date().toISOString().slice(0, 10)}.db`, (err) => {
    cleanupSnapshot(tmpPath);
    if (err && !res.headersSent) res.status(500).json({ error: 'Download failed' });
  });
});

export default router;
