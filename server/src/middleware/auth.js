import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { lookupApiKey } from '../services/apiKeys.js';

if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production — refusing to start with an insecure default.');
}
if (!process.env.JWT_SECRET) {
  console.warn('[auth] JWT_SECRET not set — using an insecure development-only fallback. Set JWT_SECRET in server/.env before any shared/hosted deployment.');
}
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me-in-prod';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  // The browser's native EventSource API can't set custom headers, so the
  // one real-time stream route (GET /api/realtime/stream) is reached with
  // the token as a query param instead -- deliberately scoped to exactly
  // that route (never a general fallback) since a query string ends up in
  // server logs; that one route is excluded from morgan's access log (see
  // index.js) specifically so this token never gets written to a log file.
  const isStreamRoute = req.originalUrl.startsWith('/api/realtime/stream');
  const token = header.startsWith('Bearer ') ? header.slice(7) : (isStreamRoute ? req.query.token || null : null);
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

// Admins always pass. Agents (or requesters, though none exist today) pass
// only if their custom role -- resolved into the JWT at login, see
// services/permissions.js -- was granted this specific permission key.
// Use this instead of requireRole('admin') on configuration areas that are
// safe to delegate; leave requireRole('admin') in place anywhere delegation
// itself would be a privilege-escalation risk (user/workspace management,
// AI provider credentials, procurement).
export function requirePermission(key) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Missing auth token' });
    if (req.user.role === 'admin') return next();
    if (Array.isArray(req.user.permissions) && req.user.permissions.includes(key)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}

// Auth for the public developer API (/api/v1/*) -- a completely separate
// credential from the session JWT above, since an external company system
// integrating with this platform has no user to log in as. Sets
// req.workspaceId and req.apiKey (never req.user -- there is no user)
// and 403s if the presented key lacks the scope this route requires.
export function requireApiKey(...scopes) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const rawKey = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!rawKey) return res.status(401).json({ error: 'Missing API key. Send it as: Authorization: Bearer <key>' });
    const key = lookupApiKey(rawKey);
    if (!key) return res.status(401).json({ error: 'Invalid, disabled, or expired API key' });
    const missing = scopes.filter((s) => !key.scopes.includes(s));
    if (missing.length) return res.status(403).json({ error: `This API key is missing required scope(s): ${missing.join(', ')}` });
    req.workspaceId = key.workspace_id;
    req.apiKey = key;
    next();
  };
}
