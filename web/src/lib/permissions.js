// Admins always have every permission. Everyone else only has what their
// assigned custom role granted -- baked into `user.permissions` at login,
// mirroring server/src/services/permissions.js's server-side check.
export function hasPermission(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(user.permissions) && user.permissions.includes(key);
}

export function hasAnyPermission(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Array.isArray(user.permissions) && user.permissions.length > 0;
}
