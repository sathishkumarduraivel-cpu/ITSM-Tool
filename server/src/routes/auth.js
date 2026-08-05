import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { db, uid } from '../db.js';
import { JWT_SECRET, requireAuth, requireWorkspace } from '../middleware/auth.js';

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

// Sign up + create a brand-new workspace (the caller becomes its admin).
router.post('/register', authLimiter, (req, res) => {
  const { name, email, password, workspace_name } = req.body;
  if (!name || !email || !password || !workspace_name) {
    return res.status(400).json({ error: 'name, email, password, workspace_name required' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const userId = uid('usr');
  const password_hash = bcrypt.hashSync(password, 10);
  const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
  const avatar_color = colors[Math.floor(Math.random() * colors.length)];

  const wsId = uid('ws');
  const slugBase = workspace_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace';
  let slug = slugBase;
  let n = 1;
  while (db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug)) {
    slug = `${slugBase}-${++n}`;
  }

  db.prepare('INSERT INTO users (id, name, email, password_hash, role, avatar_color, last_workspace_id) VALUES (?,?,?,?,?,?,?)')
    .run(userId, name, email, password_hash, 'admin', avatar_color, wsId);
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(wsId, workspace_name, slug);
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?,?,?,?)')
    .run(uid('wm'), wsId, userId, 'admin');

  const identity = resolveIdentity(
    { id: userId, name, email, is_super_admin: 0 },
    { role: 'admin', team: null, workspace_id: wsId, workspace_name }
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

export default router;
