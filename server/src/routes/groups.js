import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

function withMembers(group) {
  const members = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.avatar_color
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ? ORDER BY u.name`
    )
    .all(group.id);
  return { ...group, members };
}

router.get('/', requireAuth, (req, res) => {
  const groups = db.prepare('SELECT * FROM groups ORDER BY name').all();
  res.json({ groups: groups.map(withMembers) });
});

router.post('/', requireAuth, requireRole('admin'), (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid('grp');
  db.prepare('INSERT INTO groups (id, name, description) VALUES (?,?,?)').run(id, name, description || null);
  res.status(201).json(withMembers(db.prepare('SELECT * FROM groups WHERE id = ?').get(id)));
});

router.patch('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM groups WHERE id = ?').get(req.params.id);
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

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM groups WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM groups WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/members', requireAuth, requireRole('admin'), (req, res) => {
  const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const { user_id } = req.body;
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const existing = db.prepare('SELECT id FROM group_members WHERE group_id = ? AND user_id = ?').get(req.params.id, user_id);
  if (!existing) {
    db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), req.params.id, user_id);
  }
  res.json(withMembers(db.prepare('SELECT * FROM groups WHERE id = ?').get(req.params.id)));
});

router.delete('/:id/members/:userId', requireAuth, requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(req.params.id, req.params.userId);
  const group = db.prepare('SELECT id FROM groups WHERE id = ?').get(req.params.id);
  if (!group) return res.status(404).json({ error: 'Not found' });
  res.json(withMembers(group));
});

export default router;
