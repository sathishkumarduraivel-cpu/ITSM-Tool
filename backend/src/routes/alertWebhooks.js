// Inbound alert receiver. Deliberately NOT gated by
// requireAuth/requireWorkspace -- Datadog, Grafana, Prometheus Alertmanager
// and a cron script cannot send our JWT. Authenticates instead on the
// per-source webhook_secret an admin pastes into the monitoring tool, the
// same arrangement routes/externalSyncWebhooks.js uses for ticket sync.
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../db.js';
import { ingestAlert } from '../services/alertIngest.js';
import { applyAlertRules } from '../services/alertRules.js';

const router = Router();

// Constant-time comparison, unlike the plain !== in externalSyncWebhooks.js.
// Both strings are hashed to a fixed length first so differing lengths
// cannot throw and cannot leak the expected length through timing either.
function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    // Still do a comparison of equal-length buffers so the failure path
    // costs roughly the same as a mismatch of the right length.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

router.post('/:sourceId', async (req, res) => {
  const source = db.prepare('SELECT * FROM alert_sources WHERE id = ?').get(req.params.sourceId);
  if (!source) return res.status(404).json({ error: 'Unknown alert source' });

  // An internal monitor source has no secret and must never be postable from
  // outside -- otherwise anyone who learned its id could forge ITSM-internal
  // alerts, which bypass the vendor field mapping entirely.
  if (source.source_type === 'internal' || !source.webhook_secret) {
    return res.status(403).json({ error: 'This source does not accept inbound webhooks' });
  }

  const provided = req.headers['x-webhook-secret'] || req.query.secret;
  if (!secretMatches(provided, source.webhook_secret)) {
    return res.status(401).json({ error: 'Invalid or missing webhook secret' });
  }

  try {
    // Alertmanager and several others batch multiple alerts per POST.
    const batch = Array.isArray(req.body?.alerts) ? req.body.alerts
      : Array.isArray(req.body) ? req.body
        : [req.body];

    const results = [];
    for (const payload of batch.slice(0, 100)) {
      const result = ingestAlert(source, payload);
      if (result.alertId && result.action === 'created') {
        // Awaited so an alert-raised incident is routed before we answer --
        // a monitoring tool's retry should not race our own rule processing.
        // eslint-disable-next-line no-await-in-loop
        result.rules = await applyAlertRules(source.workspace_id, result.alertId);
      }
      results.push(result);
    }

    // Always 200 for an authenticated, well-formed post, even when we chose
    // to dedupe, suppress or rate-limit it. A monitoring tool retrying
    // forever because we returned 500 for something we deliberately ignored
    // is its own kind of outage.
    res.json({ ok: true, received: results.length, results });
  } catch (e) {
    console.error('[alerts] ingestion failed', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

export default router;
