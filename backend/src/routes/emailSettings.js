import { Router } from 'express';
import crypto from 'node:crypto';
import { db } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import {
  settingsForApi, upsertEmailSettings, testEmailConfig,
  connectMicrosoftMailbox, disconnectMicrosoftMailbox, setInboundSettings, getEmailSettings,
} from '../services/emailService.js';
import { MAILBOX_SCOPE, exchangeMailboxCode, fetchMailboxProfile } from '../services/graphMailer.js';
import { processInbox } from '../services/inboundEmail.js';

const router = Router();

// CSRF state for the in-flight mailbox-connect OAuth handshake -- same
// short-lived, in-memory, timer-swept Map as routes/sso.js's own
// pendingStates (a separate instance: this flow requests a different scope
// for a different purpose and must never be confused with a login attempt).
const pendingStates = new Map(); // state -> { workspaceId, userId, createdAt }
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [state, v] of pendingStates) if (v.createdAt < cutoff) pendingStates.delete(state);
}, 60 * 1000).unref();

function callbackUrl(req) {
  const base = process.env.SSO_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base}/api/email-settings/microsoft/callback`;
}

function adminSettingsUrl() {
  const base = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0].trim();
  return `${base}/admin-settings?section=emailConfig`;
}

// ---- Public: only the callback leg, hit by Microsoft's redirect with none
// of our own session attached -- exactly like routes/sso.js's own callback,
// which workspace/admin this belongs to is recovered from `state`. ----
router.get('/microsoft/callback', async (req, res) => {
  const fail = (msg) => res.redirect(`${adminSettingsUrl()}&mailboxError=${encodeURIComponent(msg)}`);
  const { code, state, error, error_description: errorDesc } = req.query;
  if (error) return fail(String(errorDesc || error));
  if (!code || !state) return fail('Connection was cancelled or the request was incomplete.');
  const pending = pendingStates.get(String(state));
  if (!pending) return fail('This connection attempt expired or was already used — please try again.');
  pendingStates.delete(String(state));

  try {
    const tokens = await exchangeMailboxCode(pending.workspaceId, code, callbackUrl(req));
    const profile = await fetchMailboxProfile(tokens.access_token);
    connectMicrosoftMailbox(pending.workspaceId, {
      email: profile.email, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_in, connectedBy: pending.userId,
    });
    const actor = db.prepare('SELECT u.name, wm.role FROM users u JOIN workspace_members wm ON wm.user_id = u.id WHERE u.id = ? AND wm.workspace_id = ?').get(pending.userId, pending.workspaceId);
    logAudit({ user: { id: pending.userId, name: actor?.name, role: actor?.role }, workspaceId: pending.workspaceId, ip: req.ip }, {
      action: 'email_settings.mailbox_connected', entityType: 'email_settings', entityLabel: profile.email,
    });
    res.redirect(`${adminSettingsUrl()}&mailboxConnected=${encodeURIComponent(profile.email)}`);
  } catch (e) {
    fail(e.message);
  }
});

router.use(requireAuth, requireWorkspace, requirePermission('notifications.manage'));

router.get('/', (req, res) => {
  res.json({ settings: settingsForApi(req.workspaceId) });
});

router.put('/', (req, res) => {
  const { enabled, host, port, secure, username, password, from_name, from_email, reply_to, footer_html } = req.body;
  const current = getEmailSettings(req.workspaceId);
  // A connected Microsoft mailbox needs no SMTP host at all -- this form
  // only ever edits the SMTP side, so the "required" check only applies
  // when SMTP is actually the active provider.
  if (enabled && current?.mailbox_provider !== 'microsoft' && (!host || !from_email)) {
    return res.status(400).json({ error: 'Host and from-address are required to enable outbound email' });
  }
  const settings = upsertEmailSettings(req.workspaceId, { enabled, host, port, secure, username, password, from_name, from_email, reply_to, footer_html });
  logAudit(req, { action: 'email_settings.updated', entityType: 'email_settings', details: { enabled: !!enabled, host } });
  res.json({ settings });
});

router.post('/test', async (req, res) => {
  const { to, ...draft } = req.body;
  if (!to) return res.status(400).json({ error: 'to address required' });
  const result = await testEmailConfig(req.workspaceId, draft, to);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Kicks off the mailbox-connect OAuth handshake -- returns the authorize URL
// as JSON (rather than a server-side redirect) because this route itself
// still needs the caller's Bearer token to know which workspace/admin is
// connecting, and a real browser navigation to a provider's consent screen
// never carries an Authorization header. The frontend does the actual
// `window.location.href = url` navigation once it has this.
router.post('/microsoft/start', (req, res) => {
  const sso = db.prepare("SELECT * FROM sso_providers WHERE workspace_id = ? AND provider = 'microsoft' AND enabled = 1").get(req.workspaceId);
  if (!sso) return res.status(400).json({ error: 'Set up Microsoft Single Sign-On first (Admin Settings → Single Sign-On) — mailbox connect reuses that app registration.' });

  const state = crypto.randomBytes(24).toString('hex');
  pendingStates.set(state, { workspaceId: req.workspaceId, userId: req.user.id, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: sso.client_id,
    redirect_uri: callbackUrl(req),
    response_type: 'code',
    response_mode: 'query',
    scope: MAILBOX_SCOPE,
    state,
    // Forces the consent screen even if this account already consented to
    // User.Read for login -- otherwise Microsoft can silently skip it and
    // the new Mail.Send/Mail.ReadWrite scopes are never actually granted.
    prompt: 'consent',
  });
  res.json({ url: `https://login.microsoftonline.com/${sso.tenant_id || 'common'}/oauth2/v2.0/authorize?${params}` });
});

router.post('/microsoft/disconnect', (req, res) => {
  const settings = disconnectMicrosoftMailbox(req.workspaceId);
  logAudit(req, { action: 'email_settings.mailbox_disconnected', entityType: 'email_settings' });
  res.json({ settings });
});

router.patch('/inbound', (req, res) => {
  try {
    const settings = setInboundSettings(req.workspaceId, req.body);
    logAudit(req, { action: 'email_settings.inbound_updated', entityType: 'email_settings', details: { inbound_enabled: !!req.body.inbound_enabled } });
    res.json({ settings });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Same "manual button alongside the automatic schedule" pattern Directory
// Sync already offers -- lets an admin see it work right after turning it
// on instead of waiting up to two minutes for the next scheduled tick.
router.post('/inbound/check-now', async (req, res) => {
  try {
    const result = await processInbox(req.workspaceId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/inbound/log', (req, res) => {
  const rows = db.prepare('SELECT * FROM email_inbound_log WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50').all(req.workspaceId);
  res.json({ logs: rows });
});

export default router;
