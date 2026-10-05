import fetch from 'node-fetch';
import nodemailer from 'nodemailer';
import { db } from '../db.js';
import { decrypt } from './crypto.js';

// Generic outbound notifier. Slack/Teams/webhook deliver via a configured
// webhook URL. Email delivers for real via nodemailer/SMTP once host/user/pass
// are configured on the integration; Jira remains simulated (no API wired up).
export async function sendIntegrationMessage(integration, payload) {
  const config = JSON.parse(decrypt(integration.config) || '{}');
  try {
    if (['slack', 'teams', 'webhook', 'github'].includes(integration.type)) {
      if (!config.webhook_url) throw new Error('Missing webhook_url in integration config');
      const resp = await fetch(config.webhook_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          integration.type === 'slack' || integration.type === 'teams'
            ? { text: payload.text }
            : payload
        ),
      });
      if (!resp.ok) throw new Error(`Webhook responded ${resp.status}`);
      return { ok: true };
    }
    if (integration.type === 'email_smtp') {
      const to = payload.to || config.to_default;
      if (!config.host || !config.user || !to) {
        // Not fully configured yet — fall back to a simulated send so the
        // rest of the flow (notifications, automations) doesn't break.
        console.log(`[email_smtp:${integration.name}] SMTP not fully configured — simulated. To: ${to || '(none)'} — ${payload.text}`);
        return { ok: true, simulated: true };
      }
      const transporter = nodemailer.createTransport({
        host: config.host,
        port: Number(config.port) || 587,
        secure: !!config.secure,
        auth: config.user ? { user: config.user, pass: config.pass } : undefined,
      });
      await transporter.sendMail({
        from: config.from || config.user,
        to,
        subject: payload.subject || 'ITSM AI Notification',
        text: payload.text,
      });
      return { ok: true };
    }
    if (integration.type === 'jira') {
      console.log(`[jira:${integration.name}] Would create/update Jira issue — ${payload.text}`);
      return { ok: true, simulated: true };
    }
    return { ok: false, error: 'Unsupported integration type' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function getEnabledIntegrations(workspaceId, type) {
  const rows = db.prepare(
    'SELECT * FROM integrations WHERE workspace_id = ? AND enabled = 1' + (type ? ' AND type = ?' : '')
  ).all(...(type ? [workspaceId, type] : [workspaceId]));
  return rows;
}
