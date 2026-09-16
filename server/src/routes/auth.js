import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db, uid, DEFAULT_WORKSPACE_ID } from '../db.js';
import { requireAuth, requireWorkspace, requireRole, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import { sign, membershipsForUser, resolveIdentity, signMfaChallenge, verifyMfaChallenge } from '../services/authTokens.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { verifyBind } from '../services/ldapClient.js';
import { generateSecret, verifyTOTP, otpauthUrl, generateRecoveryCodes, hashRecoveryCode } from '../services/totp.js';
import QRCode from 'qrcode';

const router = Router();

// Strict in production (brute-force protection); generous outside it so
// normal dev/test iteration doesn't trip the same limiter real users share.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 10 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please try again later.' },
});

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

router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  // membershipsForUser already filters to active=1 only -- a membership
  // deactivated by a prior directory sync simply won't appear here, so it's
  // rejected below by the existing "no active workspace membership" check
  // without ever attempting a bind against the directory for it.
  const memberships = membershipsForUser(user.id);
  if (memberships.length === 0) {
    return res.status(403).json({ error: 'This account has no active workspace membership.' });
  }
  const membership = memberships.find((m) => m.workspace_id === user.last_workspace_id) || memberships[0];

  // A membership linked to an enabled LDAP directory provider authenticates
  // via a live bind against that directory instead of comparing the local
  // password hash -- see services/ldapClient.js. Every other membership
  // (manually created, OAuth-SSO, or linked to a Microsoft Graph provider,
  // which has no end-user password to bind with -- Graph-sourced accounts
  // still sign in through the existing OAuth SSO redirect) keeps using the
  // local password check exactly as before.
  let passwordOk;
  if (membership.directory_provider_id) {
    const provider = db.prepare("SELECT * FROM directory_providers WHERE id = ? AND type = 'ldap' AND enabled = 1").get(membership.directory_provider_id);
    if (!provider) {
      // Linked to a directory provider that's since been disabled/deleted --
      // refuse rather than silently falling back to comparing against the
      // unusable placeholder hash directory-provisioned accounts are given.
      passwordOk = false;
    } else {
      const config = JSON.parse(decrypt(provider.config) || '{}');
      passwordOk = await verifyBind(config, membership.directory_external_id, password);
    }
  } else {
    passwordOk = bcrypt.compareSync(password, user.password_hash);
  }
  if (!passwordOk) return res.status(401).json({ error: 'Invalid email or password' });

  // Password checked out, but this account has an authenticator app
  // enrolled -- hand back a short-lived challenge instead of a real session.
  // The full identity/workspace/permissions bundle below is only ever built
  // AFTER POST /mfa/verify confirms the second factor too (see that route),
  // so nothing workspace-scoped is ever computed or returned for a
  // password-only login on an MFA-protected account.
  if (user.totp_enabled) {
    return res.json({ mfaRequired: true, challenge: signMfaChallenge(user.id) });
  }

  const identity = resolveIdentity(user, membership);

  db.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(membership.workspace_id, user.id);
  logAudit({ user: identity, workspaceId: membership.workspace_id, ip: req.ip }, { action: 'auth.login', entityType: 'user', entityId: user.id, entityLabel: user.email });

  res.json({
    token: sign(identity),
    user: identity,
    workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.workspace_name, role: m.role })),
  });
});

// Completes an MFA-protected login: exchanges the short-lived challenge
// from POST /login for a real session, once the caller proves they also
// hold the second factor. Deliberately public (no requireAuth) -- the
// challenge token itself, verified below, is what stands in for a session
// here, the same way a password stands in for one at POST /login. Shares
// that route's rate limiter since this is exactly as brute-forceable as a
// password field.
router.post('/mfa/verify', authLimiter, (req, res) => {
  const { challenge, token } = req.body;
  if (!challenge || !token) return res.status(400).json({ error: 'challenge and token required' });

  let userId;
  try {
    userId = verifyMfaChallenge(challenge);
  } catch {
    return res.status(401).json({ error: 'This login attempt expired — please sign in again.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user || !user.totp_enabled) return res.status(401).json({ error: 'This login attempt expired — please sign in again.' });

  const candidate = String(token).trim();
  // A recovery code (XXXXX-XXXXX) is checked as a one-time fallback whenever
  // the 6-digit shape doesn't match, rather than only on a separate "use a
  // recovery code" mode -- one field handles both, same way a login form
  // doesn't ask in advance whether you'll type a password or paste one from
  // a manager.
  let ok = verifyTOTP(decrypt(user.totp_secret), candidate);
  if (!ok && /^[0-9a-f]{5}-[0-9a-f]{5}$/i.test(candidate)) {
    const codeHash = hashRecoveryCode(candidate);
    const recovery = db.prepare('SELECT id FROM mfa_recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL').get(user.id, codeHash);
    if (recovery) {
      db.prepare("UPDATE mfa_recovery_codes SET used_at = datetime('now') WHERE id = ?").run(recovery.id);
      ok = true;
    }
  }
  if (!ok) return res.status(401).json({ error: 'Invalid code. Check your authenticator app, or use one of your recovery codes.' });

  const memberships = membershipsForUser(user.id);
  if (memberships.length === 0) return res.status(403).json({ error: 'This account has no active workspace membership.' });
  const membership = memberships.find((m) => m.workspace_id === user.last_workspace_id) || memberships[0];
  const identity = resolveIdentity(user, membership);

  db.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(membership.workspace_id, user.id);
  logAudit({ user: identity, workspaceId: membership.workspace_id, ip: req.ip }, { action: 'auth.login', entityType: 'user', entityId: user.id, entityLabel: user.email, details: { mfa: true } });

  res.json({
    token: sign(identity),
    user: identity,
    workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.workspace_name, role: m.role })),
  });
});

// Begins enrollment: mints a brand-new secret and returns it as both a
// scannable QR (otpauth:// URI rendered to a PNG data URL via the `qrcode`
// package) and a plain string for manual entry. Deliberately does NOT flip
// totp_enabled -- that only happens once POST /mfa/enable proves the user
// actually captured a working code from it, so an abandoned setup attempt
// never silently starts being required at login.
router.post('/mfa/setup', requireAuth, requireWorkspace, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.totp_enabled) return res.status(400).json({ error: 'MFA is already enabled on this account. Disable it before setting up a new authenticator.' });

  const secret = generateSecret();
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(encrypt(secret), user.id);
  const url = otpauthUrl(secret, user.email);
  const qrCode = await QRCode.toDataURL(url);
  res.json({ secret, otpauthUrl: url, qrCode });
});

// Confirms enrollment with a real code from the authenticator app, turns
// MFA on, and issues the one-time set of recovery codes -- shown to the
// caller exactly once in this response, never retrievable again (only their
// hashes are persisted; see services/totp.js).
router.post('/mfa/enable', requireAuth, requireWorkspace, (req, res) => {
  const { token } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (user.totp_enabled) return res.status(400).json({ error: 'MFA is already enabled on this account.' });
  if (!user.totp_secret) return res.status(400).json({ error: 'Start setup first (POST /mfa/setup) before confirming a code.' });
  if (!verifyTOTP(decrypt(user.totp_secret), token)) {
    return res.status(400).json({ error: 'Invalid code — check your authenticator app and try again.' });
  }

  db.prepare("UPDATE users SET totp_enabled = 1, totp_enrolled_at = datetime('now') WHERE id = ?").run(user.id);
  db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(user.id);
  const codes = generateRecoveryCodes();
  for (const code of codes) {
    db.prepare('INSERT INTO mfa_recovery_codes (id, user_id, code_hash) VALUES (?,?,?)').run(uid('mrc'), user.id, hashRecoveryCode(code));
  }
  logAudit(req, { action: 'user.mfa_enabled', entityType: 'user', entityId: user.id, entityLabel: user.email });
  res.json({ recoveryCodes: codes });
});

// Requires the current password (not a TOTP code) -- consistent with how
// most apps gate turning 2FA off, since the whole point is that losing the
// authenticator shouldn't have to mean losing the account, but turning
// protection off should still cost something an attacker who only stole a
// session token wouldn't have. Mirrors POST /login's own password-vs-LDAP-
// bind branch (see the comment there) -- a directory-linked user has only a
// random unusable local password_hash, so re-confirming them the same way
// login does is what makes this route reachable for them at all.
router.post('/mfa/disable', requireAuth, requireWorkspace, async (req, res) => {
  const { password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user.totp_enabled) return res.status(400).json({ error: 'MFA is not enabled on this account.' });

  const membership = db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, req.user.id);
  let passwordOk = false;
  if (membership?.directory_provider_id) {
    const provider = db.prepare("SELECT * FROM directory_providers WHERE id = ? AND type = 'ldap' AND enabled = 1").get(membership.directory_provider_id);
    if (provider) {
      const config = JSON.parse(decrypt(provider.config) || '{}');
      passwordOk = !!password && await verifyBind(config, membership.directory_external_id, password);
    }
  } else {
    passwordOk = !!password && bcrypt.compareSync(password, user.password_hash);
  }
  if (!passwordOk) return res.status(401).json({ error: 'Incorrect password.' });

  db.prepare("UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_enrolled_at = NULL WHERE id = ?").run(user.id);
  db.prepare('DELETE FROM mfa_recovery_codes WHERE user_id = ?').run(user.id);
  logAudit(req, { action: 'user.mfa_disabled', entityType: 'user', entityId: user.id, entityLabel: user.email });
  res.json({ ok: true });
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

// Admin/impersonator: mint a session as another active member of this
// workspace -- audited immediately (not just on the eventual "end" call),
// and every subsequent request in that session carries impersonated_by so
// it's traceable from the token alone (see authTokens.js's sign()). This is
// this app's practical "view as this role/user" tool -- deliberately
// standing in for a separate access-control-preview UI (see PERMISSIONS'
// comment in services/permissions.js).
router.post('/impersonate/:userId', requireAuth, requireWorkspace, requirePermission('users.impersonate'), (req, res) => {
  if (req.user.impersonated_by) return res.status(400).json({ error: 'Already impersonating — end this session before starting another.' });
  if (req.params.userId === req.user.id) return res.status(400).json({ error: "You're already signed in as this user." });
  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  const membership = db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND active = 1').get(req.workspaceId, req.params.userId);
  if (!membership) return res.status(404).json({ error: 'That user is not an active member of this workspace' });
  const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(req.workspaceId);
  const identity = resolveIdentity(targetUser, { ...membership, workspace_name: workspace?.name });
  identity.impersonated_by = { id: req.user.id, name: req.user.name };
  logAudit(req, { action: 'user.impersonated', entityType: 'user', entityId: targetUser.id, entityLabel: targetUser.email });
  res.json({ token: sign(identity), user: identity });
});

// Restores the original admin/impersonator's own session. Only ever acts on
// the CALLER's own impersonated_by claim (never a userId param) -- there is
// nothing to authorize beyond "this token says who to go back to."
router.post('/end-impersonation', requireAuth, (req, res) => {
  if (!req.user.impersonated_by) return res.status(400).json({ error: 'Not currently impersonating anyone.' });
  const original = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.impersonated_by.id);
  if (!original) return res.status(404).json({ error: 'The original account no longer exists.' });
  const memberships = membershipsForUser(original.id);
  const membership = memberships.find((m) => m.workspace_id === req.user.workspace_id) || memberships[0];
  if (!membership) return res.status(403).json({ error: 'The original account no longer has access to this workspace.' });
  const identity = resolveIdentity(original, membership);
  res.json({
    token: sign(identity),
    user: identity,
    workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.workspace_name, role: m.role })),
  });
});

router.get('/me', requireAuth, requireWorkspace, (req, res) => {
  const memberships = membershipsForUser(req.user.id);
  // The JWT only carries what was true at login time (name/email/role/team) --
  // enrich with columns that change more often, or never made it into the
  // token at all (avatar, join date, employee id, manager), read fresh from
  // the DB so the profile view is never stale for the life of a 7-day token.
  const profile = db.prepare(
    `SELECT u.avatar_color, u.created_at, u.language, u.location, u.timezone, u.totp_enabled, wm.role, wm.team, wm.employee_id, wm.manager_id, mu.name AS manager_name, cr.name AS custom_role_name
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     LEFT JOIN users mu ON mu.id = wm.manager_id
     LEFT JOIN custom_roles cr ON cr.id = wm.custom_role_id
     WHERE wm.user_id = ? AND wm.workspace_id = ?`
  ).get(req.user.id, req.workspaceId);
  res.json({
    user: { ...req.user, ...profile },
    workspaces: memberships.map((m) => ({ id: m.workspace_id, name: m.workspace_name, role: m.role })),
  });
});

// Self-service profile edit -- anyone can update their own contact/
// preference fields. Deliberately does NOT accept role, team, employee_id
// or manager_id: those describe standing within a workspace and stay
// admin-controlled via PATCH /users/:id (Admin Settings -> Users) so a
// caller can never grant themselves a role by editing their own profile.
router.patch('/me', requireAuth, requireWorkspace, (req, res) => {
  const { name, email, language, location, timezone } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) {
    if (!name.trim()) return res.status(400).json({ error: 'Name cannot be empty' });
    fields.push('name = ?'); params.push(name.trim());
  }
  if (email !== undefined) {
    if (!email.trim()) return res.status(400).json({ error: 'Email cannot be empty' });
    const existing = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.trim(), req.user.id);
    if (existing) return res.status(409).json({ error: 'That email address is already in use' });
    fields.push('email = ?'); params.push(email.trim());
  }
  if (language !== undefined) { fields.push('language = ?'); params.push(language || null); }
  if (location !== undefined) { fields.push('location = ?'); params.push(location || null); }
  if (timezone !== undefined) { fields.push('timezone = ?'); params.push(timezone || null); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.user.id);
  db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  // name/email are baked into the JWT -- re-issue so the header/session
  // reflect the change immediately instead of waiting out the old 7-day token.
  const token = sign({ ...req.user, name: updated.name, email: updated.email });
  res.json({ token, user: { ...req.user, ...updated } });
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
    `SELECT u.id, u.name, u.email, wm.role, wm.team, u.avatar_color, wm.active, u.created_at, wm.employee_id, wm.manager_id, mu.name AS manager_name, wm.custom_role_id, cr.name AS custom_role_name, dp.name AS directory_provider_name, u.is_super_admin
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     LEFT JOIN users mu ON mu.id = wm.manager_id
     LEFT JOIN custom_roles cr ON cr.id = wm.custom_role_id
     LEFT JOIN directory_providers dp ON dp.id = wm.directory_provider_id
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
  logAudit(req, { action: 'user.created', entityType: 'user', entityId: user.id, entityLabel: email, details: { role, team } });
  res.status(201).json({ id: user.id });
});

// Admin: apply role/team/active to many members at once (Admin Settings →
// Users' bulk action bar) -- same shape as POST /tickets/bulk-update:
// partial success is fine, each row reports its own outcome rather than
// the whole batch failing for one bad id. Deliberately excludes
// custom_role_id/employee_id/manager_id (reviewed one-at-a-time in the
// user drawer) and is_super_admin (its own dedicated, more tightly guarded
// route in routes/admin.js) -- this endpoint only ever touches the same
// three fields the per-row Role/Status controls already expose.
router.post('/users/bulk-update', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const { user_ids, updates } = req.body;
  if (!Array.isArray(user_ids) || !user_ids.length) return res.status(400).json({ error: 'user_ids required' });
  const allowed = ['role', 'team', 'active'];
  const keys = Object.keys(updates || {}).filter((k) => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'No valid fields to update (role, team, active only)' });

  const succeeded = [];
  const failed = [];
  for (const id of user_ids) {
    const membership = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, id);
    if (!membership) { failed.push({ id, error: 'Not found in this workspace' }); continue; }
    const fields = []; const params = [];
    if (keys.includes('role')) { fields.push('role = ?'); params.push(updates.role); }
    if (keys.includes('team')) { fields.push('team = ?'); params.push(updates.team || null); }
    if (keys.includes('active')) { fields.push('active = ?'); params.push(updates.active ? 1 : 0); }
    params.push(membership.id);
    db.prepare(`UPDATE workspace_members SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    succeeded.push(id);
  }
  logAudit(req, { action: 'user.bulk_updated', entityType: 'user', details: { count: succeeded.length, failed: failed.length, updates } });
  res.json({ succeeded, failed });
});

// Admin: change a member's role/team within the current workspace, or
// deactivate their membership (blocks access to just this workspace, not
// any other workspace they may separately belong to).
router.patch('/users/:id', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const membership = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, req.params.id);
  if (!membership) return res.status(404).json({ error: 'Not found in this workspace' });
  const { role, team, active, employee_id, manager_id, custom_role_id } = req.body;
  const fields = []; const params = [];
  if (role !== undefined) { fields.push('role = ?'); params.push(role); }
  if (team !== undefined) { fields.push('team = ?'); params.push(team); }
  if (active !== undefined) { fields.push('active = ?'); params.push(active ? 1 : 0); }
  if (employee_id !== undefined) { fields.push('employee_id = ?'); params.push(employee_id || null); }
  if (manager_id !== undefined) { fields.push('manager_id = ?'); params.push(manager_id || null); }
  if (custom_role_id !== undefined) {
    if (custom_role_id) {
      const cr = db.prepare('SELECT id FROM custom_roles WHERE id = ? AND workspace_id = ?').get(custom_role_id, req.workspaceId);
      if (!cr) return res.status(400).json({ error: 'Custom role not found in this workspace' });
    }
    fields.push('custom_role_id = ?'); params.push(custom_role_id || null);
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(membership.id);
  db.prepare(`UPDATE workspace_members SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  const targetEmail = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.id)?.email;
  logAudit(req, { action: 'user.updated', entityType: 'user', entityId: req.params.id, entityLabel: targetEmail, details: req.body });
  res.json({ ok: true });
});

// Admin: remove a member from the current workspace entirely (not just
// deactivate). Only revokes access to this workspace — any other workspace
// membership they hold, and their global account, are untouched.
router.delete('/users/:id', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "You can't remove yourself from this workspace" });
  const membership = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, req.params.id);
  if (!membership) return res.status(404).json({ error: 'Not found in this workspace' });
  const target = db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM workspace_members WHERE id = ?').run(membership.id);
  db.prepare('DELETE FROM group_members WHERE user_id = ? AND group_id IN (SELECT id FROM groups WHERE workspace_id = ?)').run(req.params.id, req.workspaceId);
  logAudit(req, { action: 'user.removed', entityType: 'user', entityId: req.params.id, entityLabel: target?.email });
  res.json({ ok: true });
});

export default router;
