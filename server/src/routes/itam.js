// IT Asset Management: custody, lifecycle, money, licences, import/export and
// the CMDB health report.
//
// Split from /api/assets on purpose. That route is about the CI record; this
// one is about the asset as a thing somebody bought, holds and eventually
// disposes of -- a different question, asked by different people.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import { ConfigError } from '../services/ciClasses.js';
import {
  LIFECYCLE_STATES, lifecycleFor, transitionLifecycle, checkOut, checkIn,
  assignmentHistory, openAssignment, heldBy, lifecycleSummary,
} from '../services/assetLifecycle.js';
import {
  getFinancials, saveFinancials, portfolio, expiringSoon, DEPRECIATION_METHODS,
} from '../services/assetFinancials.js';
import {
  LICENSING_METRICS, listProducts, getProduct, createProduct, updateProduct, deleteProduct,
  addEntitlement, deleteEntitlement, recordInstallation, removeInstallation, listInstallations,
  positionFor, compliancePosition,
} from '../services/licenseCompliance.js';
import { healthReport, healthByClass, DEFAULT_STALE_DAYS } from '../services/cmdbHealth.js';
import {
  readSheet, guessMapping, mappingOptions, previewImport, commitImport, templateFor, exportClass,
} from '../services/cmdbImport.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

function handle(req, res, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConfigError) return res.status(err.status).json({ error: err.message });
    console.error('[itam]', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

// ----------------------------------------------------------- lifecycle ----

router.get('/meta', (req, res) => {
  res.json({
    lifecycle_states: Object.entries(LIFECYCLE_STATES).map(([key, v]) => ({ key, ...v })),
    depreciation_methods: DEPRECIATION_METHODS,
    licensing_metrics: LICENSING_METRICS,
  });
});

router.get('/summary', (req, res) => {
  res.json({ lifecycle: lifecycleSummary(req.workspaceId) });
});

router.get('/assets/:id/lifecycle', (req, res) => handle(req, res, () => res.json({
  ...lifecycleFor(req.workspaceId, req.params.id),
  assignments: assignmentHistory(req.workspaceId, req.params.id),
  current_assignment: openAssignment(req.params.id),
})));

router.post('/assets/:id/lifecycle', (req, res) => handle(req, res, () => {
  const result = transitionLifecycle(req.workspaceId, req.params.id, req.body?.to, {
    reason: req.body?.reason || null, actorId: req.user.id,
  });
  logAudit(req, { action: 'asset.lifecycle', entityType: 'asset', entityId: req.params.id, details: result });
  return res.json(result);
}));

router.post('/assets/:id/check-out', (req, res) => handle(req, res, () => {
  const result = checkOut(req.workspaceId, req.params.id, {
    userId: req.body?.user_id || null, label: req.body?.label || null,
    condition: req.body?.condition || null, notes: req.body?.notes || null, actorId: req.user.id,
  });
  logAudit(req, { action: 'asset.check_out', entityType: 'asset', entityId: req.params.id });
  return res.json(result);
}));

router.post('/assets/:id/check-in', (req, res) => handle(req, res, () => {
  const result = checkIn(req.workspaceId, req.params.id, {
    condition: req.body?.condition || null, notes: req.body?.notes || null,
    toState: req.body?.to_state || 'in_stock', actorId: req.user.id,
  });
  logAudit(req, { action: 'asset.check_in', entityType: 'asset', entityId: req.params.id });
  return res.json(result);
}));

// What one person currently holds. The leaver question.
router.get('/held-by/:userId', (req, res) => {
  res.json({ assets: heldBy(req.workspaceId, req.params.userId) });
});

// ---------------------------------------------------------- financials ----
// Money is admin territory: procurement figures are exactly the sort of thing
// this codebase already keeps out of a plain agent's reach.

router.get('/assets/:id/financials', requirePermission('cmdb.manage'), (req, res) => {
  res.json({ financials: getFinancials(req.workspaceId, req.params.id) });
});

router.put('/assets/:id/financials', requirePermission('cmdb.manage'), (req, res) => handle(req, res, () => {
  const financials = saveFinancials(req.workspaceId, req.params.id, req.body || {});
  logAudit(req, { action: 'asset.financials', entityType: 'asset', entityId: req.params.id });
  return res.json({ financials });
}));

router.get('/portfolio', requirePermission('cmdb.manage'), (req, res) => {
  res.json(portfolio(req.workspaceId));
});

router.get('/expiring', (req, res) => {
  const days = Math.min(730, Math.max(1, parseInt(req.query.days, 10) || 90));
  res.json(expiringSoon(req.workspaceId, { days }));
});

// ------------------------------------------------------------ licences ----

router.get('/licenses', (req, res) => {
  res.json(compliancePosition(req.workspaceId));
});

router.get('/licenses/products', (req, res) => {
  res.json({ products: listProducts(req.workspaceId), metrics: LICENSING_METRICS });
});

router.get('/licenses/products/:id', (req, res) => handle(req, res, () => {
  const product = getProduct(req.workspaceId, req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  return res.json({
    position: positionFor(req.workspaceId, product.id),
    entitlements: db.prepare('SELECT * FROM license_entitlements WHERE product_id = ? ORDER BY purchase_date DESC').all(product.id),
    installations: listInstallations(req.workspaceId, product.id),
  });
}));

router.use('/licenses', requirePermission('cmdb.manage'));

router.post('/licenses/products', (req, res) => handle(req, res, () => {
  const product = createProduct(req.workspaceId, req.body || {});
  logAudit(req, { action: 'software_product.create', entityType: 'software_product', entityId: product.id, entityLabel: product.name });
  return res.status(201).json({ product });
}));

router.patch('/licenses/products/:id', (req, res) => handle(req, res, () => {
  const product = updateProduct(req.workspaceId, req.params.id, req.body || {});
  return res.json({ product });
}));

router.delete('/licenses/products/:id', (req, res) => handle(req, res, () => {
  const result = deleteProduct(req.workspaceId, req.params.id);
  logAudit(req, { action: 'software_product.delete', entityType: 'software_product', entityId: req.params.id });
  return res.json(result);
}));

router.post('/licenses/products/:id/entitlements', (req, res) => handle(req, res, () => (
  res.status(201).json({ entitlement: addEntitlement(req.workspaceId, req.params.id, req.body || {}) })
)));

router.delete('/licenses/entitlements/:id', (req, res) => handle(req, res, () => (
  res.json(deleteEntitlement(req.workspaceId, req.params.id))
)));

router.post('/licenses/products/:id/installations', (req, res) => handle(req, res, () => (
  res.status(201).json({ installation: recordInstallation(req.workspaceId, req.params.id, req.body || {}) })
)));

router.delete('/licenses/installations/:id', (req, res) => handle(req, res, () => (
  res.json(removeInstallation(req.workspaceId, req.params.id))
)));

// -------------------------------------------------------------- health ----

router.get('/health', (req, res) => {
  const staleDays = Math.min(3650, Math.max(1, parseInt(req.query.stale_days, 10) || DEFAULT_STALE_DAYS));
  res.json({
    ...healthReport(req.workspaceId, { staleDays }),
    by_class: healthByClass(req.workspaceId, { staleDays }),
  });
});

// -------------------------------------------------------------- import ----
// Importing rewrites the estate, so it sits behind the same permission the
// rest of the CMDB model does.

router.get('/import/template/:classId', requirePermission('cmdb.manage'), (req, res) => handle(req, res, () => {
  const csv = templateFor(req.workspaceId, req.params.classId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cmdb-import-template.csv"');
  return res.send(csv);
}));

router.get('/export/:classId', requirePermission('cmdb.manage'), (req, res) => handle(req, res, () => {
  const csv = exportClass(req.workspaceId, req.params.classId);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cmdb-export.csv"');
  return res.send(csv);
}));

// The file arrives as text in the JSON body rather than as a multipart upload:
// a CSV is text, the app already posts JSON everywhere, and it avoids adding
// an upload path for something that is read once and thrown away.
router.post('/import/inspect', requirePermission('cmdb.manage'), (req, res) => handle(req, res, () => {
  const { csv, class_id: classId, delimiter } = req.body || {};
  if (!csv) return res.status(400).json({ error: 'No file contents received' });
  const sheet = readSheet(csv, { delimiter: delimiter || ',' });
  return res.json({
    headers: sheet.headers,
    row_count: sheet.rows.length,
    sample: sheet.rows.slice(0, 5),
    ...(classId ? {
      mapping: guessMapping(req.workspaceId, classId, sheet.headers),
      options: mappingOptions(req.workspaceId, classId),
    } : {}),
  });
}));

router.post('/import/preview', requirePermission('cmdb.manage'), (req, res) => handle(req, res, () => {
  const { csv, class_id: classId, mapping, source_id: sourceId, delimiter } = req.body || {};
  if (!csv) return res.status(400).json({ error: 'No file contents received' });
  const preview = previewImport(req.workspaceId, readSheet(csv, { delimiter: delimiter || ',' }), { classId, mapping, sourceId });
  // `all` is the internal full list the commit re-derives; it would only
  // bloat the response.
  const { all, ...rest } = preview;
  return res.json(rest);
}));

router.post('/import/commit', requirePermission('cmdb.manage'), (req, res) => handle(req, res, () => {
  const { csv, class_id: classId, mapping, source_id: sourceId, delimiter, skip_duplicates: skipDuplicates } = req.body || {};
  if (!csv) return res.status(400).json({ error: 'No file contents received' });
  const result = commitImport(req.workspaceId, readSheet(csv, { delimiter: delimiter || ',' }), {
    classId, mapping, sourceId, skipDuplicates: skipDuplicates !== false,
  });
  logAudit(req, { action: 'cmdb.import', entityType: 'ci_class', entityId: classId, details: result.summary });
  return res.json(result);
}));

export default router;
