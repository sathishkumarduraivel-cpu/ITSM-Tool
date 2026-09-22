import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { listTaxonomy, ensureDefaultTaxonomy } from '../services/ticketCategories.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

// Readable by everyone signed in, including requesters -- the portal's own
// ticket form needs the same picker the agent view uses, and a category list
// is not sensitive.
router.get('/', (req, res) => {
  const includeInactive = req.query.all === '1' && (req.user.role === 'admin' || (req.user.permissions || []).includes('ticket_categories.manage'));
  res.json({ categories: listTaxonomy(req.workspaceId, { includeInactive }) });
});

router.use(requirePermission('ticket_categories.manage'));

router.post('/', (req, res) => {
  ensureDefaultTaxonomy(req.workspaceId);
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const clash = db.prepare('SELECT 1 FROM ticket_categories WHERE workspace_id = ? AND name = ?').get(req.workspaceId, name);
  if (clash) return res.status(400).json({ error: 'A category with that name already exists' });

  const nextOrder = (db.prepare('SELECT MAX(sort_order) m FROM ticket_categories WHERE workspace_id = ?').get(req.workspaceId).m ?? -1) + 1;
  const id = uid('tcat');
  db.prepare('INSERT INTO ticket_categories (id, workspace_id, name, sort_order) VALUES (?,?,?,?)').run(id, req.workspaceId, name, nextOrder);
  logAudit(req, { action: 'ticket_category.create', entityType: 'ticket_category', entityId: id, entityLabel: name });
  res.status(201).json({ categories: listTaxonomy(req.workspaceId, { includeInactive: true }) });
});

function ownedCategory(id, workspaceId) {
  return db.prepare('SELECT * FROM ticket_categories WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
}

router.patch('/:id', (req, res) => {
  const category = ownedCategory(req.params.id, req.workspaceId);
  if (!category) return res.status(404).json({ error: 'Not found' });

  const { name, active, sort_order } = req.body || {};
  const nextName = name !== undefined ? String(name).trim() : category.name;
  if (!nextName) return res.status(400).json({ error: 'Name cannot be empty' });
  if (nextName !== category.name) {
    const clash = db.prepare('SELECT 1 FROM ticket_categories WHERE workspace_id = ? AND name = ? AND id != ?').get(req.workspaceId, nextName, category.id);
    if (clash) return res.status(400).json({ error: 'A category with that name already exists' });
    // Tickets store the category *name*, not its id (it is a reportable
    // value that must survive the row being deleted), so a rename has to
    // carry existing tickets with it or they would silently fall out of the
    // taxonomy.
    db.prepare('UPDATE tickets SET category = ? WHERE workspace_id = ? AND category = ?').run(nextName, req.workspaceId, category.name);
  }

  db.prepare('UPDATE ticket_categories SET name = ?, active = ?, sort_order = ? WHERE id = ?').run(
    nextName,
    active !== undefined ? (active ? 1 : 0) : category.active,
    sort_order !== undefined ? Number(sort_order) || 0 : category.sort_order,
    category.id
  );
  logAudit(req, { action: 'ticket_category.update', entityType: 'ticket_category', entityId: category.id, entityLabel: nextName });
  res.json({ categories: listTaxonomy(req.workspaceId, { includeInactive: true }) });
});

// Deactivate rather than delete when tickets still reference it: the name
// lives on those rows, and a hard delete would leave them pointing at a
// category that no longer exists anywhere.
router.delete('/:id', (req, res) => {
  const category = ownedCategory(req.params.id, req.workspaceId);
  if (!category) return res.status(404).json({ error: 'Not found' });

  const { c } = db.prepare('SELECT COUNT(*) c FROM tickets WHERE workspace_id = ? AND category = ?').get(req.workspaceId, category.name);
  if (c > 0) {
    db.prepare('UPDATE ticket_categories SET active = 0 WHERE id = ?').run(category.id);
    logAudit(req, { action: 'ticket_category.deactivate', entityType: 'ticket_category', entityId: category.id, entityLabel: category.name, details: { tickets: c } });
    return res.json({ deactivated: true, tickets: c, categories: listTaxonomy(req.workspaceId, { includeInactive: true }) });
  }
  db.prepare('DELETE FROM ticket_categories WHERE id = ?').run(category.id);
  logAudit(req, { action: 'ticket_category.delete', entityType: 'ticket_category', entityId: category.id, entityLabel: category.name });
  res.json({ deactivated: false, categories: listTaxonomy(req.workspaceId, { includeInactive: true }) });
});

router.post('/:id/subcategories', (req, res) => {
  const category = ownedCategory(req.params.id, req.workspaceId);
  if (!category) return res.status(404).json({ error: 'Not found' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const clash = db.prepare('SELECT 1 FROM ticket_subcategories WHERE category_id = ? AND name = ?').get(category.id, name);
  if (clash) return res.status(400).json({ error: 'That subcategory already exists here' });

  const nextOrder = (db.prepare('SELECT MAX(sort_order) m FROM ticket_subcategories WHERE category_id = ?').get(category.id).m ?? -1) + 1;
  db.prepare('INSERT INTO ticket_subcategories (id, category_id, name, sort_order) VALUES (?,?,?,?)').run(uid('tsub'), category.id, name, nextOrder);
  logAudit(req, { action: 'ticket_subcategory.create', entityType: 'ticket_category', entityId: category.id, entityLabel: `${category.name} / ${name}` });
  res.status(201).json({ categories: listTaxonomy(req.workspaceId, { includeInactive: true }) });
});

function ownedSubcategory(id, workspaceId) {
  return db.prepare(
    `SELECT s.*, c.workspace_id, c.name AS category_name FROM ticket_subcategories s
     JOIN ticket_categories c ON c.id = s.category_id
     WHERE s.id = ? AND c.workspace_id = ?`
  ).get(id, workspaceId);
}

router.patch('/subcategories/:subId', (req, res) => {
  const sub = ownedSubcategory(req.params.subId, req.workspaceId);
  if (!sub) return res.status(404).json({ error: 'Not found' });

  const { name, active, sort_order } = req.body || {};
  const nextName = name !== undefined ? String(name).trim() : sub.name;
  if (!nextName) return res.status(400).json({ error: 'Name cannot be empty' });
  if (nextName !== sub.name) {
    const clash = db.prepare('SELECT 1 FROM ticket_subcategories WHERE category_id = ? AND name = ? AND id != ?').get(sub.category_id, nextName, sub.id);
    if (clash) return res.status(400).json({ error: 'That subcategory already exists here' });
  }

  db.prepare('UPDATE ticket_subcategories SET name = ?, active = ?, sort_order = ? WHERE id = ?').run(
    nextName,
    active !== undefined ? (active ? 1 : 0) : sub.active,
    sort_order !== undefined ? Number(sort_order) || 0 : sub.sort_order,
    sub.id
  );
  res.json({ categories: listTaxonomy(req.workspaceId, { includeInactive: true }) });
});

router.delete('/subcategories/:subId', (req, res) => {
  const sub = ownedSubcategory(req.params.subId, req.workspaceId);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM ticket_subcategories WHERE id = ?').run(sub.id);
  res.json({ categories: listTaxonomy(req.workspaceId, { includeInactive: true }) });
});

export default router;
