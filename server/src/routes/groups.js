import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';

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

router.post('/', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid('grp');
  db.prepare('INSERT INTO groups (id, workspace_id, name, description) VALUES (?,?,?,?)').run(id, req.workspaceId, name, description || null);
  res.status(201).json(withMembers(db.prepare('SELECT * FROM groups WHERE id = ?').get(id)));
});

router.patch('/:id', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM groups WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, description } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE groups SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json(withMembers(db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id)));
});

router.delete('/:id', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM groups WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/members', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const group = db.prepare('SELECT id FROM groups WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { user_id } = req.body;
  // Only someone who's actually a member of this workspace can be added to one of its groups.
  const member = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, user_id);
  if (!member) return res.status(404).json({ error: 'User is not a member of this workspace' });
  const existing = db.prepare('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?').get(req.params.id, user_id);
  if (!existing) {
    db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), req.params.id, user_id);
  }
  res.json(withMembers(db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id)));
});

router.delete('/:id/members/:userId', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const group = db.prepare('SELECT id FROM groups WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!group) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  res.json(withMembers(db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id)));
});

export default router;
