import fetch from 'node-fetch';
import { db } from '../db.js';
import { decrypt } from './crypto.js';

// Generic outbound notifier. In this MVP, "email" and "slack"/"teams" simply
// deliver via a configured webhook URL (works with Slack/Teams incoming webhooks
// out of the box). Real SMTP/Jira wiring can be dropped into the switch below.
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
      // Placeholder: log-only delivery so the MVP runs without real SMTP creds.
      console.log(`[email_smtp:${integration.name}] To: ${config.to_default || '(ticket requester)'} — ${payload.text}`);
      return { ok: true, simulated: true };
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
