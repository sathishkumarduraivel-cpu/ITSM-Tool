// Sends and reads mail through a real, connected Microsoft 365/Outlook
// mailbox via Microsoft Graph -- the alternative to typing raw SMTP
// credentials into Email Configuration (see routes/emailSettings.js's
// /microsoft/* routes for the OAuth connect flow that populates the tokens
// this module uses). Deliberately separate from services/sso.js: that
// module's Microsoft OAuth is delegated User.Read, used once per login and
// then discarded; this one holds a long-lived refresh token and keeps
// using it, because sending/polling mail happens continuously, not once at
// sign-in.
import fetch from 'node-fetch';
import { db } from '../db.js';
import { encrypt, decrypt } from './crypto.js';

export const MAILBOX_SCOPE = 'openid offline_access Mail.Send Mail.ReadWrite User.Read';

// Overridable so this can be genuinely exercised against a local mock
// standing in for login.microsoftonline.com/graph.microsoft.com in tests
// (no real Entra tenant exists in this environment) -- in every real
// deployment these two env vars are simply unset and it talks to the real
// Microsoft endpoints, same disclosed limitation as services/graphDirectory.js.
const LOGIN_BASE = process.env.GRAPH_LOGIN_BASE || 'https://login.microsoftonline.com';
const API_BASE = process.env.GRAPH_API_BASE || 'https://graph.microsoft.com';

function ssoConfigFor(workspaceId) {
  const sso = db.prepare("SELECT * FROM sso_providers WHERE workspace_id = ? AND provider = 'microsoft'").get(workspaceId);
  if (!sso) throw new Error('Set up Microsoft Single Sign-On first (Admin Settings → Single Sign-On) — mailbox connect reuses that app registration.');
  return { client_id: sso.client_id, client_secret: decrypt(sso.client_secret), tenant_id: sso.tenant_id || 'common' };
}

function tokenUrl(tenantId) {
  return `${LOGIN_BASE}/${tenantId}/oauth2/v2.0/token`;
}

export async function exchangeMailboxCode(workspaceId, code, redirectUri) {
  const cfg = ssoConfigFor(workspaceId);
  const resp = await fetch(tokenUrl(cfg.tenant_id), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id, client_secret: cfg.client_secret, code, redirect_uri: redirectUri, grant_type: 'authorization_code',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error_description || data?.error || 'Could not connect this mailbox.');
  return data; // { access_token, refresh_token, expires_in, ... }
}

async function refresh(workspaceId, refreshToken) {
  const cfg = ssoConfigFor(workspaceId);
  const resp = await fetch(tokenUrl(cfg.tenant_id), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: cfg.client_id, client_secret: cfg.client_secret, refresh_token: refreshToken, grant_type: 'refresh_token',
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error_description || data?.error || 'Reconnect this mailbox — its access has expired or was revoked.');
  return data;
}

// Refreshes ahead of actual expiry (a 2-minute cushion) rather than waiting
// for a 401 mid-request -- Graph access tokens are short-lived (~1 hour) but
// the refresh token is long-lived, so this silently keeps the connection
// alive indefinitely without the admin ever seeing it happen, the same way
// a browser session would.
export async function getValidAccessToken(workspaceId, settings) {
  const expiresAt = settings.graph_token_expires_at ? new Date(settings.graph_token_expires_at).getTime() : 0;
  if (expiresAt - Date.now() > 2 * 60 * 1000) return decrypt(settings.graph_access_token);

  const data = await refresh(workspaceId, decrypt(settings.graph_refresh_token));
  const expires_at = new Date(Date.now() + (data.expires_in || 3600) * 1000).toISOString();
  db.prepare(
    `UPDATE email_settings SET graph_access_token = ?, graph_refresh_token = COALESCE(?, graph_refresh_token), graph_token_expires_at = ? WHERE workspace_id = ?`
  ).run(encrypt(data.access_token), data.refresh_token ? encrypt(data.refresh_token) : null, expires_at, workspaceId);
  return data.access_token;
}

export async function fetchMailboxProfile(accessToken) {
  const resp = await fetch(`${API_BASE}/v1.0/me`, { headers: { authorization: `Bearer ${accessToken}` } });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || 'Could not read this mailbox’s profile.');
  const email = data.mail || data.userPrincipalName;
  if (!email) throw new Error('Microsoft did not return a mailbox address for this account.');
  return { email, name: data.displayName || email };
}

export async function sendMailViaGraph(accessToken, { to, subject, html }) {
  const resp = await fetch(`${API_BASE}/v1.0/me/sendMail`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: { subject, body: { contentType: 'HTML', content: html }, toRecipients: [{ emailAddress: { address: to } }] },
      saveToSentItems: true,
    }),
  });
  if (resp.status !== 202) {
    const data = await resp.json().catch(() => null);
    throw new Error(data?.error?.message || `Microsoft Graph responded ${resp.status}`);
  }
}

// Unread mail only -- the same triage signal a person would use, and what
// gets flipped back to read once a message has been turned into a ticket or
// comment (see services/inboundEmail.js), so nothing is ever processed twice.
export async function listUnreadInbox(accessToken, top = 25) {
  const params = new URLSearchParams({
    '$filter': 'isRead eq false',
    // internetMessageHeaders carries Authentication-Results (SPF/DKIM/DMARC,
    // evaluated by Microsoft's own receiving mail servers, not by this app)
    // -- see services/inboundEmail.js's authenticationVerdict(), which is
    // what stands between "anyone can type any From: address" and this
    // feature trusting that address enough to post as an existing ticket's
    // requester.
    '$select': 'id,subject,from,body,bodyPreview,receivedDateTime,conversationId,internetMessageHeaders',
    '$top': String(top),
    '$orderby': 'receivedDateTime asc',
  });
  const resp = await fetch(`${API_BASE}/v1.0/me/mailFolders/inbox/messages?${params}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data?.error?.message || `Microsoft Graph responded ${resp.status}`);
  return data.value || [];
}

export async function markMessageRead(accessToken, messageId) {
  await fetch(`${API_BASE}/v1.0/me/messages/${encodeURIComponent(messageId)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ isRead: true }),
  });
}
