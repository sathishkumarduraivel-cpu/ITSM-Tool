// Shared identity/JWT logic, used by both password login (routes/auth.js)
// and SSO login (routes/sso.js) so there is exactly one place that decides
// what goes into a session token -- two independent copies of this would be
// a correctness bug waiting to happen the moment one drifts from the other.
import jwt from 'jsonwebtoken';
import { db } from '../db.js';
import { JWT_SECRET } from '../middleware/auth.js';
import { resolveEffectivePermissions } from './permissions.js';

export function sign(identity) {
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
      // Resolved once at issue time (same caching-in-JWT pattern as role/team
      // above) -- a permission change on a custom role, or reassigning a
      // user to a different one, takes effect on their next login/token
      // refresh, exactly like a base role change already does today.
      permissions: identity.permissions || [],
      // Present only on an impersonated session (see POST /auth/impersonate)
      // -- names who is really behind the wheel, so the frontend can show a
      // persistent "viewing as X" banner and every action taken is provably
      // traceable back to the real admin from the token alone, not just the
      // one-time audit log entry created when the session was minted.
      ...(identity.impersonated_by ? { impersonated_by: identity.impersonated_by } : {}),
    },
    JWT_SECRET,
    // An impersonation session is deliberately short-lived -- it's meant for
    // "check this one thing as them," not a standing session, so it expires
    // far sooner than a normal 7-day login even though nothing else about it
    // (workspace scoping, permission checks) is any less real.
    { expiresIn: identity.impersonated_by ? '2h' : '7d' }
  );
}

// A deliberately weak, short-lived token for the gap between "password
// checked out" and "MFA code checked out" -- carries nothing but the
// user's id and an mfa_pending marker, unlike sign() above which always
// bakes in workspace/role/permissions. middleware/auth.js's requireAuth
// refuses any token carrying mfa_pending outright, so even if one leaked it
// cannot be used against a single real API route -- its only valid
// destination is POST /auth/mfa/verify.
export function signMfaChallenge(userId) {
  return jwt.sign({ sub: userId, mfa_pending: true }, JWT_SECRET, { expiresIn: '5m' });
}

export function verifyMfaChallenge(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  if (!payload.mfa_pending || !payload.sub) throw new Error('Not an MFA challenge token');
  return payload.sub;
}

export function membershipsForUser(userId) {
  return db.prepare(
    `SELECT wm.workspace_id, wm.role, wm.team, wm.active, wm.custom_role_id,
            wm.directory_provider_id, wm.directory_external_id, w.name AS workspace_name
     FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = ? AND wm.active = 1
     ORDER BY w.name`
  ).all(userId);
}

export function resolveIdentity(user, membership) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: membership.role,
    team: membership.team,
    workspace_id: membership.workspace_id,
    workspace_name: membership.workspace_name,
    is_super_admin: !!user.is_super_admin,
    permissions: resolveEffectivePermissions(user.id, membership.workspace_id, membership.custom_role_id),
  };
}
