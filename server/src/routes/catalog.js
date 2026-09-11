import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { notifyUser } from '../services/notifications.js';
import { nextTicketNumber } from '../services/ticketNumbering.js';
import { logAudit } from '../services/auditLog.js';
import { stageForBucket } from '../services/lifecycleEngine.js';
import { findSlaPolicy, computeSlaDueDate } from '../services/sla.js';
import { sendTemplatedEmail } from '../services/emailService.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

// Same 4-operator vocabulary as Business Rules / the automation engine's
// condition nodes (equals/not_equals/contains/in), so there's one condition
// language across the app rather than a catalog-specific one -- used for a
// form_schema field's optional `show_if: { field, op, value }`.
function matchShowIf(actual, op, expected) {
  const a = actual === undefined || actual === null ? '' : actual;
  switch (op) {
    case 'equals': return String(a) === String(expected ?? '');
    case 'not_equals': return String(a) !== String(expected ?? '');
    case 'contains': return String(a).toLowerCase().includes(String(expected || '').toLowerCase());
    case 'in': return String(expected || '').split(',').map((s) => s.trim().toLowerCase()).includes(String(a).toLowerCase());
    default: return true;
  }
}

// A field hidden by its own show_if can't legitimately carry a value -- a
// direct API call (bypassing the form UI) could still send one, so this is
// re-evaluated server-side rather than trusted from the client, same
// "hiding a field deletes its value for real" principle Business Rules
// already applies to the main ticket form (routes/tickets.js).
function stripHiddenFieldValues(formSchema, formData) {
  const cleaned = { ...formData };
  for (const field of formSchema) {
    if (!field.show_if) continue;
    if (!matchShowIf(cleaned[field.show_if.field], field.show_if.op, field.show_if.value)) {
      delete cleaned[field.key];
    }
  }
  return cleaned;
}

// Resolves who a catalog item's approval goes to. 'group_manager' falls back
// to approver_role='admin' if the chosen group has no manager set, rather
// than silently creating an approval nobody can ever see/decide.
function resolveApprover(item) {
  if (item.approver_type === 'user' && item.approver_id) {
    return { approver_id: item.approver_id, approver_role: null };
  }
  if (item.approver_type === 'group_manager' && item.approver_group_id) {
    const group = db.prepare('SELECT manager_user_id FROM groups WHERE id = ?').get(item.approver_group_id);
    if (group?.manager_user_id) return { approver_id: group.manager_user_id, approver_role: null };
  }
  return { approver_id: null, approver_role: item.approver_role || 'admin' };
}

// ---- Categories ----
router.get('/categories', (req, res) => {
  res.json({ categories: db.prepare('SELECT * FROM catalog_categories WHERE workspace_id = ? ORDER BY sort_order, name').all(req.workspaceId) });
});

router.post('/categories', requirePermission('catalog.manage'), (req, res) => {
  const { name, icon = 'Package', sort_order = 0 } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid('cat');
  db.prepare('INSERT INTO catalog_categories (id, workspace_id, name, icon, sort_order) VALUES (?,?,?,?,?)').run(id, req.workspaceId, name, icon, sort_order);
  logAudit(req, { action: 'catalog_category.created', entityType: 'catalog_category', entityId: id, entityLabel: name });
  res.status(201).json({ id });
});

router.patch('/categories/:id', requirePermission('catalog.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM catalog_categories WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['name', 'icon', 'sort_order'];
  const fields = []; const params = [];
  for (const key of allowed) if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE catalog_categories SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'catalog_category.updated', entityType: 'catalog_category', entityId: req.params.id, entityLabel: row.name, details: req.body });
  res.json({ ok: true });
});

router.delete('/categories/:id', requirePermission('catalog.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM catalog_categories WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM catalog_categories WHERE id = ?').run(req.params.id);
  logAudit(req, { action: 'catalog_category.deleted', entityType: 'catalog_category', entityId: req.params.id, entityLabel: row.name });
  res.json({ ok: true });
});

// ---- Items ----
router.get('/items', (req, res) => {
  const { category_id } = req.query;
  let sql = 'SELECT * FROM catalog_items WHERE workspace_id = ? AND enabled = 1';
  const params = [req.workspaceId];
  if (category_id) { sql += ' AND category_id = ?'; params.push(category_id); }
  sql += ' ORDER BY created_at DESC';
  const items = db.prepare(sql).all(...params).map((i) => ({ ...i, form_schema: JSON.parse(i.form_schema || '[]') }));
  res.json({ items });
});

router.post('/items', requirePermission('catalog.manage'), (req, res) => {
  const {
    category_id, name, description, icon = 'Package', form_schema = [], approval_required = true, approver_role = 'admin',
    approver_type = 'role', approver_id, approver_group_id,
    default_priority = 'medium', price, allow_attachments = true, require_attachment = false,
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid('itm');
  db.prepare(
    `INSERT INTO catalog_items (id, workspace_id, category_id, name, description, icon, form_schema, approval_required, approver_role, approver_type, approver_id, approver_group_id, default_priority, price, allow_attachments, require_attachment)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, req.workspaceId, category_id || null, name, description || '', icon, JSON.stringify(form_schema), approval_required ? 1 : 0, approver_role,
    approver_type, approver_id || null, approver_group_id || null, default_priority, price || null,
    allow_attachments ? 1 : 0, require_attachment ? 1 : 0
  );
  logAudit(req, { action: 'catalog_item.created', entityType: 'catalog_item', entityId: id, entityLabel: name });
  res.status(201).json({ id });
});

router.patch('/items/:id', requirePermission('catalog.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM catalog_items WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['category_id', 'name', 'description', 'icon', 'approval_required', 'approver_role', 'approver_type', 'approver_id', 'approver_group_id', 'default_priority', 'price', 'enabled', 'allow_attachments', 'require_attachment'];
  const fields = []; const params = [];
  for (const key of allowed) if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : req.body[key]); }
  if (req.body.form_schema !== undefined) { fields.push('form_schema = ?'); params.push(JSON.stringify(req.body.form_schema)); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE catalog_items SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'catalog_item.updated', entityType: 'catalog_item', entityId: req.params.id, entityLabel: row.name, details: { name: req.body.name, enabled: req.body.enabled, approval_required: req.body.approval_required } });
  res.json({ ok: true });
});

router.delete('/items/:id', requirePermission('catalog.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM catalog_items WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM catalog_items WHERE id = ?').run(req.params.id);
  logAudit(req, { action: 'catalog_item.deleted', entityType: 'catalog_item', entityId: req.params.id, entityLabel: row.name });
  res.json({ ok: true });
});

// ---- Submit a catalog request -> creates a ticket (+ approval chain if required) ----
router.post('/items/:id/request', (req, res) => {
  const item = db.prepare('SELECT * FROM catalog_items WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });
  const formSchema = JSON.parse(item.form_schema || '[]');
  const form_data = stripHiddenFieldValues(formSchema, req.body.form_data || {});

  const id = uid('tkt');
  const number = nextTicketNumber(req.workspaceId, 'request');
  const needsApproval = !!item.approval_required;
  const status = needsApproval ? 'pending_approval' : 'open';
  // Same real SLA-policy match tickets.js's own POST /tickets uses (falling
  // back to the same defaults) -- was previously a catalog-only hardcoded
  // resolution-time map with no response_due_at at all, which meant every
  // catalog-submitted request silently never appeared in SLA "at risk"
  // views or first-response-SLA reporting no matter how long it sat unanswered.
  const policy = findSlaPolicy({ workspaceId: req.workspaceId, type: 'request', priority: item.default_priority, category: 'Service Catalog', team: null, title: item.name, source: 'catalog' });
  const sla_due_at = computeSlaDueDate(policy?.resolution_minutes ?? { critical: 240, high: 480, medium: 1440, low: 4320 }[item.default_priority] ?? 1440, policy?.business_hours_only, new Date(), req.workspaceId);
  const response_due_at = computeSlaDueDate(policy?.response_minutes ?? 60, policy?.business_hours_only, new Date(), req.workspaceId);
  // If Request has an active lifecycle with a 'Pending Approval' stage
  // (LIFECYCLE_TEMPLATES.request), start there instead of the default first
  // stage so the lifecycle view reflects reality from the moment the request
  // is submitted -- resolveTicketAfterApprovalChange moves it on once every
  // approval clears. No lifecycle configured -> stays null exactly as before.
  const lifecycleStage = needsApproval ? stageForBucket(req.workspaceId, 'request', 'on_hold')?.key || null : null;

  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, status, priority, category, requester_id, sla_due_at, response_due_at, sla_policy_id, source, catalog_item_id, catalog_form_data, lifecycle_stage)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, req.workspaceId, number, 'request', item.name,
    Object.entries(form_data).map(([k, v]) => `${k}: ${v}`).join('\n') || item.description,
    status, item.default_priority, 'Service Catalog', req.user.id, sla_due_at, response_due_at, policy?.id || null, 'catalog',
    item.id, JSON.stringify(form_data), lifecycleStage
  );
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), id, 'created', `Catalog request: ${item.name}`);

  if (needsApproval) {
    const { approver_id, approver_role } = resolveApprover(item);
    const approvalId = uid('apr');
    db.prepare(
      'INSERT INTO approvals (id, ticket_id, approver_id, approver_role, step_order, status) VALUES (?,?,?,?,?,?)'
    ).run(approvalId, id, approver_id, approver_role, 1, 'pending');
    const approvers = approver_id
      ? [db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(approver_id)].filter(Boolean)
      // notify anyone with the approver role in this workspace — simplified to all matching-role members for this MVP
      : db.prepare(`SELECT u.id, u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND wm.role = ? AND wm.active = 1`).all(req.workspaceId, approver_role);
    const ticketLink = `${req.protocol}://${req.get('host')}/tickets/${id}`;
    for (const a of approvers) {
      notifyUser(a.id, 'Approval requested', `${req.user.name} requested "${item.name}" (${number})`, `/tickets/${id}`, req.workspaceId);
      if (a.email) {
        sendTemplatedEmail(req.workspaceId, 'approval_requested', a.email, {
          'approver.name': a.name, 'requester.name': req.user.name, 'ticket.number': number, 'ticket.title': item.name, 'ticket.link': ticketLink,
        }).catch((e) => console.error('approval requested email error', e));
      }
    }
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  res.status(201).json({ ticket });
});

export default router;
