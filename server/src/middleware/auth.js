import jwt from 'jsonwebtoken';
import { db } from '../db.js';

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production — refusing to start with an insecure default.');
}
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set — using an insecure development-only fallback. Set JWT_SECRET in server/.env before any shared/hosted deployment.');
}
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-prod';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing auth token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Must run after requireAuth. Establishes req.workspaceId for every scoped
// query. Super-admins may cross into another workspace by sending an
// `x-workspace-id` header (used for platform-level support/administration,
// not exposed in the current UI beyond this capability).
export function requireWorkspace(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Missing auth token' });
  let workspaceId = req.user.workspace_id;
  const override = req.headers['x-workspace-id'];
  if (override && req.user.is_super_admin) {
    const ws = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(override);
    if (!ws) return res.status(404).json({ error: 'Workspace not found' });
    workspaceId = ws.id;
  }
  if (!workspaceId) return res.status(400).json({ error: 'No workspace associated with this session' });
  req.workspaceId = workspaceId;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
