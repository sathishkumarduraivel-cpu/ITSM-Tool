import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { PERMISSIONS, sanitizePermissions } from '../services/permissions.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
// Defining/editing custom roles is itself a privilege-granting action, so
// unlike the areas it can delegate, only a full admin ever manages roles.
router.use(requireAuth, requireWorkspace, requireRole('admin'));

function parseRole(r) {
  return { ...r, permissions: JSON.parse(r.permissions || '[]') };
}

router.get('/', (req, res) => {
  const roles = db.prepare('SELECT * FROM custom_roles WHERE workspace_id = ? ORDER BY name').all(req.workspaceId).map(parseRole);
  const memberCounts = db.prepare('SELECT custom_role_id, COUNT(*) AS n FROM workspace_members WHERE workspace_id = ? AND custom_role_id IS NOT NULL GROUP BY custom_role_id').all(req.workspaceId);
  const countByRole = Object.fromEntries(memberCounts.map((r) => [r.custom_role_id, r.n]));
  res.json({
    roles: roles.map((r) => ({ ...r, member_count: countByRole[r.id] || 0 })),
    catalog: PERMISSIONS,
  });
});

router.post('/', (req, res) => {
  const { name, description, permissions = [] } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const id = uid('role');
  const sanitized = sanitizePermissions(permissions);
  db.prepare('INSERT INTO custom_roles (id, workspace_id, name, description, permissions) VALUES (?,?,?,?,?)')
    .run(id, req.workspaceId, name.trim(), description || null, JSON.stringify(sanitized));
  logAudit(req, { action: 'custom_role.created', entityType: 'custom_role', entityId: id, entityLabel: name.trim(), details: { permissions: sanitized } });
  res.status(201).json({ role: parseRole(db.prepare('SELECT * FROM custom_roles WHERE id = ?').get(id)) });
});

router.patch('/:id', (req, res) => {
  const role = db.prepare('SELECT * FROM custom_roles WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!role) return res.status(404).json({ error: 'Not found' });
  const { name, description, permissions } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'name cannot be empty' });
    fields.push('name = ?'); params.push(name.trim());
  }
  if (description !== undefined) { fields.push('description = ?'); params.push(description || null); }
  if (permissions !== undefined) { fields.push('permissions = ?'); params.push(JSON.stringify(sanitizePermissions(permissions))); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(role.id);
  db.prepare(`UPDATE custom_roles SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'custom_role.updated', entityType: 'custom_role', entityId: role.id, entityLabel: name !== undefined ? name.trim() : role.name, details: req.body });
  res.json({ role: parseRole(db.prepare('SELECT * FROM custom_roles WHERE id = ?').get(role.id)) });
});

router.delete('/:id', (req, res) => {
  const role = db.prepare('SELECT * FROM custom_roles WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!role) return res.status(404).json({ error: 'Not found' });
  // Members holding this role fall back to their base role rather than being
  // left pointing at a deleted row -- SQLite here has no FK enforcement on
  // by default, so this has to be done explicitly.
  db.prepare('UPDATE workspace_members SET custom_role_id = NULL WHERE custom_role_id = ?').run(role.id);
  db.prepare('DELETE FROM custom_roles WHERE id = ?').run(role.id);
  logAudit(req, { action: 'custom_role.deleted', entityType: 'custom_role', entityId: role.id, entityLabel: role.name });
  res.json({ ok: true });
});

export default router;
