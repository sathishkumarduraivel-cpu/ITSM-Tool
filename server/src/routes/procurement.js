import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, attachWorkspace, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

// ---- Contracts ----
router.get('/contracts', (req, res) => {
  res.json({ contracts: db.prepare('SELECT * FROM contracts ORDER BY end_date ASC').all() });
});

router.post('/contracts', requireRole('admin'), (req, res) => {
  const { vendor, name, type = 'support', start_date, end_date, value, renewal_notice_days = 30, notes } = req.body;
  if (!vendor || !name) return res.status(400).json({ error: 'vendor and name required' });
  const id = uid('ctr');
  db.prepare(
    `INSERT INTO contracts (id, workspace_id, vendor, name, type, start_date, end_date, value, renewal_notice_days, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, vendor, name, type, start_date || null, end_date || null, value || null, renewal_notice_days, notes || null);
  res.status(201).json({ id });
});

router.patch('/contracts/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['vendor', 'name', 'type', 'start_date', 'end_date', 'value', 'renewal_notice_days', 'notes'];
  const fields = []; const params = [];
  for (const key of allowed) if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE contracts SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/contracts/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM contracts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM contracts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Purchase Orders ----
router.get('/purchase-orders', (req, res) => {
  res.json({ purchaseOrders: db.prepare('SELECT * FROM purchase_orders ORDER BY created_at DESC').all() });
});

router.post('/purchase-orders', requireRole('admin'), (req, res) => {
  const { po_number, vendor, item, amount, status = 'draft', ordered_date, received_date, asset_id, notes } = req.body;
  if (!po_number || !vendor || !item) return res.status(400).json({ error: 'po_number, vendor, item required' });
  const id = uid('po');
  db.prepare(
    `INSERT INTO purchase_orders (id, workspace_id, po_number, vendor, item, amount, status, ordered_date, received_date, asset_id, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, po_number, vendor, item, amount || null, status, ordered_date || null, received_date || null, asset_id || null, notes || null);
  res.status(201).json({ id });
});

router.patch('/purchase-orders/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['vendor', 'item', 'amount', 'status', 'ordered_date', 'received_date', 'asset_id', 'notes'];
  const fields = []; const params = [];
  for (const key of allowed) if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE purchase_orders SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/purchase-orders/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
