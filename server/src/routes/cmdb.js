// Read-only views over the CMDB graph: impact, dependencies, service maps
// and the explorer. Editing CIs and their edges stays on /api/assets; this
// route answers questions about the shape of the estate.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import { getClass, descendantsOf, resolveClass, listClasses } from '../services/ciClasses.js';
import { listRelationshipTypes } from '../services/ciRelationshipTypes.js';
import { impactOf, dependenciesOf, servicesAffectedBy, serviceMap, neighbourhood, DEFAULT_MAX_DEPTH } from '../services/cmdbGraph.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

// A depth the caller supplies is clamped rather than trusted: the graph walk
// is bounded work per hop, and an unbounded depth on a dense estate is a
// request that never comes back.
function depthOf(req, fallback = DEFAULT_MAX_DEPTH, cap = 8) {
  const raw = parseInt(req.query.depth, 10);
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(raw, cap);
}

const ownedCi = (id, workspaceId) => db.prepare('SELECT * FROM assets WHERE id = ? AND workspace_id = ?').get(id, workspaceId);

router.get('/relationship-types', (req, res) => {
  res.json({ relationship_types: listRelationshipTypes(req.workspaceId, { includeDisabled: req.query.all === '1' }) });
});

// What breaks if this CI breaks, plus the named services it reaches -- the
// second is the part anyone actually acts on.
router.get('/ci/:id/impact', (req, res) => {
  const ci = ownedCi(req.params.id, req.workspaceId);
  if (!ci) return res.status(404).json({ error: 'Not found' });
  const maxDepth = depthOf(req);
  const dependencyOnly = req.query.dependency_only === '1';

  const graph = impactOf([ci.id], req.workspaceId, { maxDepth, dependencyOnly });
  return res.json({
    ci,
    ...graph,
    services: servicesAffectedBy([ci.id], req.workspaceId, { maxDepth, dependencyOnly }),
    depth: maxDepth,
  });
});

router.get('/ci/:id/dependencies', (req, res) => {
  const ci = ownedCi(req.params.id, req.workspaceId);
  if (!ci) return res.status(404).json({ error: 'Not found' });
  const maxDepth = depthOf(req);
  return res.json({ ci, ...dependenciesOf([ci.id], req.workspaceId, { maxDepth }), depth: maxDepth });
});

router.get('/ci/:id/graph', (req, res) => {
  const view = neighbourhood(req.params.id, req.workspaceId, { maxDepth: depthOf(req, 2, 4) });
  if (!view) return res.status(404).json({ error: 'Not found' });
  return res.json(view);
});

// The same question for a set of CIs at once: what a change touching all of
// them would reach.
router.post('/impact', (req, res) => {
  const ids = Array.isArray(req.body?.ci_ids) ? req.body.ci_ids : [];
  if (!ids.length) return res.status(400).json({ error: 'ci_ids is required' });

  const owned = ids.filter((id) => ownedCi(id, req.workspaceId));
  if (!owned.length) return res.status(404).json({ error: 'None of those CIs exist in this workspace' });

  const maxDepth = depthOf(req);
  return res.json({
    ...impactOf(owned, req.workspaceId, { maxDepth }),
    services: servicesAffectedBy(owned, req.workspaceId, { maxDepth }),
    requested: ids.length,
    resolved: owned.length,
  });
});

router.get('/service-map/:id', (req, res) => {
  const map = serviceMap(req.params.id, req.workspaceId, { maxDepth: depthOf(req, 6, 8) });
  if (!map) return res.status(404).json({ error: 'Not found' });
  return res.json(map);
});

// The service catalogue view: every business service with how much of the
// estate is mapped underneath it. A service with nothing under it is the
// single most useful thing a CMDB can point at -- it means nobody can answer
// "what does this depend on" when it breaks.
router.get('/services', (req, res) => {
  const serviceClass = getClass(req.workspaceId, 'business_service');
  if (!serviceClass) return res.json({ services: [] });
  const classIds = descendantsOf(req.workspaceId, serviceClass.id).map((c) => c.id);

  const services = db.prepare(
    `SELECT * FROM assets WHERE workspace_id = ? AND class_id IN (${classIds.map(() => '?').join(',')}) ORDER BY name`
  ).all(req.workspaceId, ...classIds);

  return res.json({
    services: services.map((svc) => {
      const deps = dependenciesOf([svc.id], req.workspaceId, { maxDepth: 6 });
      return {
        ...svc,
        ci_class: (() => {
          const cls = resolveClass(req.workspaceId, svc);
          return cls ? { id: cls.id, key: cls.key, label: cls.label, icon: cls.icon, color: cls.color } : null;
        })(),
        supporting_ci_count: deps.nodes.length,
        mapped: deps.nodes.length > 0,
      };
    }),
  });
});

// A flat count per class, for the inventory summary strip.
router.get('/summary', (req, res) => {
  const classes = listClasses(req.workspaceId, { includeDisabled: true });
  const counts = new Map(
    db.prepare('SELECT class_id, COUNT(*) c FROM assets WHERE workspace_id = ? AND class_id IS NOT NULL GROUP BY class_id')
      .all(req.workspaceId).map((r) => [r.class_id, r.c])
  );
  const { unclassified } = db.prepare('SELECT COUNT(*) unclassified FROM assets WHERE workspace_id = ? AND class_id IS NULL')
    .get(req.workspaceId);
  const { relationships } = db.prepare(
    `SELECT COUNT(*) relationships FROM asset_relationships r JOIN assets a ON a.id = r.asset_id WHERE a.workspace_id = ?`
  ).get(req.workspaceId);

  return res.json({
    total: db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ?').get(req.workspaceId).c,
    unclassified,
    relationships,
    by_class: classes
      .map((c) => ({ id: c.id, key: c.key, label: c.label, icon: c.icon, color: c.color, is_abstract: c.is_abstract, count: counts.get(c.id) || 0 }))
      .filter((c) => c.count > 0 || !c.is_abstract),
  });
});

export default router;
