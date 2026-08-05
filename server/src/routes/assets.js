import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, attachWorkspace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

function getAsset(id) {
  return db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
}

router.get('/', (req, res) => {
  const { type, status, q } = req.query;
  let sql = 'SELECT * FROM assets WHERE 1=1';
  const params = [];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (q) { sql += ' AND (name LIKE ? OR tag LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC';
  res.json({ assets: db.prepare(sql).all(...params) });
});

router.post('/', (req, res) => {
  const { tag, name, type = 'hardware', status = 'in_stock', owner_id, location, vendor, purchase_date, warranty_expiry, notes } = req.body;
  if (!tag || !name) return res.status(400).json({ error: 'tag and name required' });
  const id = uid('ast');
  db.prepare(
    `INSERT INTO assets (id, workspace_id, tag, name, type, status, owner_id, location, vendor, purchase_date, warranty_expiry, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, tag, name, type, status, owner_id || null, location || null, vendor || null, purchase_date || null, warranty_expiry || null, notes || null);
  res.status(201).json({ asset: getAsset(id) });
});

router.patch('/:id', (req, res) => {
  const asset = getAsset(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  const allowed = ['name', 'type', 'status', 'owner_id', 'location', 'vendor', 'purchase_date', 'warranty_expiry', 'notes'];
  const fields = []; const params = [];
  for (const key of allowed) if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE assets SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ asset: getAsset(req.params.id) });
});

router.delete('/:id', (req, res) => {
  const asset = getAsset(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM assets WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- CMDB: single asset with relationships, linked tickets, impact view ----
router.get('/:id/detail', (req, res) => {
  const asset = getAsset(req.params.id);
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

  res.json({ asset, dependsOn, dependedOnBy, linkedTickets });
});

router.post('/:id/relationships', (req, res) => {
  const asset = getAsset(req.params.id);
  if (!asset) return res.status(404).json({ error: 'Not found' });
  const { related_asset_id, relationship_type = 'depends_on' } = req.body;
  if (!related_asset_id) return res.status(400).json({ error: 'related_asset_id required' });
  const related = getAsset(related_asset_id);
  if (!related) return res.status(404).json({ error: 'Related asset not found' });
  const id = uid('rel');
  db.prepare('INSERT INTO asset_relationships (id, asset_id, related_asset_id, relationship_type) VALUES (?,?,?,?)').run(
    id, req.params.id, related_asset_id, relationship_type
  );
  res.status(201).json({ id });
});

router.delete('/relationships/:relId', (req, res) => {
  const rel = db.prepare('SELECT id FROM asset_relationships WHERE id = ?').get(req.params.relId);
  if (!rel) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM asset_relationships WHERE id = ?').run(req.params.relId);
  res.json({ ok: true });
});

export default router;
