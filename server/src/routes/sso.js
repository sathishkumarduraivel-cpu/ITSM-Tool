import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/crypto.js';
import { PROVIDERS, exchangeCode } from '../services/sso.js';
import { sign, resolveIdentity } from '../services/authTokens.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();

// CSRF state for the in-flight OAuth handshake -- short-lived, in-memory,
// swept on a timer. No scheduler needed for this (it's an interval, not a
// cron job the rest of this app deliberately avoids) since it just has to
// outlive one browser round-trip through the provider's consent screen.
const pendingStates = new Map(); // state -> { ssoId, createdAt }
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, v] of pendingStates) if (v.createdAt < cutoff) pendingStates.delete(state);
}, 60 * 1000).unref();

// Deliberately keyed by PROVIDER only, never by the sso_providers row id --
// an admin has to paste this exact URL into Google Cloud Console / Microsoft
// Entra *before* they have a client_id/secret to save here at all, so it
// can't depend on a database id that doesn't exist yet. One Google app
// registration's redirect URI works for every workspace on this deployment
// that configures Google SSO; which specific row initiated a given flow is
// recovered from `state` in the callback below, not from the URL.
function callbackUrl(req, provider) {
  const base = process.env.SSO_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/auth/sso/callback/${provider}`;
}

function frontendUrl() {
  return (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0].trim();
}

// ---- Public: pre-login discovery + the OAuth redirect dance itself. None
// of this can require requireAuth -- it IS how someone becomes authenticated. ----

// Which providers to show as "Continue with..." buttons on the login
// screen. Deliberately returns nothing but an id/label -- never client_id,
// workspace name, or anything else a pre-login caller shouldn't see.
router.get('/providers', (req, res) => {
  const rows = db.prepare('SELECT id, provider FROM sso_providers WHERE enabled = 1').all();
  res.json({ providers: rows.map((r) => ({ id: r.id, provider: r.provider, label: PROVIDERS[r.provider]?.label || r.provider })) });
});

router.get('/:id/start', (req, res) => {
  const sso = db.prepare('SELECT * FROM sso_providers WHERE id = ? AND enabled = 1').get(req.params.id);
  if (!sso) return res.status(404).send('This sign-in option is not available.');
  const meta = PROVIDERS[sso.provider];
  if (!meta) return res.status(400).send('Unknown provider.');

  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, { ssoId: sso.id, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: sso.client_id,
    redirect_uri: callbackUrl(req, sso.provider),
    response_type: 'code',
    scope: meta.scope,
    state,
    ...meta.extraAuthParams(),
  });
  res.redirect(`${meta.authUrl(sso)}?${params.toString()}`);
});

router.get('/callback/:provider', async (req, res) => {
  const fail = (msg) => res.redirect(`${frontendUrl()}/sso-callback?error=${encodeURIComponent(msg)}`);

  const { code, state, error: providerError, error_description: providerErrorDesc } = req.query;
  if (providerError) return fail(String(providerErrorDesc || providerError));
  if (!code || !state) return fail('Sign-in was cancelled or the request was incomplete.');
  const pending = pendingStates.get(String(state));
  if (!pending) return fail('This sign-in attempt expired or was already used -- please try again.');
  pendingStates.delete(String(state));

  const sso = db.prepare('SELECT * FROM sso_providers WHERE id = ? AND enabled = 1').get(pending.ssoId);
  if (!sso || sso.provider !== req.params.provider) return fail('This sign-in option is no longer available.');
  const meta = PROVIDERS[sso.provider];

  try {
    const accessToken = await exchangeCode({ ...sso, client_secret: decrypt(sso.client_secret) }, code, callbackUrl(req, sso.provider));
    const profile = await meta.fetchProfile(accessToken);

    const domain = profile.email.split('@')[1]?.toLowerCase();
    if (sso.allowed_domain && domain !== sso.allowed_domain.toLowerCase()) {
      throw new Error(`Only @${sso.allowed_domain} accounts may sign in this way.`);
    }

    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.email);
    let isNewUser = false;
    if (!user) {
      const id = uid('usr');
      // SSO-provisioned accounts never get a usable password -- this random
      // value is never shown or sent anywhere, it exists only to satisfy
      // users.password_hash's NOT NULL constraint and make password login
      // for this account computationally infeasible.
      const unusablePassword = crypto.randomBytes(32).toString('hex');
      const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
      const avatar_color = colors[Math.floor(Math.random() * colors.length)];
      db.prepare('INSERT INTO users (id, name, email, password_hash, avatar_color, last_workspace_id) VALUES (?,?,?,?,?,?)')
        .run(id, profile.name, profile.email, bcrypt.hashSync(unusablePassword, 10), avatar_color, sso.workspace_id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      isNewUser = true;
    }

    let membership = db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(sso.workspace_id, user.id);
    if (!membership) {
      db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?,?,?,?)')
        .run(uid('wm'), sso.workspace_id, user.id, sso.auto_provision_role);
      membership = db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(sso.workspace_id, user.id);
    }
    if (!membership.active) throw new Error('Your access to this workspace has been deactivated. Contact your admin.');

    const workspace = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(sso.workspace_id);
    const identity = resolveIdentity(user, { ...membership, workspace_name: workspace?.name });
    db.prepare('UPDATE users SET last_workspace_id = ? WHERE id = ?').run(sso.workspace_id, user.id);

    if (isNewUser) {
      logAudit({ user: identity, workspaceId: sso.workspace_id, ip: req.ip }, {
        action: 'user.created', entityType: 'user', entityId: user.id, entityLabel: user.email,
        details: { via: `sso:${sso.provider}`, role: sso.auto_provision_role },
      });
    }
    logAudit({ user: identity, workspaceId: sso.workspace_id, ip: req.ip }, {
      action: 'auth.login', entityType: 'user', entityId: user.id, entityLabel: user.email, details: { via: `sso:${sso.provider}` },
    });

    res.redirect(`${frontendUrl()}/sso-callback?token=${encodeURIComponent(sign(identity))}`);
  } catch (e) {
    fail(e.message);
  }
});

// ---- Admin: configure SSO providers for this workspace. Never delegable --
// unlike the custom-roles permission catalog, standing up a way for
// strangers to authenticate into the workspace is exactly the kind of
// privilege-granting action that stays hard admin-only (same reasoning as
// user management and AI provider credentials). ----
router.use(requireAuth, requireWorkspace, requireRole('admin'));

function redact(row) {
  return { ...row, client_secret: undefined, has_client_secret: !!row.client_secret };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM sso_providers WHERE workspace_id = ? ORDER BY provider').all(req.workspaceId);
  res.json({ providers: rows.map(redact), meta: Object.entries(PROVIDERS).map(([key, p]) => ({ key, label: p.label })) });
});

router.post('/', (req, res) => {
  const { provider, client_id, client_secret, tenant_id, allowed_domain, auto_provision_role = 'requester', enabled = true } = req.body;
  if (!PROVIDERS[provider]) return res.status(400).json({ error: `provider must be one of: ${Object.keys(PROVIDERS).join(', ')}` });
  if (!client_id || !client_secret) return res.status(400).json({ error: 'client_id and client_secret required' });
  if (!['requester', 'agent'].includes(auto_provision_role)) return res.status(400).json({ error: 'auto_provision_role must be requester or agent' });
  const existing = db.prepare('SELECT id FROM sso_providers WHERE workspace_id = ? AND provider = ?').get(req.workspaceId, provider);
  if (existing) return res.status(409).json({ error: `${PROVIDERS[provider].label} is already configured for this workspace -- edit it instead.` });

  const id = uid('sso');
  db.prepare(
    `INSERT INTO sso_providers (id, workspace_id, provider, client_id, client_secret, tenant_id, allowed_domain, auto_provision_role, enabled)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, provider, client_id, encrypt(client_secret), tenant_id || null, allowed_domain || null, auto_provision_role, enabled ? 1 : 0);
  logAudit(req, { action: 'sso_provider.created', entityType: 'sso_provider', entityId: id, entityLabel: PROVIDERS[provider].label, details: { allowed_domain, auto_provision_role } });
  res.status(201).json({ provider: redact(db.prepare('SELECT * FROM sso_providers WHERE id = ?').get(id)) });
});

router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sso_providers WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { client_id, client_secret, tenant_id, allowed_domain, auto_provision_role, enabled } = req.body;
  if (auto_provision_role !== undefined && !['requester', 'agent'].includes(auto_provision_role)) {
    return res.status(400).json({ error: 'auto_provision_role must be requester or agent' });
  }
  const fields = []; const params = [];
  if (client_id !== undefined) { fields.push('client_id = ?'); params.push(client_id); }
  if (client_secret) { fields.push('client_secret = ?'); params.push(encrypt(client_secret)); } // blank = keep existing, same pattern as integrations.js
  if (tenant_id !== undefined) { fields.push('tenant_id = ?'); params.push(tenant_id || null); }
  if (allowed_domain !== undefined) { fields.push('allowed_domain = ?'); params.push(allowed_domain || null); }
  if (auto_provision_role !== undefined) { fields.push('auto_provision_role = ?'); params.push(auto_provision_role); }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(row.id);
  db.prepare(`UPDATE sso_providers SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'sso_provider.updated', entityType: 'sso_provider', entityId: row.id, entityLabel: PROVIDERS[row.provider]?.label, details: { allowed_domain, auto_provision_role, enabled } });
  res.json({ provider: redact(db.prepare('SELECT * FROM sso_providers WHERE id = ?').get(row.id)) });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sso_providers WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM sso_providers WHERE id = ?').run(row.id);
  logAudit(req, { action: 'sso_provider.deleted', entityType: 'sso_provider', entityId: row.id, entityLabel: PROVIDERS[row.provider]?.label });
  res.json({ ok: true });
});

export default router;
