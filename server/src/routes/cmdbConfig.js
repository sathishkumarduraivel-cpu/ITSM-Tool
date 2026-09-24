// Admin surface for the CMDB model: CI classes and the typed attributes they
// declare. The CIs themselves live on /api/assets -- this route only shapes
// what a CI is allowed to be.
import { Router } from 'express';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import {
  DATA_TYPES, ConfigError,
  listClasses, getClass, classTree, effectiveAttributes, ancestryOf, descendantsOf,
  createClass, updateClass, deleteClass,
  createAttribute, updateAttribute, deleteAttribute,
} from '../services/ciClasses.js';
import {
  createRelationshipType, updateRelationshipType, deleteRelationshipType,
} from '../services/ciRelationshipTypes.js';
import {
  listIdentificationRules, createIdentificationRule, updateIdentificationRule, deleteIdentificationRule,
} from '../services/ciIdentity.js';
import { db } from '../db.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

// A thrown ConfigError already carries the status and a message written for
// the person reading it; anything else is a genuine fault and should not be
// echoed back.
function handle(req, res, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConfigError) return res.status(err.status).json({ error: err.message });
    console.error('[cmdb-config]', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

const TYPE_LABELS = {
  text: 'Text', textarea: 'Long text', number: 'Number', integer: 'Whole number',
  date: 'Date', datetime: 'Date & time', boolean: 'Yes / no',
  select: 'Choice', multiselect: 'Multiple choice', reference: 'Link to another CI',
  ip: 'IP address', url: 'URL', email: 'Email address',
};

// ---- Reads. Any signed-in user, because the asset form needs the schema. ----

router.get('/meta', (req, res) => {
  res.json({
    data_types: DATA_TYPES.map((key) => ({ key, label: TYPE_LABELS[key] || key })),
  });
});

router.get('/classes', (req, res) => {
  const includeDisabled = req.query.all === '1';
  const classes = listClasses(req.workspaceId, { includeDisabled });
  // CI counts come back with the list so the admin tree can show how much of
  // the estate actually sits on each class -- an empty class is the signal
  // that a model has drifted away from reality.
  const counts = new Map(
    db.prepare('SELECT class_id, COUNT(*) c FROM assets WHERE workspace_id = ? AND class_id IS NOT NULL GROUP BY class_id')
      .all(req.workspaceId).map((r) => [r.class_id, r.c])
  );
  res.json({
    classes: classes.map((c) => ({ ...c, ci_count: counts.get(c.id) || 0 })),
    tree: classTree(req.workspaceId),
  });
});

router.get('/classes/:id/identification-rules', (req, res) => handle(req, res, () => {
  const cls = getClass(req.workspaceId, req.params.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  return res.json({
    rules: listIdentificationRules(req.workspaceId, cls.id, { includeDisabled: true }),
    // Only attributes flagged as identifiers are worth matching on, so the
    // rule builder offers those first rather than the whole schema.
    candidates: effectiveAttributes(req.workspaceId, cls.id)
      .map((a) => ({ attr_key: a.attr_key, label: a.label, is_identifier: a.is_identifier })),
  });
}));

router.get('/classes/:id', (req, res) => handle(req, res, () => {
  const cls = getClass(req.workspaceId, req.params.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  const { c } = db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ? AND class_id = ?')
    .get(req.workspaceId, cls.id);
  return res.json({
    ci_class: cls,
    ancestry: ancestryOf(req.workspaceId, cls.id),
    descendants: descendantsOf(req.workspaceId, cls.id, { includeSelf: false }),
    attributes: effectiveAttributes(req.workspaceId, cls.id, { includeDisabled: true }),
    ci_count: c,
  });
}));

// ---- Everything below changes the model. ----
router.use(requirePermission('cmdb.manage'));

router.post('/classes', (req, res) => handle(req, res, () => {
  const cls = createClass(req.workspaceId, req.body || {});
  logAudit(req, { action: 'ci_class.create', entityType: 'ci_class', entityId: cls.id, entityLabel: cls.label });
  return res.status(201).json({ ci_class: cls });
}));

router.patch('/classes/:id', (req, res) => handle(req, res, () => {
  const cls = updateClass(req.workspaceId, req.params.id, req.body || {});
  logAudit(req, { action: 'ci_class.update', entityType: 'ci_class', entityId: cls.id, entityLabel: cls.label });
  return res.json({ ci_class: cls });
}));

router.delete('/classes/:id', (req, res) => handle(req, res, () => {
  const cls = getClass(req.workspaceId, req.params.id);
  const result = deleteClass(req.workspaceId, req.params.id);
  logAudit(req, { action: 'ci_class.delete', entityType: 'ci_class', entityId: req.params.id, entityLabel: cls?.label });
  return res.json(result);
}));

router.post('/classes/:id/attributes', (req, res) => handle(req, res, () => {
  const attr = createAttribute(req.workspaceId, req.params.id, req.body || {});
  logAudit(req, { action: 'ci_attribute.create', entityType: 'ci_class_attribute', entityId: attr.id, entityLabel: attr.label });
  return res.status(201).json({ attribute: attr });
}));

router.patch('/attributes/:id', (req, res) => handle(req, res, () => {
  const attr = updateAttribute(req.workspaceId, req.params.id, req.body || {});
  logAudit(req, { action: 'ci_attribute.update', entityType: 'ci_class_attribute', entityId: attr.id, entityLabel: attr.label });
  return res.json({ attribute: attr });
}));

router.delete('/attributes/:id', (req, res) => handle(req, res, () => {
  const result = deleteAttribute(req.workspaceId, req.params.id);
  logAudit(req, { action: 'ci_attribute.delete', entityType: 'ci_class_attribute', entityId: req.params.id });
  return res.json(result);
}));

router.post('/relationship-types', (req, res) => handle(req, res, () => {
  const type = createRelationshipType(req.workspaceId, req.body || {});
  logAudit(req, { action: 'ci_relationship_type.create', entityType: 'ci_relationship_type', entityId: type.id, entityLabel: type.label });
  return res.status(201).json({ relationship_type: type });
}));

router.patch('/relationship-types/:id', (req, res) => handle(req, res, () => {
  const type = updateRelationshipType(req.workspaceId, req.params.id, req.body || {});
  logAudit(req, { action: 'ci_relationship_type.update', entityType: 'ci_relationship_type', entityId: type.id, entityLabel: type.label });
  return res.json({ relationship_type: type });
}));

router.delete('/relationship-types/:id', (req, res) => handle(req, res, () => {
  const result = deleteRelationshipType(req.workspaceId, req.params.id);
  logAudit(req, { action: 'ci_relationship_type.delete', entityType: 'ci_relationship_type', entityId: req.params.id });
  return res.json(result);
}));

router.post('/classes/:id/identification-rules', (req, res) => handle(req, res, () => {
  const rule = createIdentificationRule(req.workspaceId, req.params.id, req.body || {});
  logAudit(req, { action: 'ci_identification_rule.create', entityType: 'ci_identification_rule', entityId: rule.id, entityLabel: rule.name });
  return res.status(201).json({ rule });
}));

router.patch('/identification-rules/:id', (req, res) => handle(req, res, () => {
  const rule = updateIdentificationRule(req.workspaceId, req.params.id, req.body || {});
  logAudit(req, { action: 'ci_identification_rule.update', entityType: 'ci_identification_rule', entityId: rule.id, entityLabel: rule.name });
  return res.json({ rule });
}));

router.delete('/identification-rules/:id', (req, res) => handle(req, res, () => {
  const result = deleteIdentificationRule(req.workspaceId, req.params.id);
  logAudit(req, { action: 'ci_identification_rule.delete', entityType: 'ci_identification_rule', entityId: req.params.id });
  return res.json(result);
}));

// Reordering the fields on a class is a single call rather than N patches, so
// a drag-and-drop cannot leave the order half-applied.
router.post('/classes/:id/attributes/reorder', (req, res) => handle(req, res, () => {
  const cls = getClass(req.workspaceId, req.params.id);
  if (!cls) return res.status(404).json({ error: 'Class not found' });
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'order must be an array of attribute ids' });

  // Only attributes this class actually declares can be reordered -- an
  // inherited one belongs to the ancestor and is ordered there.
  const own = new Set(db.prepare('SELECT id FROM ci_class_attributes WHERE workspace_id = ? AND class_id = ?')
    .all(req.workspaceId, cls.id).map((r) => r.id));
  const unknown = order.filter((id) => !own.has(id));
  if (unknown.length) return res.status(400).json({ error: 'Some fields are not declared on this class' });

  db.exec('BEGIN');
  try {
    order.forEach((id, i) => db.prepare('UPDATE ci_class_attributes SET sort_order = ? WHERE id = ?').run(i * 10, id));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return res.json({ attributes: effectiveAttributes(req.workspaceId, cls.id, { includeDisabled: true }) });
}));

export default router;
