// Service catalog API.
//
// What changed and why: a request used to be accepted with whatever form data
// the browser posted (no validation at all), every item was visible to
// everyone, approval was a single hard-coded step, and nothing happened after
// the ticket was raised. Each of those is handled in a service so the rule is
// stated once -- see catalogForms.js, catalogItems.js and catalogAnalytics.js.
import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { nextTicketNumber } from '../services/ticketNumbering.js';
import { findSlaPolicy, computeSlaDueDate } from '../services/sla.js';
import { stageForBucket } from '../services/lifecycleEngine.js';
import { notifyUser } from '../services/notifications.js';
import { sendTemplatedEmail } from '../services/emailService.js';
import { logAudit } from '../services/auditLog.js';
import {
  CatalogError, FIELD_TYPES, CONDITION_OPS, validateSubmission, describeSubmission, visibleFields,
} from '../services/catalogForms.js';
import {
  ITEM_STATUSES, APPROVER_TYPES, ASSIGNEE_TYPES,
  getItem, hydrateItem, listItems, createItem, updateItem, deleteItem, isEntitled,
  listEntitlements, addEntitlement, removeEntitlement,
  listApprovalStages, addApprovalStage, updateApprovalStage, deleteApprovalStage, resolveApprovalChain,
  listFulfilmentTasks, addFulfilmentTask, updateFulfilmentTask, deleteFulfilmentTask, createFulfilmentTasks,
} from '../services/catalogItems.js';
import { catalogOverview, itemPerformance, approvalBottlenecks } from '../services/catalogAnalytics.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

function handle(req, res, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CatalogError) {
      return res.status(err.status).json({ error: err.message, ...(err.field_errors ? { field_errors: err.field_errors } : {}) });
    }
    console.error('[catalog]', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

const canManage = (user) => user?.role === 'admin' || !!user?.permissions?.includes('catalog.manage');

// ------------------------------------------------------------------- meta

router.get('/meta', (req, res) => {
  res.json({
    field_types: Object.entries(FIELD_TYPES).map(([key, v]) => ({ key, ...v })),
    condition_ops: Object.entries(CONDITION_OPS).map(([key, v]) => ({ key, ...v })),
    item_statuses: Object.entries(ITEM_STATUSES).map(([key, v]) => ({ key, ...v })),
    approver_types: Object.entries(APPROVER_TYPES).map(([key, v]) => ({ key, ...v })),
    assignee_types: Object.entries(ASSIGNEE_TYPES).map(([key, v]) => ({ key, ...v })),
    can_manage: canManage(req.user),
  });
});

// ------------------------------------------------------------- categories

router.get('/categories', (req, res) => {
  const rows = db.prepare('SELECT * FROM catalog_categories WHERE workspace_id = ? ORDER BY sort_order, name').all(req.workspaceId);
  const counts = new Map(
    db.prepare(
      `SELECT category_id, COUNT(*) c FROM catalog_items
       WHERE workspace_id = ? AND enabled = 1 AND COALESCE(status,'published') = 'published'
       GROUP BY category_id`
    ).all(req.workspaceId).map((r) => [r.category_id, r.c])
  );
  res.json({ categories: rows.map((c) => ({ ...c, item_count: counts.get(c.id) || 0 })) });
});

router.post('/categories', requirePermission('catalog.manage'), (req, res) => {
  const { name, icon = 'Package', description, parent_id: parentId, sort_order: sortOrder = 0 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid('cc');
  db.prepare('INSERT INTO catalog_categories (id, workspace_id, name, icon, description, parent_id, sort_order) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.workspaceId, name, icon, description || null, parentId || null, sortOrder);
  res.status(201).json({ category: db.prepare('SELECT * FROM catalog_categories WHERE id = ?').get(id) });
});

router.patch('/categories/:id', requirePermission('catalog.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM catalog_categories WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const sets = []; const params = [];
  for (const f of ['name', 'icon', 'description', 'parent_id', 'sort_order']) {
    if (req.body[f] === undefined) continue;
    if (f === 'parent_id' && req.body[f] === req.params.id) return res.status(400).json({ error: 'A category cannot be its own parent' });
    sets.push(`${f} = ?`); params.push(req.body[f] === '' ? null : req.body[f]);
  }
  if (!sets.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE catalog_categories SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return res.json({ category: db.prepare('SELECT * FROM catalog_categories WHERE id = ?').get(req.params.id) });
});

router.delete('/categories/:id', requirePermission('catalog.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM catalog_categories WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // Items are unfiled rather than deleted -- losing a catalog item because
  // somebody tidied the categories would be a bad trade.
  const moved = db.prepare('UPDATE catalog_items SET category_id = NULL WHERE category_id = ?').run(req.params.id).changes;
  db.prepare('DELETE FROM catalog_categories WHERE id = ?').run(req.params.id);
  res.json({ ok: true, items_unfiled: moved });
});

// -------------------------------------------------------------- analytics
// Before /items/:id so "analytics" is never read as an item id.

router.get('/analytics/overview', requirePermission('catalog.manage'), (req, res) => {
  res.json(catalogOverview(req.workspaceId, { days: clampDays(req.query.days) }));
});

router.get('/analytics/items', requirePermission('catalog.manage'), (req, res) => {
  res.json({ items: itemPerformance(req.workspaceId, { days: clampDays(req.query.days) }) });
});

router.get('/analytics/approvals', requirePermission('catalog.manage'), (req, res) => {
  res.json(approvalBottlenecks(req.workspaceId, { days: clampDays(req.query.days) }));
});

function clampDays(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 30;
}

// ------------------------------------------------------------------ items

router.get('/items', (req, res) => handle(req, res, () => res.json({
  items: listItems(req.workspaceId, req.user, {
    categoryId: req.query.category_id || null,
    q: req.query.q || null,
    includeUnpublished: req.query.all === '1',
  }),
})));

router.get('/items/:id', (req, res) => handle(req, res, () => {
  const item = getItem(req.workspaceId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });

  const manage = canManage(req.user);
  // Unpublished or un-entitled items read as absent rather than forbidden: a
  // 403 confirms an item exists, which for an entitlement-restricted item is
  // itself a disclosure.
  if (!manage && (item.status !== 'published' || !item.enabled || !isEntitled(req.workspaceId, req.user, item.id))) {
    return res.status(404).json({ error: 'Catalog item not found' });
  }
  return res.json({ item: hydrateItem(req.workspaceId, item, { forAdmin: manage }) });
}));

router.post('/items', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => {
  const item = createItem(req.workspaceId, req.body || {});
  logAudit(req, { action: 'catalog_item.create', entityType: 'catalog_item', entityId: item.id, entityLabel: item.name });
  return res.status(201).json({ item });
}));

router.patch('/items/:id', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => {
  const item = updateItem(req.workspaceId, req.params.id, req.body || {});
  logAudit(req, { action: 'catalog_item.update', entityType: 'catalog_item', entityId: item.id, entityLabel: item.name });
  return res.json({ item });
}));

router.delete('/items/:id', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => {
  const item = getItem(req.workspaceId, req.params.id);
  const result = deleteItem(req.workspaceId, req.params.id);
  logAudit(req, { action: 'catalog_item.delete', entityType: 'catalog_item', entityId: req.params.id, entityLabel: item?.name });
  return res.json(result);
}));

// ------------------------------------------------------- item composition

router.get('/items/:id/entitlements', requirePermission('catalog.manage'), (req, res) => {
  res.json({ entitlements: listEntitlements(req.workspaceId, req.params.id) });
});

router.post('/items/:id/entitlements', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => (
  res.status(201).json(addEntitlement(req.workspaceId, req.params.id, req.body || {}))
)));

router.delete('/entitlements/:id', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => (
  res.json(removeEntitlement(req.workspaceId, req.params.id))
)));

router.get('/items/:id/approval-stages', requirePermission('catalog.manage'), (req, res) => {
  res.json({ stages: listApprovalStages(req.workspaceId, req.params.id) });
});

router.post('/items/:id/approval-stages', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => (
  res.status(201).json({ stage: addApprovalStage(req.workspaceId, req.params.id, req.body || {}) })
)));

router.patch('/approval-stages/:id', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => (
  res.json({ stage: updateApprovalStage(req.workspaceId, req.params.id, req.body || {}) })
)));

router.delete('/approval-stages/:id', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => (
  res.json(deleteApprovalStage(req.workspaceId, req.params.id))
)));

router.get('/items/:id/fulfilment-tasks', requirePermission('catalog.manage'), (req, res) => {
  res.json({ tasks: listFulfilmentTasks(req.workspaceId, req.params.id) });
});

router.post('/items/:id/fulfilment-tasks', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => (
  res.status(201).json({ task: addFulfilmentTask(req.workspaceId, req.params.id, req.body || {}) })
)));

router.patch('/fulfilment-tasks/:id', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => (
  res.json({ task: updateFulfilmentTask(req.workspaceId, req.params.id, req.body || {}) })
)));

router.delete('/fulfilment-tasks/:id', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => (
  res.json(deleteFulfilmentTask(req.workspaceId, req.params.id))
)));

// A dry run of the form rules, so an admin can see which fields a given set
// of answers reveals and what the approval chain would be, without ordering.
router.post('/items/:id/preview', requirePermission('catalog.manage'), (req, res) => handle(req, res, () => {
  const item = getItem(req.workspaceId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });
  const values = req.body?.form_data || {};
  const check = validateSubmission(req.workspaceId, item.form_schema, values);
  const quantity = Math.max(1, parseInt(req.body?.quantity, 10) || 1);
  return res.json({
    visible_fields: visibleFields(item.form_schema, values).map((f) => f.key),
    validation: check,
    cost: item.cost != null ? Number(item.cost) * quantity : null,
    approval_chain: resolveApprovalChain(req.workspaceId, item, {
      values: check.values, cost: item.cost != null ? Number(item.cost) * quantity : null, requester: req.user,
    }),
  });
}));

// ---------------------------------------------------------------- request

router.post('/items/:id/request', (req, res) => handle(req, res, () => {
  const item = getItem(req.workspaceId, req.params.id);
  if (!item) return res.status(404).json({ error: 'Catalog item not found' });

  if (item.status === 'retired' || !item.enabled) {
    return res.status(409).json({ error: 'This item is no longer available to request.' });
  }
  if (item.status === 'draft' && !canManage(req.user)) {
    return res.status(404).json({ error: 'Catalog item not found' });
  }
  if (!isEntitled(req.workspaceId, req.user, item.id)) {
    return res.status(403).json({ error: 'This item is not available to you. Speak to your service desk if you think that is wrong.' });
  }

  // Validated against the item's own schema rather than trusted. Values for
  // fields the requester never saw are discarded, so hiding a question is a
  // real rule and not just a visual one.
  const check = validateSubmission(req.workspaceId, item.form_schema, req.body?.form_data || {});
  if (!check.ok) return res.status(400).json({ error: 'Some answers need attention', field_errors: check.errors });
  const formData = check.values;

  const quantity = Math.max(1, parseInt(req.body?.quantity, 10) || 1);
  if (item.max_quantity && quantity > item.max_quantity) {
    return res.status(400).json({ error: `You can request at most ${item.max_quantity} of this.` });
  }
  const cost = item.cost != null ? Number(item.cost) * quantity : null;

  // Requesting for somebody else, when the item allows it.
  let requestedForId = req.user.id;
  if (req.body?.requested_for_id && req.body.requested_for_id !== req.user.id) {
    if (!item.allow_on_behalf && !canManage(req.user)) {
      return res.status(403).json({ error: 'This item cannot be requested on somebody else’s behalf.' });
    }
    const target = db.prepare(
      `SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id
       WHERE u.id = ? AND wm.workspace_id = ?`
    ).get(req.body.requested_for_id, req.workspaceId);
    if (!target) return res.status(400).json({ error: 'That person is not in this workspace' });
    requestedForId = target.id;
  }

  const chain = resolveApprovalChain(req.workspaceId, item, { values: formData, cost, requester: req.user });
  const needsApproval = chain.length > 0;

  const id = uid('tkt');
  const number = nextTicketNumber(req.workspaceId, 'request');
  const status = needsApproval ? 'pending_approval' : 'open';

  const policy = findSlaPolicy({
    workspaceId: req.workspaceId, type: 'request', priority: item.default_priority,
    category: 'Service Catalog', team: null, title: item.name, source: 'catalog',
  });
  const slaDue = computeSlaDueDate(
    policy?.resolution_minutes ?? { critical: 240, high: 480, medium: 1440, low: 4320 }[item.default_priority] ?? 1440,
    policy?.business_hours_only, new Date(), req.workspaceId,
  );
  const responseDue = computeSlaDueDate(policy?.response_minutes ?? 60, policy?.business_hours_only, new Date(), req.workspaceId);
  // The delivery promise the catalog made, kept separately from the SLA
  // clock: "five working days for a laptop" is a different commitment from
  // "respond within an hour", and reporting on one as if it were the other
  // is how a catalog looks like it is meeting a target it never had.
  const fulfilmentDue = item.delivery_days != null
    ? new Date(Date.now() + Number(item.delivery_days) * 86400000).toISOString().slice(0, 19).replace('T', ' ')
    : null;

  const lifecycleStage = needsApproval ? stageForBucket(req.workspaceId, 'request', 'on_hold')?.key || null : null;
  const description = describeSubmission(req.workspaceId, item.form_schema, formData) || item.description;

  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, status, priority, category,
                          requester_id, requested_for_id, sla_due_at, response_due_at, sla_policy_id, source,
                          catalog_item_id, catalog_form_data, catalog_quantity, catalog_cost, fulfilment_due_at,
                          lifecycle_stage)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, req.workspaceId, number, 'request', quantity > 1 ? `${item.name} (x${quantity})` : item.name,
    description, status, item.default_priority, 'Service Catalog',
    req.user.id, requestedForId, slaDue, responseDue, policy?.id || null, 'catalog',
    item.id, JSON.stringify(formData), quantity, cost, fulfilmentDue, lifecycleStage,
  );
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)')
    .run(uid('h'), id, 'created', `Catalog request: ${item.name}`);
  db.prepare('UPDATE catalog_items SET request_count = COALESCE(request_count,0) + 1 WHERE id = ?').run(item.id);

  if (needsApproval) {
    for (const stage of chain) {
      db.prepare('INSERT INTO approvals (id, ticket_id, approver_id, approver_role, step_order, status) VALUES (?,?,?,?,?,?)')
        .run(uid('apr'), id, stage.approver_id || null, stage.approver_role || null, stage.step_order, 'pending');
    }
    notifyApprovers(req, id, number, item, chain[0]);
  } else {
    // Nothing to approve, so the work starts now.
    createFulfilmentTasks(req.workspaceId, id, item, { values: formData, requester: req.user, createdBy: req.user.id });
  }

  return res.status(201).json({
    ticket: db.prepare('SELECT * FROM tickets WHERE id = ?').get(id),
    approval_chain: chain,
    discarded_fields: check.discarded,
  });
}));

// Only the first stage is notified: telling every approver in a three-stage
// chain at once produces two people being asked for something that is not
// their turn, and they learn to ignore it.
function notifyApprovers(req, ticketId, number, item, stage) {
  const approvers = stage.approver_id
    ? [db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(stage.approver_id)].filter(Boolean)
    : db.prepare(
      `SELECT u.id, u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND wm.role = ? AND wm.active = 1`
    ).all(req.workspaceId, stage.approver_role || 'admin');

  const link = `${req.protocol}://${req.get('host')}/tickets/${ticketId}`;
  for (const a of approvers) {
    notifyUser(a.id, 'Approval requested', `${req.user.name} requested "${item.name}" (${number})`, `/tickets/${ticketId}`, req.workspaceId);
    if (!a.email) continue;
    sendTemplatedEmail(req.workspaceId, 'approval_requested', a.email, {
      'approver.name': a.name, 'requester.name': req.user.name,
      'ticket.number': number, 'ticket.title': item.name, 'ticket.link': link,
    }).catch((e) => console.error('approval requested email error', e));
  }
}

export default router;
