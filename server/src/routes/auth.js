import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { db, uid } from '../db.js';
import { JWT_SECRET, requireAuth, attachWorkspace, requireRole } from '../middleware/auth.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please try again later.' },
});

function sign(user) {
  return jwt.sign(
    {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      team: user.team,
      workspace_id: user.last_workspace_id,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function publicUser(user) {
  const ws = user.last_workspace_id ? db.prepare('SELECT id, name FROM workspaces WHERE id = ?').get(user.last_workspace_id) : null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    team: user.team,
    avatar_color: user.avatar_color,
    workspace_id: ws?.id || null,
    workspace_name: ws?.name || null,
  };
}

function allWorkspaces() {
  return db.prepare('SELECT id, name FROM workspaces ORDER BY name').all();
}

function defaultWorkspaceId() {
  const row = db.prepare("SELECT id FROM workspaces WHERE slug = 'default'").get() || db.prepare('SELECT id FROM workspaces ORDER BY created_at LIMIT 1').get();
  return row?.id || null;
}

router.post('/register', authLimiter, (req, res) => {
  const { name, email, password, workspace_name } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const userId = uid('usr');
  const password_hash = bcrypt.hashSync(password, 10);
  const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
  const avatar_color = colors[Math.floor(Math.random() * colors.length)];

  let wsId;
  if (workspace_name) {
    wsId = uid('ws');
    const slugBase = workspace_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace';
    let slug = slugBase;
    let n = 1;
    while (db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug)) slug = `${slugBase}-${++n}`;
    db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(wsId, workspace_name, slug);
  } else {
    wsId = defaultWorkspaceId();
  }

  db.prepare('INSERT INTO users (id, name, email, password_hash, role, avatar_color, last_workspace_id) VALUES (?,?,?,?,?,?,?)')
    .run(userId, name, email, password_hash, 'admin', avatar_color, wsId);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  res.status(201).json({ token: sign(user), user: publicUser(user), workspaces: allWorkspaces() });
});

router.post('/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (user.active === 0) {
    return res.status(403).json({ error: 'This account has been deactivated.' });
  }
  if (!user.last_workspace_id) {
    db.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(defaultWorkspaceId(), user.id);
    user.last_workspace_id = defaultWorkspaceId();
  }
  res.json({ token: sign(user), user: publicUser(user), workspaces: allWorkspaces() });
});

// Switching workspace just changes which one is "currently selected" for
// labeling new records — every workspace is visible to everyone, so there's
// no membership check here.
router.post('/switch-workspace', requireAuth, (req, res) => {
  const { workspace_id } = req.body;
  if (!workspace_id) return res.status(400).json({ error: 'workspace_id required' });
  const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(workspace_id);
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  db.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(workspace_id, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json({ token: sign(user), user: publicUser(user), workspaces: allWorkspaces() });
});

router.get('/me', requireAuth, attachWorkspace, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json({ user: publicUser(user), workspaces: allWorkspaces() });
});

// Global user directory (used e.g. for "assign to agent" pickers, and Admin Settings).
router.get('/users', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, name, email, role, team, avatar_color, active FROM users WHERE active = 1 ORDER BY name').all();
  res.json({ users: rows });
});

// Admin: full user directory including deactivated accounts (for Admin Settings).
router.get('/users/all', requireAuth, requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT id, name, email, role, team, avatar_color, active FROM users ORDER BY name').all();
  res.json({ users: rows });
});

// Admin: create a new user directly (no self-registration flow involved).
router.post('/users', requireAuth, requireRole('admin'), (req, res) => {
  const { name, email, password, role = 'requester', team } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const id = uid('usr');
  const password_hash = bcrypt.hashSync(password, 10);
  const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
  const avatar_color = colors[Math.floor(Math.random() * colors.length)];
  db.prepare('INSERT INTO users (id, name, email, password_hash, role, team, avatar_color, last_workspace_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, name, email, password_hash, role, team || null, avatar_color, defaultWorkspaceId());
  res.status(201).json({ id });
});

// Admin: change a user's role/team, or deactivate them (blocks future logins).
router.patch('/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { role, team, active } = req.body;
  const fields = []; const params = [];
  if (role !== undefined) { fields.push('role = ?'); params.push(role); }
  if (team !== undefined) { fields.push('team = ?'); params.push(team); }
  if (active !== undefined) { fields.push('active = ?'); params.push(active ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

export default router;
