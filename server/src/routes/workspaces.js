import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();

// List workspaces the caller belongs to (redundant with the login response,
// useful after a token refresh without re-authenticating).
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT w.id, w.name, w.slug, wm.role
     FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ? AND wm.active = 1
     ORDER BY w.name`
  ).all(req.user.id);
  res.json({ workspaces: rows });
});

// Self-serve creation of an additional workspace; caller becomes its admin.
router.post('/', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid('ws');
  const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace';
  let slug = slugBase;
  let n = 1;
  while (db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug)) {
    slug = `${slugBase}-${++n}`;
  }
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, name, slug);
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?,?,?,?)')
    .run(uid('wm'), id, req.user.id, 'admin');
  logAudit({ user: req.user, workspaceId: id, ip: req.ip }, { action: 'workspace.created', entityType: 'workspace', entityId: id, entityLabel: name });
  res.status(201).json({ id, name, slug });
});

function assertOwnWorkspace(req, res) {
  if (req.params.id !== req.workspaceId) {
    res.status(403).json({ error: 'Cannot manage another workspace' });
    return false;
  }
  return true;
}

router.patch('/:id', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  if (!assertOwnWorkspace(req, res)) return;
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, req.workspaceId);
  logAudit(req, { action: 'workspace.updated', entityType: 'workspace', entityId: req.workspaceId, entityLabel: name });
  res.json({ ok: true });
});

// Admins may only delete the workspace they themselves belong to — never an
// arbitrary one, since that would mean touching data they can't otherwise see.
router.delete('/:id', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  if (!assertOwnWorkspace(req, res)) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n;
  if (count <= 1) return res.status(400).json({ error: 'At least one workspace must remain' });
  const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(req.workspaceId);
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.workspaceId);
  logAudit(req, { action: 'workspace.deleted', entityType: 'workspace', entityId: req.workspaceId, entityLabel: ws?.name });
  res.json({ ok: true });
});

router.get('/:id/members', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  if (!assertOwnWorkspace(req, res)) return;
  const rows = db.prepare(
    `SELECT wm.id AS membership_id, u.id AS user_id, u.name, u.email, wm.role, wm.team, wm.active, u.avatar_color
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ?
     ORDER BY u.name`
  ).all(req.workspaceId);
  res.json({ members: rows });
});

// Adds an existing user to this workspace, or creates a brand-new user + membership.
router.post('/:id/members', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  if (!assertOwnWorkspace(req, res)) return;
  const { name, email, password, role = 'requester', team } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    if (!name || !password) return res.status(400).json({ error: 'name and password required to create a new user' });
    const id = uid('usr');
    const password_hash = bcrypt.hashSync(password, 10);
    const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
    const avatar_color = colors[Math.floor(Math.random() * colors.length)];
    db.prepare('INSERT INTO users (id, name, email, password_hash, role, avatar_color, last_workspace_id) VALUES (?,?,?,?,?,?,?)')
      .run(id, name, email, password_hash, role, avatar_color, req.workspaceId);
    user = { id };
  }

  const existingMembership = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, user.id);
  if (existingMembership) return res.status(409).json({ error: 'User is already a member of this workspace' });

  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, team) VALUES (?,?,?,?,?)')
    .run(uid('wm'), req.workspaceId, user.id, role, team || null);
  logAudit(req, { action: 'workspace_member.added', entityType: 'workspace', entityId: req.workspaceId, entityLabel: email, details: { role, team } });
  res.status(201).json({ ok: true });
});

router.patch('/:id/members/:userId', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  if (!assertOwnWorkspace(req, res)) return;
  const membership = db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, req.params.userId);
  if (!membership) return res.status(404).json({ error: 'Not found' });
  const { role, team, active } = req.body;
  const fields = []; const params = [];
  if (role !== undefined) { fields.push('role = ?'); params.push(role); }
  if (team !== undefined) { fields.push('team = ?'); params.push(team); }
  if (active !== undefined) { fields.push('active = ?'); params.push(active ? 1 : 0); }
  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(membership.id);
  db.prepare(`UPDATE workspace_members SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  const targetUser = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.userId);
  logAudit(req, { action: 'workspace_member.updated', entityType: 'workspace', entityId: req.workspaceId, entityLabel: targetUser?.email, details: req.body });
  res.json({ ok: true });
});

router.delete('/:id/members/:userId', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  if (!assertOwnWorkspace(req, res)) return;
  const targetUser = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.userId);
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(req.workspaceId, req.params.userId);
  logAudit(req, { action: 'workspace_member.removed', entityType: 'workspace', entityId: req.workspaceId, entityLabel: targetUser?.email });
  res.json({ ok: true });
});

export default router;
