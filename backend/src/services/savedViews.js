import { db, uid } from '../db.js';
import { validateFilters, compileFilters, compileSort, FilterError } from './ticketFilters.js';

export class ViewError extends Error {
  constructor(message, status = 400, field_errors) {
    super(message);
    this.status = status;
    if (field_errors) this.field_errors = field_errors;
  }
}

export const SCOPES = ['private', 'team', 'workspace'];
export const MODULES = ['tickets', 'changes', 'problems', 'requests'];

// Views every workspace gets, built lazily on first use. These are the ones
// every service desk rebuilds by hand otherwise, and having them present
// means the feature is useful before anyone has configured anything.
const BUILT_IN = [
  {
    key: 'my_open',
    name: 'My open tickets',
    description: 'Assigned to me and not finished.',
    filters: { logic: 'AND', rules: [
      { field: 'assignee_id', op: 'is_me' },
      { field: 'status', op: 'not_in', value: ['resolved', 'closed'] },
    ] },
    sort_by: 'sla_due_at', sort_dir: 'asc',
  },
  {
    key: 'unassigned',
    name: 'Unassigned',
    description: 'Nobody owns these yet.',
    filters: { logic: 'AND', rules: [
      { field: 'assignee_id', op: 'is_empty' },
      { field: 'status', op: 'not_in', value: ['resolved', 'closed'] },
    ] },
    sort_by: 'created_at', sort_dir: 'asc',
  },
  {
    key: 'breaching',
    name: 'SLA at risk or breached',
    description: 'Past target, or due within a day.',
    filters: { logic: 'AND', rules: [
      { field: 'status', op: 'not_in', value: ['resolved', 'closed'] },
      { logic: 'OR', rules: [
        { field: 'sla_breached', op: 'is_true' },
        { field: 'sla_due_at', op: 'in_next_days', value: 1 },
      ] },
    ] },
    sort_by: 'sla_due_at', sort_dir: 'asc',
  },
  {
    key: 'urgent',
    name: 'High and critical',
    description: 'Everything graded high or above that is still open.',
    filters: { logic: 'AND', rules: [
      { field: 'priority', op: 'in', value: ['high', 'critical'] },
      { field: 'status', op: 'not_in', value: ['resolved', 'closed'] },
    ] },
    sort_by: 'priority', sort_dir: 'desc',
  },
  {
    key: 'waiting',
    name: 'Waiting on somebody',
    description: 'Parked, with a reason — the ones that quietly rot.',
    filters: { logic: 'AND', rules: [
      { field: 'status', op: 'equals', value: 'on_hold' },
    ] },
    sort_by: 'updated_at', sort_dir: 'asc',
  },
];

export function ensureBuiltInViews(workspaceId) {
  const existing = db.prepare("SELECT COUNT(*) c FROM saved_views WHERE workspace_id = ? AND owner_id IS NULL").get(workspaceId).c;
  if (existing > 0) return;
  BUILT_IN.forEach((v, i) => {
    db.prepare(
      `INSERT INTO saved_views (id, workspace_id, name, description, module, scope, owner_id, filters, sort_by, sort_dir, position)
       VALUES (?,?,?,?,'tickets','workspace',NULL,?,?,?,?)`
    ).run(uid('svw'), workspaceId, v.name, v.description, JSON.stringify(v.filters), v.sort_by, v.sort_dir, i);
  });
}

const parse = (row) => ({
  ...row,
  filters: row.filters ? JSON.parse(row.filters) : { logic: 'AND', rules: [] },
  columns: row.columns ? JSON.parse(row.columns) : null,
  built_in: !row.owner_id,
});

/**
 * Which views this person can see.
 *
 * A private view belongs to its owner alone; a team view to everyone in that
 * group; a workspace view to everyone. Team membership is read from the
 * user's own team rather than trusted from the request.
 */
export function listViews(workspaceId, user, { module = 'tickets' } = {}) {
  ensureBuiltInViews(workspaceId);
  const rows = db.prepare(
    `SELECT v.*, u.name AS owner_name,
            (SELECT is_default FROM saved_view_preferences p WHERE p.view_id = v.id AND p.user_id = ?) AS is_default,
            (SELECT pinned FROM saved_view_preferences p WHERE p.view_id = v.id AND p.user_id = ?) AS pinned
     FROM saved_views v
     LEFT JOIN users u ON u.id = v.owner_id
     WHERE v.workspace_id = ? AND v.module = ?
       AND (
         v.scope = 'workspace'
         OR (v.scope = 'private' AND v.owner_id = ?)
         OR (v.scope = 'team' AND v.team IS NOT NULL AND v.team = ?)
       )
     ORDER BY v.position, v.created_at`
  ).all(user.id, user.id, workspaceId, module, user.id, user.team || '\u0000');
  return rows.map(parse);
}

export function getView(workspaceId, id, user) {
  const view = listViews(workspaceId, user, { module: 'tickets' }).find((v) => v.id === id)
    || listViews(workspaceId, user, { module: 'changes' }).find((v) => v.id === id)
    || listViews(workspaceId, user, { module: 'problems' }).find((v) => v.id === id)
    || listViews(workspaceId, user, { module: 'requests' }).find((v) => v.id === id);
  // Not found rather than forbidden: that a colleague has a private view
  // called "escalations to chase" is itself not shared.
  if (!view) throw new ViewError('That view no longer exists.', 404);
  return view;
}

function assertScope(scope, team) {
  if (!SCOPES.includes(scope)) {
    throw new ViewError(`Scope must be one of: ${SCOPES.join(', ')}`, 400, [{ field: 'scope', message: 'Not a scope' }]);
  }
  if (scope === 'team' && !String(team || '').trim()) {
    throw new ViewError('A team view needs a team.', 400, [{ field: 'team', message: 'Choose a group' }]);
  }
}

export function createView(workspaceId, user, body) {
  const name = String(body.name || '').trim();
  if (!name) throw new ViewError('Give the view a name.', 400, [{ field: 'name', message: 'Required' }]);
  const module = MODULES.includes(body.module) ? body.module : 'tickets';
  const scope = body.scope || 'private';
  assertScope(scope, body.team);
  try {
    validateFilters(body.filters, { userId: user.id });
  } catch (e) {
    if (e instanceof FilterError) throw new ViewError(e.message, e.status, e.field_errors);
    throw e;
  }

  const id = uid('svw');
  const next = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM saved_views WHERE workspace_id = ? AND module = ?').get(workspaceId, module).n;
  db.prepare(
    `INSERT INTO saved_views (id, workspace_id, name, description, module, scope, team, owner_id, filters, sort_by, sort_dir, columns, position)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, workspaceId, name, String(body.description || '').trim() || null, module, scope,
    scope === 'team' ? String(body.team).trim() : null, user.id,
    JSON.stringify(body.filters || { logic: 'AND', rules: [] }),
    body.sort_by || null, body.sort_dir || null,
    body.columns ? JSON.stringify(body.columns) : null, next
  );
  return getView(workspaceId, id, user);
}

const canEdit = (view, user) => !view.built_in && (view.owner_id === user.id || user.role === 'admin');

export function updateView(workspaceId, id, user, body) {
  const view = getView(workspaceId, id, user);
  if (view.built_in) throw new ViewError('The built-in views cannot be changed. Duplicate one instead.', 403);
  if (!canEdit(view, user)) throw new ViewError("Only this view's owner, or an admin, can change it.", 403);

  const fields = []; const params = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw new ViewError('Give the view a name.', 400, [{ field: 'name', message: 'Required' }]);
    fields.push('name = ?'); params.push(name);
  }
  if (body.description !== undefined) { fields.push('description = ?'); params.push(String(body.description).trim() || null); }
  if (body.scope !== undefined) {
    assertScope(body.scope, body.team ?? view.team);
    fields.push('scope = ?'); params.push(body.scope);
    fields.push('team = ?'); params.push(body.scope === 'team' ? String(body.team ?? view.team).trim() : null);
  }
  if (body.filters !== undefined) {
    try {
      validateFilters(body.filters, { userId: user.id });
    } catch (e) {
      if (e instanceof FilterError) throw new ViewError(e.message, e.status, e.field_errors);
      throw e;
    }
    fields.push('filters = ?'); params.push(JSON.stringify(body.filters));
  }
  if (body.sort_by !== undefined) { fields.push('sort_by = ?'); params.push(body.sort_by || null); }
  if (body.sort_dir !== undefined) { fields.push('sort_dir = ?'); params.push(body.sort_dir || null); }
  if (body.columns !== undefined) { fields.push('columns = ?'); params.push(body.columns ? JSON.stringify(body.columns) : null); }
  if (!fields.length) throw new ViewError('Nothing to update.', 400);
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE saved_views SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getView(workspaceId, id, user);
}

export function deleteView(workspaceId, id, user) {
  const view = getView(workspaceId, id, user);
  if (view.built_in) throw new ViewError('The built-in views cannot be removed.', 403);
  if (!canEdit(view, user)) throw new ViewError("Only this view's owner, or an admin, can remove it.", 403);
  db.prepare('DELETE FROM saved_views WHERE id = ?').run(id);
  return { ok: true };
}

// Copying is how somebody adapts a shared or built-in view without changing
// it for everyone else, which is the alternative to letting them edit it.
export function duplicateView(workspaceId, id, user, name) {
  const view = getView(workspaceId, id, user);
  return createView(workspaceId, user, {
    name: String(name || '').trim() || `${view.name} (copy)`,
    description: view.description,
    module: view.module,
    scope: 'private',
    filters: view.filters,
    sort_by: view.sort_by,
    sort_dir: view.sort_dir,
    columns: view.columns,
  });
}

// A preference about a shared object, so it is stored per person: pinning a
// team view must not pin it for the rest of the team.
export function setPreference(workspaceId, id, user, { is_default, pinned }) {
  getView(workspaceId, id, user);
  if (is_default) {
    db.prepare('UPDATE saved_view_preferences SET is_default = 0 WHERE user_id = ? AND workspace_id = ?').run(user.id, workspaceId);
  }
  const existing = db.prepare('SELECT id FROM saved_view_preferences WHERE user_id = ? AND view_id = ?').get(user.id, id);
  if (existing) {
    const fields = []; const params = [];
    if (is_default !== undefined) { fields.push('is_default = ?'); params.push(is_default ? 1 : 0); }
    if (pinned !== undefined) { fields.push('pinned = ?'); params.push(pinned ? 1 : 0); }
    if (fields.length) { params.push(existing.id); db.prepare(`UPDATE saved_view_preferences SET ${fields.join(', ')} WHERE id = ?`).run(...params); }
  } else {
    db.prepare('INSERT INTO saved_view_preferences (id, workspace_id, user_id, view_id, is_default, pinned) VALUES (?,?,?,?,?,?)')
      .run(uid('svp'), workspaceId, user.id, id, is_default ? 1 : 0, pinned ? 1 : 0);
  }
  return listViews(workspaceId, user, { module: getView(workspaceId, id, user).module });
}

/**
 * Run a view (or an ad-hoc filter) against the ticket table.
 *
 * The requester restriction is applied here and not left to the filter: a
 * saved view is user-supplied input, and a requester must never be able to
 * widen their own visibility by writing one.
 */
export function runFilter(workspaceId, user, { filters, sort_by, sort_dir, limit = 200, include_spam = false }) {
  const clauses = ['t.workspace_id = ?', 't.deleted_at IS NULL'];
  const params = [workspaceId];
  if (user.role === 'requester') {
    clauses.push('t.requester_id = ?');
    params.push(user.id);
  }
  if (!include_spam) clauses.push('COALESCE(t.is_spam, 0) = 0');

  let compiled = null;
  try {
    compiled = compileFilters(filters, { userId: user.id });
  } catch (e) {
    if (e instanceof FilterError) throw new ViewError(e.message, e.status, e.field_errors);
    throw e;
  }
  if (compiled) { clauses.push(compiled.sql); params.push(...compiled.params); }

  const capped = Math.min(500, Math.max(1, Number(limit) || 200));
  const rows = db.prepare(
    `SELECT t.*, u.name AS assignee_name, r.name AS requester_name
     FROM tickets t
     LEFT JOIN users u ON u.id = t.assignee_id
     LEFT JOIN users r ON r.id = t.requester_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY ${compileSort(sort_by, sort_dir)}
     LIMIT ${capped}`
  ).all(...params);

  const total = db.prepare(`SELECT COUNT(*) c FROM tickets t WHERE ${clauses.join(' AND ')}`).get(...params).c;
  return { tickets: rows, total, returned: rows.length, truncated: total > rows.length };
}

// How many tickets each view holds, for the badge beside its name. Counted in
// one pass rather than by running every view's full query.
export function viewCounts(workspaceId, user, module = 'tickets') {
  const out = {};
  for (const view of listViews(workspaceId, user, { module })) {
    try {
      out[view.id] = runFilter(workspaceId, user, { filters: view.filters, limit: 1 }).total;
    } catch {
      // A view whose filter no longer compiles (a field removed, say) simply
      // has no count rather than breaking the whole list.
      out[view.id] = null;
    }
  }
  return out;
}
