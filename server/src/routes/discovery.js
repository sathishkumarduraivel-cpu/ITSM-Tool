// Discovery: the door external tools push CIs through, plus the reports that
// make the results reviewable.
//
// The ingest endpoint authenticates on a per-source secret rather than a user
// session, because the thing calling it is a scanner or a scheduled job with
// no user to log in as -- the same pattern routes/alertWebhooks.js uses.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import { ConfigError } from '../services/ciClasses.js';
import {
  listDiscoverySources, getDiscoverySource, createDiscoverySource, updateDiscoverySource,
  rotateSecret, deleteDiscoverySource, getSourceForIngest, secretMatches, recordIngest, TRUST_TIERS,
} from '../services/discoverySources.js';
import { reconcile, driftReport, attributeHistory, provenanceFor } from '../services/ciIdentity.js';

const router = Router();

function handle(req, res, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConfigError) return res.status(err.status).json({ error: err.message });
    console.error('[discovery]', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// ---------------------------------------------------------------- ingest ---
// Deliberately mounted BEFORE the session auth middleware below: this is the
// one route with its own credential.
//
// A payload is a list of CIs. Each is identified against the existing estate
// and then updated or created, and the response says which happened to every
// one of them -- a discovery run that silently created 300 duplicates is
// indistinguishable from one that correctly matched them unless it tells you.
const MAX_BATCH = 500;

router.post('/ingest/:workspaceId/:sourceKey', (req, res) => {
  const { workspaceId, sourceKey } = req.params;

  const source = getSourceForIngest(workspaceId, sourceKey);
  const provided = req.headers['x-discovery-secret'] || req.query.secret;
  // The same 401 whether the source is missing, disabled or the secret is
  // wrong: a different message for each would let a caller enumerate which
  // sources exist.
  if (!source || !source.enabled || !secretMatches(provided, source.ingest_secret)) {
    return res.status(401).json({ error: 'Invalid or missing discovery credentials' });
  }

  const items = Array.isArray(req.body?.items) ? req.body.items
    : Array.isArray(req.body) ? req.body
      : req.body ? [req.body] : [];
  if (!items.length) return res.status(400).json({ error: 'No items in the payload' });
  if (items.length > MAX_BATCH) {
    return res.status(413).json({ error: `Send at most ${MAX_BATCH} CIs per request` });
  }

  const dryRun = req.query.dry_run === '1' || req.body?.dry_run === true;
  const results = [];
  for (const item of items) {
    try {
      results.push(reconcile(workspaceId, item || {}, { source, dryRun }));
    } catch (err) {
      // One malformed CI must not abandon the other 499.
      console.error('[discovery] item failed', err);
      results.push({ action: 'error', error: 'Could not process this item' });
    }
  }

  const summary = results.reduce((acc, r) => {
    acc[r.action] = (acc[r.action] || 0) + 1;
    return acc;
  }, {});
  if (!dryRun) recordIngest(workspaceId, source.id, items.length);

  return res.json({ received: items.length, dry_run: dryRun, summary, results });
});

// -------------------------------------------------- everything below is UI --
router.use(requireAuth, requireWorkspace);

// Any signed-in agent can read the drift and history reports -- they are how
// you answer "why does this CI say that", which is an everyday question.
router.get('/drift', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  res.json(driftReport(req.workspaceId, { limit, since: req.query.since || null }));
});

router.get('/ci/:id/history', (req, res) => {
  const ci = db.prepare('SELECT id FROM assets WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!ci) return res.status(404).json({ error: 'Not found' });
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
  res.json({
    history: attributeHistory(req.workspaceId, ci.id, { limit }),
    provenance: provenanceFor(ci.id),
  });
});

router.get('/sources', (req, res) => {
  res.json({ sources: listDiscoverySources(req.workspaceId), trust_tiers: TRUST_TIERS });
});

// ---- Administering sources changes what may write to the CMDB. ----
router.use(requirePermission('cmdb.manage'));

router.post('/sources', (req, res) => handle(req, res, () => {
  const source = createDiscoverySource(req.workspaceId, req.body || {});
  logAudit(req, { action: 'discovery_source.create', entityType: 'discovery_source', entityId: source.id, entityLabel: source.name });
  return res.status(201).json({
    source,
    // The tool being integrated needs both of these, and the secret is never
    // readable again.
    ingest_url: `/api/discovery/ingest/${req.workspaceId}/${source.key}`,
  });
}));

router.patch('/sources/:id', (req, res) => handle(req, res, () => {
  const source = updateDiscoverySource(req.workspaceId, req.params.id, req.body || {});
  logAudit(req, { action: 'discovery_source.update', entityType: 'discovery_source', entityId: source.id, entityLabel: source.name });
  return res.json({ source });
}));

router.post('/sources/:id/rotate-secret', (req, res) => handle(req, res, () => {
  const source = rotateSecret(req.workspaceId, req.params.id);
  logAudit(req, { action: 'discovery_source.rotate_secret', entityType: 'discovery_source', entityId: source.id, entityLabel: source.name });
  return res.json({ source });
}));

router.delete('/sources/:id', (req, res) => handle(req, res, () => {
  const source = getDiscoverySource(req.workspaceId, req.params.id);
  const result = deleteDiscoverySource(req.workspaceId, req.params.id);
  logAudit(req, { action: 'discovery_source.delete', entityType: 'discovery_source', entityId: req.params.id, entityLabel: source?.name });
  return res.json(result);
}));

// A manual dry run against a pasted payload, so an admin can see how their
// identification rules behave before pointing a real tool at this.
router.post('/preview', (req, res) => handle(req, res, () => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [req.body?.item].filter(Boolean);
  if (!items.length) return res.status(400).json({ error: 'No items to preview' });
  const source = req.body?.source_id ? getDiscoverySource(req.workspaceId, req.body.source_id) : null;
  return res.json({
    results: items.slice(0, 50).map((item) => reconcile(req.workspaceId, item || {}, { source, dryRun: true })),
  });
}));

export default router;
