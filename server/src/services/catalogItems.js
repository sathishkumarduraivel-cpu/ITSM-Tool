// Catalog items: what exists, who may request it, and what happens when
// somebody does.
//
// The three parts that were missing and are the reason this file exists:
// entitlement (not everyone should see everything), a real approval chain
// (one hard-coded step was never going to be enough), and fulfilment tasks
// (a request that becomes a ticket and no work is a request nobody actions).
import { db, uid } from '../db.js';
import { CatalogError, parseSchema, validateSchema, evaluateCondition } from './catalogForms.js';

export const ITEM_STATUSES = {
  draft: { label: 'Draft', description: 'Being set up. Not orderable.' },
  published: { label: 'Published', description: 'Live in the catalog, subject to entitlement.' },
  retired: { label: 'Retired', description: 'Withdrawn. Existing requests are unaffected.' },
};

export const APPROVER_TYPES = {
  role: { label: 'Anyone with a role', hint: 'Any admin or agent in the workspace.' },
  user: { label: 'A named person', hint: 'One specific approver.' },
  group_manager: { label: "A team's manager", hint: 'The manager set on the chosen team.' },
  requester_manager: { label: "The requester's manager", hint: 'Taken from the requester’s workspace membership.' },
};

export const ASSIGNEE_TYPES = {
  group: { label: 'A team' },
  user: { label: 'A named person' },
  requester_manager: { label: "The requester's manager" },
  unassigned: { label: 'Leave unassigned' },
};

// ------------------------------------------------------------ entitlement

/**
 * Can this person request this item.
 *
 * An item with no entitlement rows is open to everyone, which is what every
 * existing item is -- so adding this changes nothing until somebody sets a
 * rule. Rules are OR-ed: being in any one permitted group is enough.
 */
export function isEntitled(workspaceId, user, itemId) {
  const rules = db.prepare('SELECT rule_type, rule_value FROM catalog_entitlements WHERE item_id = ? AND workspace_id = ?')
    .all(itemId, workspaceId);
  if (!rules.length) return true;
  // Whoever maintains the catalog can always see all of it, or they could
  // not test what they just configured.
  if (user?.role === 'admin' || user?.permissions?.includes('catalog.manage')) return true;

  for (const rule of rules) {
    if (rule.rule_type === 'role' && user?.role === rule.rule_value) return true;
    if (rule.rule_type === 'department') {
      const dept = db.prepare('SELECT team FROM users WHERE id = ?').get(user?.id)?.team;
      if (dept && dept === rule.rule_value) return true;
    }
    if (rule.rule_type === 'group') {
      const member = db.prepare('SELECT 1 x FROM group_members WHERE group_id = ? AND user_id = ?')
        .get(rule.rule_value, user?.id);
      if (member) return true;
    }
  }
  return false;
}

// The same rule as SQL, so a list and a single fetch cannot disagree.
function entitlementFilter(workspaceId, user, items) {
  if (user?.role === 'admin' || user?.permissions?.includes('catalog.manage')) return items;

  const ruled = new Set(
    db.prepare('SELECT DISTINCT item_id FROM catalog_entitlements WHERE workspace_id = ?').all(workspaceId).map((r) => r.item_id)
  );
  if (!ruled.size) return items;
  return items.filter((i) => !ruled.has(i.id) || isEntitled(workspaceId, user, i.id));
}

export function listEntitlements(workspaceId, itemId) {
  return db.prepare(
    `SELECT e.*, g.name AS group_name FROM catalog_entitlements e
     LEFT JOIN groups g ON g.id = e.rule_value AND e.rule_type = 'group'
     WHERE e.item_id = ? AND e.workspace_id = ? ORDER BY e.rule_type, e.rule_value`
  ).all(itemId, workspaceId);
}

export function addEntitlement(workspaceId, itemId, { rule_type: type, rule_value: value }) {
  if (!['group', 'role', 'department'].includes(type)) throw new CatalogError(`Unknown rule type: ${type}`);
  if (!value) throw new CatalogError('A value is required');
  if (type === 'group' && !db.prepare('SELECT id FROM groups WHERE id = ? AND workspace_id = ?').get(value, workspaceId)) {
    throw new CatalogError('That team does not exist', 404);
  }
  const existing = db.prepare('SELECT id FROM catalog_entitlements WHERE item_id = ? AND rule_type = ? AND rule_value = ?')
    .get(itemId, type, value);
  if (existing) return { ok: true, already: true };
  db.prepare('INSERT INTO catalog_entitlements (id, workspace_id, item_id, rule_type, rule_value) VALUES (?,?,?,?,?)')
    .run(uid('cent'), workspaceId, itemId, type, value);
  return { ok: true };
}

export function removeEntitlement(workspaceId, id) {
  db.prepare('DELETE FROM catalog_entitlements WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  return { ok: true };
}

// ------------------------------------------------------------------ items

export function getItem(workspaceId, id) {
  return db.prepare('SELECT * FROM catalog_items WHERE id = ? AND workspace_id = ?').get(id, workspaceId) || null;
}

export function hydrateItem(workspaceId, item, { forAdmin = false } = {}) {
  if (!item) return null;
  const base = {
    ...item,
    form_schema: parseSchema(item.form_schema),
    status_meta: ITEM_STATUSES[item.status] || null,
    category: item.category_id
      ? db.prepare('SELECT id, name, icon FROM catalog_categories WHERE id = ?').get(item.category_id)
      : null,
    tag_list: item.tags ? String(item.tags).split(',').map((t) => t.trim()).filter(Boolean) : [],
  };
  if (!forAdmin) return base;
  return {
    ...base,
    entitlements: listEntitlements(workspaceId, item.id),
    approval_stages: listApprovalStages(workspaceId, item.id),
    fulfilment_tasks: listFulfilmentTasks(workspaceId, item.id),
  };
}

/**
 * The catalog as this person sees it.
 *
 * Drafts and retired items are hidden from requesters outright; entitlement
 * then filters what remains. Both happen here rather than in the route so
 * every caller gets the same answer.
 */
export function listItems(workspaceId, user, { categoryId = null, q = null, includeUnpublished = false } = {}) {
  const canManage = user?.role === 'admin' || user?.permissions?.includes('catalog.manage');
  let sql = 'SELECT * FROM catalog_items WHERE workspace_id = ?';
  const params = [workspaceId];

  if (!(includeUnpublished && canManage)) {
    sql += " AND enabled = 1 AND COALESCE(status, 'published') = 'published'";
  }
  if (categoryId) { sql += ' AND category_id = ?'; params.push(categoryId); }
  if (q) { sql += ' AND (name LIKE ? OR description LIKE ? OR short_description LIKE ? OR tags LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY sort_order, request_count DESC, name';

  const rows = db.prepare(sql).all(...params);
  return entitlementFilter(workspaceId, user, rows).map((i) => hydrateItem(workspaceId, i));
}

const EDITABLE = [
  'name', 'description', 'short_description', 'category_id', 'icon', 'form_schema',
  'approval_required', 'approver_type', 'approver_role', 'approver_id', 'approver_group_id',
  'default_priority', 'price', 'cost', 'currency', 'cost_centre', 'delivery_days',
  'max_quantity', 'allow_on_behalf', 'fulfilment_group_id', 'tags', 'status', 'enabled',
  'sort_order', 'allow_attachments', 'require_attachment',
];

function validateItem(workspaceId, body, { partial = false } = {}) {
  const errors = [];
  if (!partial || body.name !== undefined) {
    if (!String(body.name || '').trim()) errors.push({ field: 'name', message: 'A name is required' });
  }
  if (body.status !== undefined && !ITEM_STATUSES[body.status]) {
    errors.push({ field: 'status', message: `Unknown status: ${body.status}` });
  }
  if (body.form_schema !== undefined) {
    for (const message of validateSchema(body.form_schema)) errors.push({ field: 'form_schema', message });
  }
  if (body.category_id) {
    const cat = db.prepare('SELECT id FROM catalog_categories WHERE id = ? AND workspace_id = ?').get(body.category_id, workspaceId);
    if (!cat) errors.push({ field: 'category_id', message: 'That category does not exist' });
  }
  for (const numeric of ['cost', 'price', 'delivery_days']) {
    if (body[numeric] === undefined || body[numeric] === null || body[numeric] === '') continue;
    if (!Number.isFinite(Number(body[numeric])) || Number(body[numeric]) < 0) {
      errors.push({ field: numeric, message: `${numeric.replace('_', ' ')} must be a number that is not negative` });
    }
  }
  if (body.max_quantity !== undefined && body.max_quantity !== null && body.max_quantity !== '') {
    const n = Number(body.max_quantity);
    if (!Number.isInteger(n) || n < 1) errors.push({ field: 'max_quantity', message: 'Maximum quantity must be a whole number of at least 1' });
  }
  return errors;
}

export function createItem(workspaceId, body) {
  const errors = validateItem(workspaceId, body);
  if (errors.length) throw Object.assign(new CatalogError('Some fields need attention'), { field_errors: errors });

  const id = uid('cat');
  const cols = ['id', 'workspace_id'];
  const vals = [id, workspaceId];
  for (const field of EDITABLE) {
    if (body[field] === undefined) continue;
    cols.push(field);
    vals.push(normalize(field, body[field]));
  }
  // A brand new item is a draft: nothing half-configured should be orderable
  // the moment it is saved.
  if (!cols.includes('status')) { cols.push('status'); vals.push('draft'); }

  db.prepare(`INSERT INTO catalog_items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...vals);
  return hydrateItem(workspaceId, getItem(workspaceId, id), { forAdmin: true });
}

export function updateItem(workspaceId, id, body) {
  const item = getItem(workspaceId, id);
  if (!item) throw new CatalogError('Catalog item not found', 404);
  const errors = validateItem(workspaceId, body, { partial: true });
  if (errors.length) throw Object.assign(new CatalogError('Some fields need attention'), { field_errors: errors });

  const sets = []; const params = [];
  for (const field of EDITABLE) {
    if (body[field] === undefined) continue;
    sets.push(`${field} = ?`); params.push(normalize(field, body[field]));
  }
  if (!sets.length) return hydrateItem(workspaceId, item, { forAdmin: true });
  params.push(id);
  db.prepare(`UPDATE catalog_items SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return hydrateItem(workspaceId, getItem(workspaceId, id), { forAdmin: true });
}

function normalize(field, value) {
  if (field === 'form_schema') return JSON.stringify(parseSchema(value));
  if (['approval_required', 'enabled', 'allow_on_behalf', 'allow_attachments', 'require_attachment'].includes(field)) {
    return value ? 1 : 0;
  }
  if (value === '') return null;
  return value;
}

export function deleteItem(workspaceId, id) {
  const item = getItem(workspaceId, id);
  if (!item) throw new CatalogError('Catalog item not found', 404);
  const requests = db.prepare('SELECT COUNT(*) c FROM tickets WHERE catalog_item_id = ?').get(id).c;
  // Deleting an item that has been ordered would orphan the history of what
  // people actually asked for. Retiring keeps it out of the catalog and
  // leaves the record intact.
  if (requests > 0) {
    throw new CatalogError(`${requests} request(s) have been raised for this item. Retire it instead of deleting it.`);
  }
  db.prepare('DELETE FROM catalog_items WHERE id = ?').run(id);
  return { ok: true };
}

// -------------------------------------------------------- approval stages

export function listApprovalStages(workspaceId, itemId) {
  return db.prepare(
    `SELECT s.*, u.name AS approver_name, g.name AS approver_group_name
     FROM catalog_approval_stages s
     LEFT JOIN users u ON u.id = s.approver_id
     LEFT JOIN groups g ON g.id = s.approver_group_id
     WHERE s.item_id = ? AND s.workspace_id = ? ORDER BY s.step_order, s.rowid`
  ).all(itemId, workspaceId);
}

export function addApprovalStage(workspaceId, itemId, body) {
  if (!getItem(workspaceId, itemId)) throw new CatalogError('Catalog item not found', 404);
  if (!body.name) throw new CatalogError('A stage name is required');
  const type = body.approver_type || 'role';
  if (!APPROVER_TYPES[type]) throw new CatalogError(`Unknown approver type: ${type}`);
  if (type === 'user' && !body.approver_id) throw new CatalogError('Choose who approves this stage');
  if (type === 'group_manager' && !body.approver_group_id) throw new CatalogError('Choose which team’s manager approves this stage');

  const { max } = db.prepare('SELECT COALESCE(MAX(step_order),0) max FROM catalog_approval_stages WHERE item_id = ?').get(itemId);
  const id = uid('cas');
  db.prepare(
    `INSERT INTO catalog_approval_stages (id, workspace_id, item_id, name, step_order, approver_type,
                                          approver_role, approver_id, approver_group_id,
                                          condition_field, condition_op, condition_value, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`
  ).run(
    id, workspaceId, itemId, body.name, body.step_order ?? max + 1, type,
    body.approver_role || (type === 'role' ? 'admin' : null), body.approver_id || null, body.approver_group_id || null,
    body.condition_field || null, body.condition_op || null, body.condition_value ?? null,
  );
  return db.prepare('SELECT * FROM catalog_approval_stages WHERE id = ?').get(id);
}

export function updateApprovalStage(workspaceId, id, body) {
  const stage = db.prepare('SELECT * FROM catalog_approval_stages WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!stage) throw new CatalogError('Stage not found', 404);
  const fields = ['name', 'step_order', 'approver_type', 'approver_role', 'approver_id', 'approver_group_id',
    'condition_field', 'condition_op', 'condition_value', 'enabled'];
  const sets = []; const params = [];
  for (const f of fields) {
    if (body[f] === undefined) continue;
    sets.push(`${f} = ?`); params.push(f === 'enabled' ? (body[f] ? 1 : 0) : (body[f] === '' ? null : body[f]));
  }
  if (!sets.length) return stage;
  params.push(id);
  db.prepare(`UPDATE catalog_approval_stages SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM catalog_approval_stages WHERE id = ?').get(id);
}

export function deleteApprovalStage(workspaceId, id) {
  db.prepare('DELETE FROM catalog_approval_stages WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  return { ok: true };
}

/**
 * The approval chain for one particular request.
 *
 * Stages whose condition does not hold are dropped, so "over 500 also needs
 * the budget holder" costs nothing on a cheap request. Resolved per request
 * rather than stored, because the answer depends on what was submitted.
 */
export function resolveApprovalChain(workspaceId, item, { values = {}, cost = null, requester = null } = {}) {
  const allStages = listApprovalStages(workspaceId, item.id);

  // The fallback to the item's own single approver applies only when NO
  // stages have ever been configured, so items set up before staged approval
  // existed keep working.
  //
  // Deliberately not "no stages are currently active": once somebody has
  // built a chain, disabling every stage in it means they want no approval.
  // Quietly reinstating a legacy approver they may not know exists would be
  // the opposite of what they just asked for.
  if (!allStages.length) {
    if (!item.approval_required) return [];
    return [{ name: 'Approval', step_order: 1, ...resolveLegacyApprover(item) }];
  }

  const stages = allStages.filter((s) => s.enabled);

  const context = { ...values, _cost: cost };
  return stages
    .filter((s) => !s.condition_field || evaluateCondition(
      { field: s.condition_field, op: s.condition_op || 'equals', value: s.condition_value }, context,
    ))
    .map((s, i) => ({
      name: s.name,
      step_order: i + 1,
      ...resolveStageApprover(workspaceId, s, requester),
    }))
    .filter((s) => s.approver_id || s.approver_role);
}

function resolveLegacyApprover(item) {
  if (item.approver_type === 'user' && item.approver_id) return { approver_id: item.approver_id, approver_role: null };
  return { approver_id: null, approver_role: item.approver_role || 'admin' };
}

// Every branch that cannot find a person falls back to approver_role='admin'
// rather than returning nothing. A stage that silently disappears because
// nobody set a manager is a request skipping an approval it was supposed to
// have -- the same reasoning the original resolveApprover applied, kept.
function resolveStageApprover(workspaceId, stage, requester) {
  if (stage.approver_type === 'user' && stage.approver_id) {
    return { approver_id: stage.approver_id, approver_role: null };
  }
  if (stage.approver_type === 'group_manager' && stage.approver_group_id) {
    const group = db.prepare('SELECT manager_user_id FROM groups WHERE id = ? AND workspace_id = ?')
      .get(stage.approver_group_id, workspaceId);
    if (group?.manager_user_id) return { approver_id: group.manager_user_id, approver_role: null };
  }
  if (stage.approver_type === 'requester_manager') {
    // The manager lives on workspace_members, not users: somebody can report
    // to different people in different workspaces.
    const managerId = db.prepare('SELECT manager_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, requester?.id)?.manager_id;
    if (managerId) return { approver_id: managerId, approver_role: null };
  }
  return { approver_id: null, approver_role: stage.approver_role || 'admin' };
}

// ------------------------------------------------------- fulfilment tasks

export function listFulfilmentTasks(workspaceId, itemId) {
  return db.prepare(
    `SELECT t.*, u.name AS assignee_name, g.name AS assignee_group_name
     FROM catalog_fulfilment_tasks t
     LEFT JOIN users u ON u.id = t.assignee_id
     LEFT JOIN groups g ON g.id = t.assignee_group_id
     WHERE t.item_id = ? AND t.workspace_id = ? ORDER BY t.sort_order, t.rowid`
  ).all(itemId, workspaceId);
}

export function addFulfilmentTask(workspaceId, itemId, body) {
  if (!getItem(workspaceId, itemId)) throw new CatalogError('Catalog item not found', 404);
  if (!body.title) throw new CatalogError('A task title is required');
  const type = body.assignee_type || 'group';
  if (!ASSIGNEE_TYPES[type]) throw new CatalogError(`Unknown assignee type: ${type}`);

  const { max } = db.prepare('SELECT COALESCE(MAX(sort_order),0) max FROM catalog_fulfilment_tasks WHERE item_id = ?').get(itemId);
  const id = uid('cft');
  db.prepare(
    `INSERT INTO catalog_fulfilment_tasks (id, workspace_id, item_id, title, description, sort_order,
                                           assignee_type, assignee_id, assignee_group_id, due_offset_days,
                                           sequential, condition_field, condition_op, condition_value, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
  ).run(
    id, workspaceId, itemId, body.title, body.description || null, body.sort_order ?? max + 10,
    type, body.assignee_id || null, body.assignee_group_id || null, body.due_offset_days ?? null,
    body.sequential === false || body.sequential === 0 ? 0 : 1,
    body.condition_field || null, body.condition_op || null, body.condition_value ?? null,
  );
  return db.prepare('SELECT * FROM catalog_fulfilment_tasks WHERE id = ?').get(id);
}

export function updateFulfilmentTask(workspaceId, id, body) {
  const task = db.prepare('SELECT * FROM catalog_fulfilment_tasks WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!task) throw new CatalogError('Task not found', 404);
  const fields = ['title', 'description', 'sort_order', 'assignee_type', 'assignee_id', 'assignee_group_id',
    'due_offset_days', 'sequential', 'condition_field', 'condition_op', 'condition_value', 'enabled'];
  const sets = []; const params = [];
  for (const f of fields) {
    if (body[f] === undefined) continue;
    sets.push(`${f} = ?`);
    params.push(['sequential', 'enabled'].includes(f) ? (body[f] ? 1 : 0) : (body[f] === '' ? null : body[f]));
  }
  if (!sets.length) return task;
  params.push(id);
  db.prepare(`UPDATE catalog_fulfilment_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM catalog_fulfilment_tasks WHERE id = ?').get(id);
}

export function deleteFulfilmentTask(workspaceId, id) {
  db.prepare('DELETE FROM catalog_fulfilment_tasks WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
  return { ok: true };
}

/**
 * Turn the item's task templates into real tasks on a ticket.
 *
 * Called once the request is actually going ahead -- after approval, or
 * immediately when none is needed. Sequential tasks are chained through
 * depends_on_task_id so the person fulfilling sees what is ready now rather
 * than a flat list of eight things.
 */
export function createFulfilmentTasks(workspaceId, ticketId, item, { values = {}, requester = null, createdBy = null } = {}) {
  const templates = listFulfilmentTasks(workspaceId, item.id).filter((t) => t.enabled);
  if (!templates.length) return [];

  const applicable = templates.filter((t) => !t.condition_field || evaluateCondition(
    { field: t.condition_field, op: t.condition_op || 'equals', value: t.condition_value }, values,
  ));
  if (!applicable.length) return [];

  const created = [];
  let previousId = null;

  db.exec('BEGIN');
  try {
    applicable.forEach((t, i) => {
      const id = uid('tsk');
      const assignee = resolveTaskAssignee(workspaceId, t, requester);
      const due = t.due_offset_days != null
        ? new Date(Date.now() + Number(t.due_offset_days) * 86400000).toISOString().slice(0, 10)
        : null;

      db.prepare(
        `INSERT INTO ticket_tasks (id, ticket_id, workspace_id, title, description, status, assignee_id,
                                   due_date, sort_order, depends_on_task_id, created_by)
         VALUES (?,?,?,?,?,'open',?,?,?,?,?)`
      ).run(
        id, ticketId, workspaceId, t.title, t.description || null, assignee,
        due, i * 10, t.sequential ? previousId : null, createdBy,
      );
      created.push(id);
      previousId = id;
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return created;
}

function resolveTaskAssignee(workspaceId, template, requester) {
  if (template.assignee_type === 'user') return template.assignee_id || null;
  if (template.assignee_type === 'requester_manager') {
    return db.prepare('SELECT manager_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
      .get(workspaceId, requester?.id)?.manager_id || null;
  }
  if (template.assignee_type === 'group') {
    // ticket_tasks assigns to one person, so a team task goes to that team's
    // manager, or its first member if none is set. Better than unassigned,
    // which in practice nobody ever picks up.
    const group = db.prepare('SELECT manager_user_id FROM groups WHERE id = ? AND workspace_id = ?')
      .get(template.assignee_group_id, workspaceId);
    if (group?.manager_user_id) return group.manager_user_id;
    return db.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY rowid LIMIT 1')
      .get(template.assignee_group_id)?.user_id || null;
  }
  return null;
}
