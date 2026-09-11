// Inbound webhook receiver for bilateral ticket sync -- deliberately NOT
// gated by requireAuth/requireWorkspace (ServiceNow/Jira/Freshservice can't
// send our JWT). Authenticates instead via the per-connection webhook_secret
// the admin pastes into their platform's own webhook/automation config.
import { Router } from 'express';
import { db } from '../db.js';
import { applyInboundWebhook } from '../services/externalSync.js';

const router = Router();

router.post('/:connectionId', async (req, res) => {
  const connection = db.prepare('SELECT * FROM external_connections WHERE id = ?').get(req.params.connectionId);
  if (!connection) return res.status(404).json({ error: 'Unknown connection' });

  const providedSecret = req.headers['x-webhook-secret'] || req.query.secret;
  if (!providedSecret || providedSecret !== connection.webhook_secret) {
    return res.status(401).json({ error: 'Invalid or missing webhook secret' });
  }
  if (!connection.enabled) return res.json({ ok: true, applied: false, reason: 'Connection is disabled' });

  try {
    const result = await applyInboundWebhook(connection, req.body);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;
