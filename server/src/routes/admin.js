import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, attachWorkspace, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

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

export default router;
