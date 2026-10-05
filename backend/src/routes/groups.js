import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();

function withMembers(group) {
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.avatar_color, wm.role
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
       WHERE gm.group_id = ? ORDER BY u.name`
    )
    .all(group.workspace_id, group.id);
  return { ...group, members };
}

// Groups are scoped to the caller's current workspace — a group configured
// under one workspace is never visible from another.
router.get('/', requireAuth, requireWorkspace, (req, res) => {
  const groups = db.prepare('SELECT * FROM groups WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  res.json({ groups: groups.map(withMembers) });
});

router.post('/', requireAuth, requireWorkspace, requirePermission('groups.manage'), (req, res) => {
  const { name, description, manager_user_id, default_custom_role_id } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  // Without this check, a caller who knows a custom_roles id from ANY
  // workspace (e.g. their own, where they're admin) could grant that role's
  // permission bundle to a group in a workspace where they only hold the
  // delegated groups.manage permission -- a cross-tenant privilege
  // escalation. Same check routes/auth.js already applies to the equivalent
  // per-member custom_role_id.
  if (default_custom_role_id) {
    const cr = db.prepare('SELECT id FROM custom_roles WHERE id = ? AND workspace_id = ?').get(default_custom_role_id, req.workspaceId);
    if (!cr) return res.status(400).json({ error: 'Custom role not found in this workspace' });
  }
  const id = uid('grp');
  db.prepare('INSERT INTO groups (id, workspace_id, name, description, manager_user_id, default_custom_role_id) VALUES (?,?,?,?,?,?)').run(
    id, req.workspaceId, name, description || null, manager_user_id || null, default_custom_role_id || null
  );
  logAudit(req, { action: 'group.created', entityType: 'group', entityId: id, entityLabel: name });
  res.status(201).json(withMembers(db.prepare('SELECT * FROM groups WHERE id = ?').get(id)));
});

router.patch('/:id', requireAuth, requireWorkspace, requirePermission('groups.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM groups WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, description, manager_user_id, default_custom_role_id } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description); }
  // A group's default-role grant changes what every member's NEXT-issued
  // token contains (permissions are resolved at login/token-issue time, same
  // caching-in-JWT tradeoff as every other role/permission change in this
  // app) -- not retroactive to already-issued sessions.
  if (manager_user_id !== undefined) { fields.push('manager_user_id = ?'); params.push(manager_user_id || null); }
  if (default_custom_role_id !== undefined) {
    if (default_custom_role_id) {
      const cr = db.prepare('SELECT id FROM custom_roles WHERE id = ? AND workspace_id = ?').get(default_custom_role_id, req.workspaceId);
      if (!cr) return res.status(400).json({ error: 'Custom role not found in this workspace' });
    }
    fields.push('default_custom_role_id = ?'); params.push(default_custom_role_id || null);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'group.updated', entityType: 'group', entityId: req.params.id, entityLabel: name || row.name, details: req.body });
  res.json(withMembers(db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', requireAuth, requireWorkspace, requirePermission('groups.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM groups WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  logAudit(req, { action: 'group.deleted', entityType: 'group', entityId: req.params.id, entityLabel: row.name });
  res.json({ ok: true });
});

router.post('/:id/members', requireAuth, requireWorkspace, requirePermission('groups.manage'), (req, res) => {
  const group = db.prepare('SELECT id, name FROM groups WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { user_id } = req.body;
  // Only someone who's actually a member of this workspace can be added to one of its groups.
  const member = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, user_id);
  if (!member) return res.status(404).json({ error: 'User is not a member of this workspace' });
  const existing = db.prepare('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?').get(req.params.id, user_id);
  if (!existing) {
    db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), req.params.id, user_id);
    const addedUser = db.prepare('SELECT name FROM users WHERE id = ?').get(user_id);
    logAudit(req, { action: 'group_member.added', entityType: 'group', entityId: req.params.id, entityLabel: group.name, details: { user: addedUser?.name } });
  }
  res.json(withMembers(db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id)));
});

router.delete('/:id/members/:userId', requireAuth, requireWorkspace, requirePermission('groups.manage'), (req, res) => {
  const group = db.prepare('SELECT * FROM groups WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!group) return res.status(404).json({ error: 'Not found' });
  const removedUser = db.prepare('SELECT name FROM users WHERE id = ?').get(req.params.userId);
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  logAudit(req, { action: 'group_member.removed', entityType: 'group', entityId: req.params.id, entityLabel: group.name, details: { user: removedUser?.name } });
  res.json(withMembers(db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id)));
});

export default router;
