import jwt from 'jsonwebtoken';

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

// Must run after requireAuth. Attaches the user's currently-selected workspace
// as req.workspaceId purely as a display/tagging label (e.g. for new records) —
// it is NOT used to restrict what data a request can read or write. There is
// a single shared pool of data for everyone; "workspace" is just a name.
export function attachWorkspace(req, res, next) {
  req.workspaceId = req.user?.workspace_id || null;
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
