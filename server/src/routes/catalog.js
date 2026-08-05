import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, attachWorkspace, requireRole } from '../middleware/auth.js';
import { notifyRole } from '../services/notifications.js';
import { nextTicketNumber } from '../services/ticketNumbering.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

// ---- Categories ----
router.get('/categories', (req, res) => {
  res.json({ categories: db.prepare('SELECT * FROM catalog_categories ORDER BY sort_order, name').all() });
});

router.post('/categories', requireRole('admin'), (req, res) => {
  const { name, icon = 'Package', sort_order = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid('cat');
  db.prepare('INSERT INTO catalog_categories (id, workspace_id, name, icon, sort_order) VALUES (?,?,?,?,?)').run(id, req.workspaceId, name, icon, sort_order);
  res.status(201).json({ id });
});

router.patch('/categories/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM catalog_categories WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['name', 'icon', 'sort_order'];
  const fields = []; const params = [];
  for (const key of allowed) if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE catalog_categories SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/categories/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM catalog_categories WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM catalog_categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Items ----
router.get('/items', (req, res) => {
  const { category_id } = req.query;
  let sql = 'SELECT * FROM catalog_items WHERE enabled = 1';
  const params = [];
  if (category_id) { sql += ' AND category_id = ?'; params.push(category_id); }
  sql += ' ORDER BY created_at DESC';
  const items = db.prepare(sql).all(...params).map((i) => ({ ...i, form_schema: JSON.parse(i.form_schema || '[]') }));
  res.json({ items });
});

router.post('/items', requireRole('admin'), (req, res) => {
  const { category_id, name, description, icon = 'Package', form_schema = [], approval_required = true, approver_role = 'admin', default_priority = 'medium', price } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid('itm');
  db.prepare(
    `INSERT INTO catalog_items (id, workspace_id, category_id, name, description, icon, form_schema, approval_required, approver_role, default_priority, price)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, category_id || null, name, description || '', icon, JSON.stringify(form_schema), approval_required ? 1 : 0, approver_role, default_priority, price || null);
  res.status(201).json({ id });
});

router.patch('/items/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['category_id', 'name', 'description', 'icon', 'approval_required', 'approver_role', 'default_priority', 'price', 'enabled'];
  const fields = []; const params = [];
  for (const key of allowed) if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : req.body[key]); }
  if (req.body.form_schema !== undefined) { fields.push('form_schema = ?'); params.push(JSON.stringify(req.body.form_schema)); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE catalog_items SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/items/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM catalog_items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM catalog_items WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Submit a catalog request -> creates a ticket (+ approval chain if required) ----
router.post('/items/:id/request', (req, res) => {
  const item = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });
  const { form_data = {} } = req.body;

  const id = uid('tkt');
  const number = nextTicketNumber('request');
  const needsApproval = !!item.approval_required;
  const status = needsApproval ? 'pending_approval' : 'open';
  const slaHours = { critical: 4, high: 8, medium: 24, low: 72 }[item.default_priority] || 24;
  const sla_due_at = new Date(Date.now() + slaHours * 3600 * 1000).toISOString();

  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, status, priority, category, requester_id, sla_due_at, source, catalog_item_id, catalog_form_data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, req.workspaceId, number, 'request', item.name,
    Object.entries(form_data).map(([k, v]) => `${k}: ${v}`).join('\n') || item.description,
    status, item.default_priority, 'Service Catalog', req.user.id, sla_due_at, 'catalog',
    item.id, JSON.stringify(form_data)
  );
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), id, 'created', `Catalog request: ${item.name}`);

  if (needsApproval) {
    const approvalId = uid('apr');
    db.prepare(
      'INSERT INTO approvals (id, ticket_id, approver_role, step_order, status) VALUES (?,?,?,?,?)'
    ).run(approvalId, id, item.approver_role, 1, 'pending');
    notifyRole(item.approver_role, 'Approval requested', `${req.user.name} requested "${item.name}" (${number})`, `/tickets/${id}`);
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  res.status(201).json({ ticket });
});

export default router;
