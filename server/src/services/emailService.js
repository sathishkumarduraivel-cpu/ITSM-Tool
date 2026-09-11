// The single authoritative transactional-email sender for this app --
// supersedes the older ad-hoc email_smtp integration path
// (services/notify.js's sendIntegrationMessage) for every ticket-lifecycle
// email, so there is exactly one place admins configure "how we send mail"
// and one place they edit "what the mail says" (Admin Settings → Email
// Configuration). The old integrations.email_smtp type still exists for
// generic outbound webhooks and isn't removed, but no route in this app
// wires a ticket-lifecycle event through it anymore.
import nodemailer from 'nodemailer';
import { db, uid } from '../db.js';
import { encrypt, decrypt } from './crypto.js';
import { DEFAULT_EMAIL_TEMPLATES, SAMPLE_VARS } from './emailTemplateCatalog.js';

// For emails composed inside a service module rather than a route handler
// (approvalEngine.js, escalationEngine.js, directorySync.js), there's no
// `req` to read protocol/host from the way routes do (see routes/sso.js's
// identical SSO_BASE_URL fallback pattern) -- APP_URL covers a real
// deployment; the dev-server default matches this repo's Vite port.
export function absoluteUrl(path) {
  return `${process.env.APP_URL || 'http://localhost:5175'}${path}`;
}

export function getEmailSettings(workspaceId) {
  return db.prepare('SELECT * FROM email_settings WHERE workspace_id = ?').get(workspaceId) || null;
}

// Redacts the encrypted password for anything that leaves the server --
// the admin UI only ever needs to know a password IS set, never its value,
// same convention as the SSO/directory-provider config redaction.
export function settingsForApi(workspaceId) {
  const row = getEmailSettings(workspaceId);
  if (!row) return { workspace_id: workspaceId, enabled: 0, port: 587, secure: 0, hasPassword: false };
  const { password, ...rest } = row;
  return { ...rest, hasPassword: !!password };
}

export function upsertEmailSettings(workspaceId, body) {
  const existing = getEmailSettings(workspaceId);
  const fields = {
    enabled: body.enabled ? 1 : 0,
    host: body.host ?? existing?.host ?? null,
    port: Number(body.port) || existing?.port || 587,
    secure: body.secure ? 1 : 0,
    username: body.username ?? existing?.username ?? null,
    // An empty/omitted password means "leave whatever's already saved" --
    // never overwrite a real secret with a blank because the admin only
    // touched an unrelated field on the same form.
    password: body.password ? encrypt(body.password) : existing?.password ?? null,
    from_name: body.from_name ?? existing?.from_name ?? null,
    from_email: body.from_email ?? existing?.from_email ?? null,
    reply_to: body.reply_to ?? existing?.reply_to ?? null,
    footer_html: body.footer_html ?? existing?.footer_html ?? null,
  };
  if (existing) {
    db.prepare(
      `UPDATE email_settings SET enabled=?, host=?, port=?, secure=?, username=?, password=?, from_name=?, from_email=?, reply_to=?, footer_html=?, updated_at=datetime('now') WHERE workspace_id=?`
    ).run(fields.enabled, fields.host, fields.port, fields.secure, fields.username, fields.password, fields.from_name, fields.from_email, fields.reply_to, fields.footer_html, workspaceId);
  } else {
    db.prepare(
      `INSERT INTO email_settings (id, workspace_id, enabled, host, port, secure, username, password, from_name, from_email, reply_to, footer_html) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(uid('ems'), workspaceId, fields.enabled, fields.host, fields.port, fields.secure, fields.username, fields.password, fields.from_name, fields.from_email, fields.reply_to, fields.footer_html);
  }
  return settingsForApi(workspaceId);
}

export function ensureDefaultTemplates(workspaceId) {
  const existingKeys = new Set(
    db.prepare('SELECT key FROM email_templates WHERE workspace_id = ?').all(workspaceId).map((r) => r.key)
  );
  for (const t of DEFAULT_EMAIL_TEMPLATES) {
    if (existingKeys.has(t.key)) continue;
    db.prepare(
      'INSERT INTO email_templates (id, workspace_id, key, name, audience, category, subject, body_html, enabled) VALUES (?,?,?,?,?,?,?,?,1)'
    ).run(uid('etpl'), workspaceId, t.key, t.name, t.audience, t.category, t.subject, t.body_html);
  }
}

function fillVars(str, vars) {
  return (str || '').replace(/\{\{([\w.]+)\}\}/g, (_, key) => (vars[key] ?? ''));
}

function wrapBody(workspaceId, innerHtml) {
  const settings = getEmailSettings(workspaceId);
  const footer = settings?.footer_html
    ? `<div style="margin-top:20px;padding-top:14px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;">${settings.footer_html}</div>`
    : '';
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1e293b;max-width:560px;">${innerHtml}${footer}</div>`;
}

function logEmail(workspaceId, { templateKey, to, subject, status, error }) {
  db.prepare(
    'INSERT INTO email_log (id, workspace_id, template_key, to_email, subject, status, error) VALUES (?,?,?,?,?,?,?)'
  ).run(uid('eml'), workspaceId, templateKey || null, to, subject || null, status, error || null);
}

async function deliver(settings, { to, subject, html, text }) {
  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: Number(settings.port) || 587,
    secure: !!settings.secure,
    auth: settings.username ? { user: settings.username, pass: decrypt(settings.password) } : undefined,
  });
  const fromAddress = settings.from_email || settings.username;
  await transporter.sendMail({
    from: fromAddress ? (settings.from_name ? `"${settings.from_name}" <${fromAddress}>` : fromAddress) : undefined,
    replyTo: settings.reply_to || undefined,
    to, subject, html, text: text || html?.replace(/<[^>]+>/g, ' '),
  });
}

// Sends real mail via nodemailer/SMTP once host/from are configured and
// enabled; otherwise logs a simulated send so every call site above can
// fire-and-forget unconditionally without checking "is email set up yet" --
// the exact same simulated-fallback convention services/notify.js already
// established for the older email_smtp integration path.
export async function sendMail(workspaceId, { to, subject, html, text, templateKey }) {
  if (!to) return { ok: false, error: 'No recipient email address' };
  const settings = getEmailSettings(workspaceId);
  if (!settings || !settings.enabled || !settings.host) {
    console.log(`[email:simulated] workspace=${workspaceId} to=${to} subject="${subject}"`);
    logEmail(workspaceId, { templateKey, to, subject, status: 'simulated' });
    return { ok: true, simulated: true };
  }
  try {
    await deliver(settings, { to, subject, html, text });
    logEmail(workspaceId, { templateKey, to, subject, status: 'sent' });
    return { ok: true };
  } catch (e) {
    logEmail(workspaceId, { templateKey, to, subject, status: 'failed', error: e.message });
    return { ok: false, error: e.message };
  }
}

// Used by the "Send test email" button on the SMTP settings form -- sends
// for real using whatever the admin currently has typed into the form
// (merged over the already-saved config, so a blank password field still
// falls back to the saved encrypted one instead of failing auth), even if
// they haven't clicked Save yet or `enabled` is still off. This is the one
// path that deliberately bypasses the `enabled` gate above -- testing a
// connection is exactly how an admin decides whether to flip it on.
export async function testEmailConfig(workspaceId, draft, to) {
  const saved = getEmailSettings(workspaceId);
  const settings = {
    host: draft.host ?? saved?.host,
    port: draft.port ?? saved?.port ?? 587,
    secure: draft.secure ?? saved?.secure,
    username: draft.username ?? saved?.username,
    password: draft.password ? encrypt(draft.password) : saved?.password,
    from_name: draft.from_name ?? saved?.from_name,
    from_email: draft.from_email ?? saved?.from_email,
    reply_to: draft.reply_to ?? saved?.reply_to,
  };
  if (!settings.host) return { ok: false, error: 'Enter an SMTP host first' };
  try {
    await deliver(settings, {
      to, subject: 'ITSM AI — Test email',
      html: '<p>This is a test email from your ITSM AI Email Configuration. If you received this, your SMTP settings are working.</p>',
    });
    logEmail(workspaceId, { templateKey: null, to, subject: 'ITSM AI — Test email', status: 'sent' });
    return { ok: true };
  } catch (e) {
    logEmail(workspaceId, { templateKey: null, to, subject: 'ITSM AI — Test email', status: 'failed', error: e.message });
    return { ok: false, error: e.message };
  }
}

// The main entry point every lifecycle call site uses: looks up the
// workspace's (self-healing, lazily-seeded) template for `key`, fills in
// `vars` (flat dot-path keys, e.g. {'ticket.number': 'INC-42'}), and sends
// it. Silently no-ops (not an error) when the template has been disabled --
// an admin turning a notification off is a deliberate choice, not a fault.
export async function sendTemplatedEmail(workspaceId, key, to, vars = {}) {
  if (!to) return { ok: false, error: 'No recipient email address' };
  ensureDefaultTemplates(workspaceId);
  const tpl = db.prepare('SELECT * FROM email_templates WHERE workspace_id = ? AND key = ?').get(workspaceId, key);
  if (!tpl || !tpl.enabled) return { ok: true, skipped: true };
  const subject = fillVars(tpl.subject, vars);
  const html = wrapBody(workspaceId, fillVars(tpl.body_html, vars));
  return sendMail(workspaceId, { to, subject, html, templateKey: key });
}

export function renderPreview(tpl, vars = SAMPLE_VARS) {
  return { subject: fillVars(tpl.subject, vars), html: wrapBody(tpl.workspace_id, fillVars(tpl.body_html, vars)) };
}

export { fillVars };
