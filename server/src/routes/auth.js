import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { db, uid, DEFAULT_WORKSPACE_ID } from '../db.js';
import { JWT_SECRET, requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please try again later.' },
});

function sign(identity) {
  return jwt.sign(
    {
      id: identity.id,
      name: identity.name,
      email: identity.email,
      role: identity.role,
      team: identity.team,
      workspace_id: identity.workspace_id,
      workspace_name: identity.workspace_name,
      is_super_admin: !!identity.is_super_admin,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function membershipsForUser(userId) {
  return db.prepare(
    `SELECT wm.workspace_id, wm.role, wm.team, wm.active, w.name AS workspace_name
     FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ? AND wm.active = 1
     ORDER BY w.name`
  ).all(userId);
}

function resolveIdentity(user, membership) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: membership.role,
    team: membership.team,
    workspace_id: membership.workspace_id,
    workspace_name: membership.workspace_name,
    is_super_admin: !!user.is_super_admin,
  };
}

// Self-service sign-up. Unlike the old flow, this no longer lets the caller
// spin up a brand-new workspace — workspaces are provisioned by admins in
// Admin Settings, and self-registered accounts just join the Default
// workspace as a requester (typical "employee raises their own ticket"
// portal signup). Adding someone to a specific/other workspace is an admin
// action (Admin Settings → Users), which is what actually scopes their
// access to that one workspace.
router.post('/register', authLimiter, (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, password required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const userId = uid('usr');
  const password_hash = bcrypt.hashSync(password, 10);
  const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
  const avatar_color = colors[Math.floor(Math.random() * colors.length)];

  db.prepare('INSERT INTO users (id, name, email, password_hash, role, avatar_color, last_workspace_id) VALUES (?,?,?,?,?,?,?)')
    .run(userId, name, email, password_hash, 'requester', avatar_color, DEFAULT_WORKSPACE_ID);
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?,?,?,?)')
    .run(uid('wm'), DEFAULT_WORKSPACE_ID, userId, 'requester');

  const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(DEFAULT_WORKSPACE_ID);
  const identity = resolveIdentity(
    { id: userId, name, email, is_super_admin: 0 },
    { role: 'requester', team: null, workspace_id: DEFAULT_WORKSPACE_ID, workspace_name: workspace?.name }
  );
  const memberships = membershipsForUser(userId);
  res.status(201).json({
    token: sign(identity),
    user: identity,
    workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.workspace_name, role: m.role })),
  });
});

router.post('/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const memberships = membershipsForUser(user.id);
  if (memberships.length === 0) {
    return res.status(403).json({ error: 'This account has no active workspace membership.' });
  }
  const membership = memberships.find((m) => m.workspace_id === user.last_workspace_id) || memberships[0];
  const identity = resolveIdentity(user, membership);

  db.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(membership.workspace_id, user.id);

  res.json({
    token: sign(identity),
    user: identity,
    workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.workspace_name, role: m.role })),
  });
});

// Only succeeds if the caller actually has a membership in the target
// workspace — a user added to just one workspace has nothing to switch to.
router.post('/switch-workspace', requireAuth, (req, res) => {
  const { workspace_id } = req.body;
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
  const memberships = membershipsForUser(req.user.id);
  const membership = memberships.find((m) => m.workspace_id === workspace_id);
  if (!membership) return res.status(403).json({ error: 'Not a member of that workspace' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  db.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(workspace_id, user.id);
  const identity = resolveIdentity(user, membership);

  res.json({
    token: sign(identity),
    user: identity,
    workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.workspace_name, role: m.role })),
  });
});

router.get('/me', requireAuth, requireWorkspace, (req, res) => {
  const memberships = membershipsForUser(req.user.id);
  res.json({
    user: req.user,
    workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.workspace_name, role: m.role })),
  });
});

// Workspace-scoped user directory (used e.g. for "assign to agent" pickers).
router.get('/users', requireAuth, requireWorkspace, (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.email, wm.role, wm.team, u.avatar_color, wm.active
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND wm.active = 1
     ORDER BY u.name`
  ).all(req.workspaceId);
  res.json({ users: rows });
});

// Admin: full user directory for the CURRENT workspace, including deactivated
// members (for Admin Settings → Users). A user only ever shows up here for
// the workspace(s) they were actually added to.
router.get('/users/all', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const rows = db.prepare(
    `SELECT u.id, u.name, u.email, wm.role, wm.team, u.avatar_color, wm.active, u.created_at
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ?
     ORDER BY u.name`
  ).all(req.workspaceId);
  res.json({ users: rows });
});

// Admin: create a user directly, scoped to the admin's current workspace —
// this is what gives the new user access to exactly that one workspace.
router.post('/users', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const { name, email, password, role = 'requester', team } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });

  let user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (user) {
    const already = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, user.id);
    if (already) return res.status(409).json({ error: 'User already belongs to this workspace' });
  } else {
    const id = uid('usr');
    const password_hash = bcrypt.hashSync(password, 10);
    const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
    const avatar_color = colors[Math.floor(Math.random() * colors.length)];
    db.prepare('INSERT INTO users (id, name, email, password_hash, avatar_color, last_workspace_id) VALUES (?,?,?,?,?,?)')
      .run(id, name, email, password_hash, avatar_color, req.workspaceId);
    user = { id };
  }
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, team) VALUES (?,?,?,?,?)')
    .run(uid('wm'), req.workspaceId, user.id, role, team || null);
  res.status(201).json({ id: user.id });
});

// Admin: change a member's role/team within the current workspace, or
// deactivate their membership (blocks access to just this workspace, not
// any other workspace they may separately belong to).
router.patch('/users/:id', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const membership = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, req.params.id);
  if (!membership) return res.status(404).json({ error: 'Not found in this workspace' });
  const { role, team, active } = req.body;
  const fields = []; const params = [];
  if (role !== undefined) { fields.push('role = ?'); params.push(role); }
  if (team !== undefined) { fields.push('team = ?'); params.push(team); }
  if (active !== undefined) { fields.push('active = ?'); params.push(active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(membership.id);
  db.prepare(`UPDATE workspace_members SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// Admin: remove a member from the current workspace entirely (not just
// deactivate). Only revokes access to this workspace — any other workspace
// membership they hold, and their global account, are untouched.
router.delete('/users/:id', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove yourself from this workspace" });
  const membership = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, req.params.id);
  if (!membership) return res.status(404).json({ error: 'Not found in this workspace' });
  db.prepare('DELETE FROM workspace_members WHERE id = ?').run(membership.id);
  db.prepare('DELETE FROM group_members WHERE user_id = ? AND group_id IN (SELECT id FROM groups WHERE workspace_id = ?)').run(req.params.id, req.workspaceId);
  res.json({ ok: true });
});

export default router;
