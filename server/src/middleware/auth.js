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

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}
