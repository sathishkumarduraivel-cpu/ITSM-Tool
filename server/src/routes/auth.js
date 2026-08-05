import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db, uid } from '../db.js';
import { JWT_SECRET, requireAuth } from '../middleware/auth.js';

const router = Router();

function sign(user) {
  return jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, team: user.team },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

router.post('/register', (req, res) => {
  const { name, email, password, role = 'requester', team } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const id = uid('usr');
  const password_hash = bcrypt.hashSync(password, 10);
  const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
  const avatar_color = colors[Math.floor(Math.random() * colors.length)];
  db.prepare(
    'INSERT INTO users (id, name, email, password_hash, role, team, avatar_color) VALUES (?,?,?,?,?,?,?)'
  ).run(id, name, email, password_hash, role, team || null, avatar_color);
  const user = { id, name, email, role, team };
  res.json({ token: sign(user), user });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !bcrypt.compareSync(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const user = { id: row.id, name: row.name, email: row.email, role: row.role, team: row.team };
  res.json({ token: sign(user), user });
});

router.get('/me', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, name, email, role, team, avatar_color FROM users WHERE id = ?').get(req.user.id);
  res.json({ user: row });
});

router.get('/users', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, name, email, role, team, avatar_color FROM users ORDER BY name').all();
  res.json({ users: rows });
});

export default router;
