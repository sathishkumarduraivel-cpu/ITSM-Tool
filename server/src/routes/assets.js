import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import {
  getClass, listClasses, resolveClass, descendantsOf, ancestryOf,
  effectiveAttributes, validateAttributes, writeAttributes,
  readAttributes, readAttributesFor, readAttributeDetail, reconcileValuesForClass, isAssetClass,
} from '../services/ciClasses.js';
import { getRelationshipType, checkEndpoints, listRelationshipTypes } from '../services/ciRelationshipTypes.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

function getAsset(id, workspaceId) {
  return db.prepare('SELECT * FROM assets WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
}

const classSummary = (cls) => (cls
  ? { id: cls.id, key: cls.key, label: cls.label, icon: cls.icon, color: cls.color, is_asset: cls.is_asset }
  : null);

// Every asset that leaves this route carries its resolved class, so a caller
// never has to know whether the row predates classes.
function decorate(workspaceId, asset) {
  if (!asset) return asset;
  return {
    ...asset,
    ci_class: classSummary(resolveClass(workspaceId, asset)),
    attributes: readAttributes(asset.id),
  };
}

// The list form of the same thing: one query for every attribute value and
// one class lookup for the whole page, instead of two per row.
function decorateMany(workspaceId, assets) {
  if (!assets.length) return [];
  const byClassId = new Map(listClasses(workspaceId, { includeDisabled: true }).map((c) => [c.id, c]));
  const attrs = readAttributesFor(assets.map((a) => a.id));
  return assets.map((asset) => ({
    ...asset,
    ci_class: classSummary(
      (asset.class_id && byClassId.get(asset.class_id)) || resolveClass(workspaceId, asset)
    ),
    attributes: attrs.get(asset.id) || {},
  }));
}

router.get('/', (req, res) => {
  const { type, status, q, class_id: classId } = req.query;
  let sql = 'SELECT * FROM assets WHERE workspace_id = ?';
  const params = [req.workspaceId];

  // Filtering by a class means "and everything under it" -- asking for
  // Hardware and being handed nothing because every row is a Server or an
  // Endpoint would make the class tree useless as a navigation aid.
  if (classId) {
    const cls = getClass(req.workspaceId, classId);
    if (!cls) return res.status(404).json({ error: 'Class not found' });
    const ids = descendantsOf(req.workspaceId, cls.id).map((c) => c.id);
    sql += ` AND class_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  }
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (q) { sql += ' AND (name LIKE ? OR tag LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC';

  const assets = db.prepare(sql).all(...params);
  return res.json({ assets: decorateMany(req.workspaceId, assets) });
});

// The form asks for this before it can render: which classes exist, and what
// fields the chosen one expects.
router.get('/form-schema', (req, res) => {
  const classes = listClasses(req.workspaceId).filter((c) => !c.is_abstract);
  const cls = req.query.class_id ? getClass(req.workspaceId, req.query.class_id) : null;
  if (req.query.class_id && !cls) return res.status(404).json({ error: 'Class not found' });
  return res.json({
    classes,
    ci_class: cls,
    is_asset: cls ? !!cls.is_asset : true,
    attributes: cls ? effectiveAttributes(req.workspaceId, cls.id) : [],
  });
});

// Resolves a supplied class id or key and refuses the ones a CI cannot be.
function resolveTargetClass(workspaceId, value) {
  const cls = getClass(workspaceId, value);
  if (!cls) return { error: { status: 404, message: 'Class not found' } };
  if (cls.is_abstract) {
    return { error: { status: 400, message: `${cls.label} is a grouping class. Pick one of the classes underneath it.` } };
  }
  if (!cls.enabled) return { error: { status: 400, message: `${cls.label} is disabled` } };
  return { cls };
}

router.post('/', (req, res) => {
  const {
    tag, name, type = 'hardware', status = 'in_stock', owner_id, location, vendor,
    purchase_date, warranty_expiry, notes, class_id: classId, attributes,
  } = req.body || {};
  if (!tag || !name) return res.status(400).json({ error: 'tag and name required' });

  let cls = null;
  if (classId) {
    const resolved = resolveTargetClass(req.workspaceId, classId);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    cls = resolved.cls;
  }

  // Validate before inserting anything: a CI that exists but failed to take
  // its own required attributes is exactly the kind of half-record that
  // makes a CMDB untrustworthy.
  if (attributes && !cls) return res.status(400).json({ error: 'Pick a CI class before setting its fields' });
  if (cls) {
    const check = validateAttributes(req.workspaceId, cls.id, attributes || {});
    if (!check.ok) return res.status(400).json({ error: 'Some fields need attention', field_errors: check.errors });
  }

  const id = uid('ast');
  db.prepare(
    `INSERT INTO assets (id, workspace_id, tag, name, type, status, owner_id, location, vendor, purchase_date, warranty_expiry, notes, class_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, req.workspaceId, tag, name, type, status, owner_id || null, location || null, vendor || null,
    purchase_date || null, warranty_expiry || null, notes || null, cls ? cls.id : null,
  );

  // partial:false so declared defaults land on the new CI.
  if (cls) writeAttributes(req.workspaceId, id, cls.id, attributes || {}, { partial: false });

  return res.status(201).json({ asset: decorate(req.workspaceId, getAsset(id, req.workspaceId)) });
});

router.patch('/:id', (req, res) => {
  const asset = getAsset(req.params.id, req.workspaceId);
  if (!asset) return res.status(404).json({ error: 'Not found' });

  let nextClass = resolveClass(req.workspaceId, asset);
  const changingClass = req.body?.class_id !== undefined && req.body.class_id !== asset.class_id;
  if (changingClass) {
    const resolved = resolveTargetClass(req.workspaceId, req.body.class_id);
    if (resolved.error) return res.status(resolved.error.status).json({ error: resolved.error.message });
    nextClass = resolved.cls;
  }

  const { attributes } = req.body || {};
  if (attributes && !nextClass) return res.status(400).json({ error: 'Pick a CI class before setting its fields' });
  if (attributes) {
    const check = validateAttributes(req.workspaceId, nextClass.id, attributes, { partial: true });
    if (!check.ok) return res.status(400).json({ error: 'Some fields need attention', field_errors: check.errors });
  }

  const allowed = ['name', 'type', 'status', 'owner_id', 'location', 'vendor', 'purchase_date', 'warranty_expiry', 'notes'];
  const fields = []; const params = [];
  for (const key of allowed) if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  if (changingClass) { fields.push('class_id = ?'); params.push(nextClass.id); }

  if (!fields.length && !attributes) return res.status(400).json({ error: 'No valid fields' });
  if (fields.length) {
    params.push(req.params.id);
    db.prepare(`UPDATE assets SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }

  // Reclassifying carries across every value whose key still resolves and
  // drops the rest, rather than leaving values attached to a class this CI
  // is no longer on.
  if (changingClass) reconcileValuesForClass(req.workspaceId, asset.id, nextClass.id);
  if (attributes) writeAttributes(req.workspaceId, asset.id, nextClass.id, attributes, { partial: true });

  return res.json({ asset: decorate(req.workspaceId, getAsset(req.params.id, req.workspaceId)) });
});

router.delete('/:id', (req, res) => {
  const asset = getAsset(req.params.id, req.workspaceId);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- CMDB: single CI with relationships, linked tickets, impact view ----
router.get('/:id/detail', (req, res) => {
  const asset = getAsset(req.params.id, req.workspaceId);
  if (!asset) return res.status(404).json({ error: 'Not found' });

  const dependsOn = db.prepare(`
    SELECT a.*, r.relationship_type, r.id as rel_id FROM asset_relationships r
    JOIN assets a ON a.id = r.related_asset_id WHERE r.asset_id = ?
  `).all(req.params.id);

  const dependedOnBy = db.prepare(`
    SELECT a.*, r.relationship_type, r.id as rel_id FROM asset_relationships r
    JOIN assets a ON a.id = r.asset_id WHERE r.related_asset_id = ?
  `).all(req.params.id);

  const linkedTickets = db.prepare(`
    SELECT t.id, t.number, t.title, t.status, t.priority, t.type FROM ticket_assets ta
    JOIN tickets t ON t.id = ta.ticket_id WHERE ta.asset_id = ? ORDER BY t.created_at DESC
  `).all(req.params.id);

  const cls = resolveClass(req.workspaceId, asset);

  // Each edge is labelled from the reader's end: the CIs this one depends on
  // read with the forward label ("runs on"), the ones depending on it with
  // the inverse ("hosts"). One stored row, two correct sentences.
  const types = new Map(listRelationshipTypes(req.workspaceId, { includeDisabled: true }).map((t) => [t.key, t]));
  const label = (row, inverse) => {
    const type = types.get(row.relationship_type);
    if (!type) return row.relationship_type;
    return inverse ? type.inverse_label : type.label;
  };

  res.json({
    asset: decorate(req.workspaceId, asset),
    ci_class: cls,
    ancestry: cls ? ancestryOf(req.workspaceId, cls.id) : [],
    // Ownership, warranty and financial fields are only meaningful on a class
    // that represents something somebody bought. The UI uses this to decide
    // whether to show them at all rather than rendering empty boxes on a
    // business service.
    is_asset: cls ? isAssetClass(req.workspaceId, cls.id) : true,
    attributes: cls ? readAttributeDetail(req.workspaceId, asset.id, cls.id) : [],
    dependsOn: decorateMany(req.workspaceId, dependsOn)
      .map((a, i) => ({ ...a, relationship_label: label(dependsOn[i], false) })),
    dependedOnBy: decorateMany(req.workspaceId, dependedOnBy)
      .map((a, i) => ({ ...a, relationship_label: label(dependedOnBy[i], true) })),
    linkedTickets,
  });
});

// An edge is stored source -> target meaning "this CI depends on that one".
router.post('/:id/relationships', (req, res) => {
  const asset = getAsset(req.params.id, req.workspaceId);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  const { related_asset_id, relationship_type = 'depends_on', description } = req.body;
  if (!related_asset_id) return res.status(400).json({ error: 'related_asset_id required' });
  if (related_asset_id === req.params.id) return res.status(400).json({ error: 'A CI cannot depend on itself' });
  const related = getAsset(related_asset_id, req.workspaceId);
  if (!related) return res.status(404).json({ error: 'Related asset not found' });

  const type = getRelationshipType(req.workspaceId, relationship_type);
  if (!type) return res.status(400).json({ error: `Unknown relationship type: ${relationship_type}` });
  if (!type.enabled) return res.status(400).json({ error: `${type.label} is disabled` });

  // A type may restrict which classes can sit at each end, so an admin can
  // stop nonsense like "Business Service installed on Printer" being recorded.
  const endpointErrors = checkEndpoints(
    req.workspaceId, type, resolveClass(req.workspaceId, asset), resolveClass(req.workspaceId, related),
  );
  if (endpointErrors.length) return res.status(400).json({ error: endpointErrors[0], errors: endpointErrors });

  // The same edge twice adds nothing and doubles its weight in every graph
  // walk, so it is treated as already done rather than as an error.
  const existing = db.prepare(
    'SELECT id FROM asset_relationships WHERE asset_id = ? AND related_asset_id = ? AND relationship_type = ?'
  ).get(req.params.id, related_asset_id, type.key);
  if (existing) return res.status(200).json({ id: existing.id, already_existed: true });

  const id = uid('rel');
  db.prepare(
    'INSERT INTO asset_relationships (id, asset_id, related_asset_id, relationship_type, type_id, description) VALUES (?,?,?,?,?,?)'
  ).run(id, req.params.id, related_asset_id, type.key, type.id, description || null);
  res.status(201).json({ id, relationship_type: type });
});

router.delete('/relationships/:relId', (req, res) => {
  const rel = db.prepare(
    `SELECT r.id FROM asset_relationships r JOIN assets a ON a.id = r.asset_id WHERE r.id = ? AND a.workspace_id = ?`
  ).get(req.params.relId, req.workspaceId);
  if (!rel) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM asset_relationships WHERE id = ?').run(req.params.relId);
  res.json({ ok: true });
});

export default router;
