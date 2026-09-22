import { Router } from 'express';
import fs from 'node:fs';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole, requirePermission } from '../middleware/auth.js';
import { evaluateAutomations } from '../services/automationEngine.js';
import { getProvider, summarizeTicket, suggestResolution, categorizeTicket, analyzeRootCause } from '../services/aiClient.js';
import { notifyUser, renderTemplate } from '../services/notifications.js';
import { sendTemplatedEmail } from '../services/emailService.js';
import { listTasks, createTask, updateTask, deleteTask, computeTaskAggregates } from '../services/tasks.js';
import { computeSlaDueDate, findSlaPolicy, stampSlaBreach } from '../services/sla.js';
import { nextTicketNumber } from '../services/ticketNumbering.js';
import { listBusinessRules, applyBusinessRules, buildFieldOptionsMap } from '../services/businessRules.js';
import { listCustomFields, normalizeCustomValues, saveCustomValues, getCustomValues } from '../services/customFields.js';
import { upload } from '../services/uploads.js';
import { computeBlastRadius } from '../services/blastRadius.js';
import { getLifecycle, initialStageFor, describeAvailableTransitions, transitionTicket, stageForBucket } from '../services/lifecycleEngine.js';
import { pushToLinkedConnections, createExternalTicket, linkExistingTicket, pushTicketUpdate, pullTicketUpdate, pushCommentToConnections } from '../services/externalSync.js';
import { evaluateEscalationsSafely } from '../services/escalationEngine.js';
import { autoAssignSafely } from '../services/assignmentEngine.js';
import { reconcileSubcategories, listTaxonomy } from '../services/ticketCategories.js';
import { withComputed } from '../services/majorIncidents.js';
import { broadcastToWorkspace } from '../services/realtime.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

// Soft-deleted tickets (tickets.delete permission, §"itil_admin" persona --
// see routes/tickets.js's DELETE /:id below) are excluded here so every
// route built on getTicket() automatically treats one as gone, the same
// "never hard-delete, just stop showing it" pattern already used for merged
// and spam-marked tickets in this app.
function getTicket(id, workspaceId) {
  return db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL').get(id, workspaceId);
}

function isWatcher(ticketId, userId) {
  return !!db.prepare('SELECT 1 FROM ticket_watchers WHERE ticket_id = ? AND user_id = ?').get(ticketId, userId);
}

function ticketLink(req, ticketId) {
  return `${req.protocol}://${req.get('host')}/tickets/${ticketId}`;
}

function notifyAssignmentEmail(req, ticket, assigneeId) {
  const agent = db.prepare('SELECT name, email FROM users WHERE id = ?').get(assigneeId);
  if (agent?.email) {
    sendTemplatedEmail(req.workspaceId, 'ticket_assigned', agent.email, {
      'agent.name': agent.name, 'ticket.number': ticket.number, 'ticket.title': ticket.title, 'ticket.priority': ticket.priority, 'ticket.link': ticketLink(req, ticket.id),
    }).catch((e) => console.error('ticket assigned email error', e));
  }
}

function notifyRequesterStatusEmail(req, key, ticket) {
  const requester = db.prepare('SELECT name, email FROM users WHERE id = ?').get(ticket.requester_id);
  if (requester?.email) {
    sendTemplatedEmail(req.workspaceId, key, requester.email, {
      'requester.name': requester.name, 'ticket.number': ticket.number, 'ticket.title': ticket.title, 'ticket.link': ticketLink(req, ticket.id),
    }).catch((e) => console.error(`${key} email error`, e));
  }
}

router.get('/', (req, res) => {
  const { status, priority, type, assignee_id, team, q, include_spam } = req.query;
  let sql = 'SELECT * FROM tickets WHERE workspace_id = ? AND deleted_at IS NULL';
  const params = [req.workspaceId];
  // Requesters only ever see their own tickets — forced server-side so the
  // list can't be widened by query params, not just hidden in the UI.
  if (req.user.role === 'requester') {
    sql += ' AND requester_id = ?';
    params.push(req.user.id);
  }
  // Spam stays out of every normal queue/report by default without being
  // deleted -- pass ?include_spam=1 to see it (e.g. a dedicated spam view).
  if (!include_spam) sql += ' AND is_spam = 0';
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (priority) { sql += ' AND priority = ?'; params.push(priority); }
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (assignee_id === 'unassigned') sql += ' AND assignee_id IS NULL';
  else if (assignee_id) { sql += ' AND assignee_id = ?'; params.push(assignee_id); }
  if (team) { sql += ' AND team = ?'; params.push(team); }
  if (q) { sql += ' AND (title LIKE ? OR number LIKE ? OR description LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params);
  // Escalation has no scheduler to run on -- it's evaluated here instead,
  // so any open ticket that crosses a configured threshold escalates the
  // moment someone next loads a list that includes it, not just when it's
  // opened directly. A ticket that escalates mid-response (e.g. a priority
  // bump) won't be reflected in *this* response's rows -- only the next
  // fetch -- same "eventually consistent on next read" tradeoff every
  // other read-time-computed value in this app already makes.
  for (const t of rows) { evaluateEscalationsSafely(t); stampSlaBreach(t); }
  res.json({ tickets: rows });
});

router.get('/teams', (req, res) => {
  const rows = db.prepare("SELECT DISTINCT team FROM tickets WHERE workspace_id = ? AND team IS NOT NULL AND team != '' ORDER BY team").all(req.workspaceId);
  res.json({ teams: rows.map((r) => r.team) });
});

// Agents (and admins, who can also pick up work) eligible to be a ticket's
// assignee -- powers the assignee dropdown on the ticket detail page.
// Requesters have no legitimate use for this list, so it's gated like every
// other agent-facing lookup. Registered before GET /:id so "assignable-agents"
// is never swallowed as a ticket id.
router.get('/assignable-agents', (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Forbidden' });
  const rows = db.prepare(
    `SELECT u.id, u.name, u.email, wm.team FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND wm.role IN ('admin','agent') AND wm.active = 1 ORDER BY u.name`
  ).all(req.workspaceId);
  res.json({ agents: rows });
});

// ---- Bulk update -- status/priority/assignee/group across many tickets in
// one call. Each ticket is validated individually (lifecycle governance, CAB
// gate, business rules) exactly as a single PATCH would be, so one
// unusual ticket in the batch fails on its own rather than blocking or
// silently corrupting the rest. Registered before GET /:id so "bulk-update"
// is never swallowed as a ticket id. ----
router.post('/bulk-update', requireRole('agent', 'admin'), (req, res) => {
  const { ticket_ids, updates } = req.body;
  if (!Array.isArray(ticket_ids) || !ticket_ids.length) return res.status(400).json({ error: 'ticket_ids required' });
  const allowed = ['status', 'priority', 'assignee_id', 'team'];
  const keys = Object.keys(updates || {}).filter((k) => allowed.includes(k));
  if (!keys.length) return res.status(400).json({ error: 'No valid fields to update (status, priority, assignee_id, team only)' });

  const succeeded = [];
  const failed = [];
  for (const id of ticket_ids) {
    try {
      const ticket = getTicket(id, req.workspaceId);
      if (!ticket) { failed.push({ id, error: 'Not found' }); continue; }
      if (updates.status !== undefined && getLifecycle(req.workspaceId, ticket.type)) {
        failed.push({ id, number: ticket.number, error: 'Governed by a lifecycle — move it through stages individually.' });
        continue;
      }
      if (ticket.type === 'change' && updates.status === 'in_progress' && ticket.cab_status !== 'approved') {
        failed.push({ id, number: ticket.number, error: 'Not yet CAB-approved.' });
        continue;
      }
      const evalBody = { ...updates, ...computeTaskAggregates(ticket.id) };
      const fieldOptions = buildFieldOptionsMap(req.workspaceId, ticket.type);
      const ruleError = applyBusinessRules(req.workspaceId, ticket.type, evalBody, fieldOptions, { partial: true });
      if (ruleError) { failed.push({ id, number: ticket.number, error: ruleError }); continue; }

      const fields = []; const params = [];
      for (const key of keys) {
        if (evalBody[key] !== undefined) { fields.push(`${key} = ?`); params.push(evalBody[key]); }
      }
      if (!fields.length) { failed.push({ id, number: ticket.number, error: 'Nothing valid to set' }); continue; }
      if (updates.status === 'resolved' && ticket.status !== 'resolved') fields.push("resolved_at = datetime('now')");
      if (updates.status === 'closed' && ticket.status !== 'closed') fields.push("closed_at = datetime('now')");
      fields.push("updated_at = datetime('now')");
      params.push(id);
      db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), id, 'updated', `Bulk update: ${keys.join(', ')}`);
      if (updates.assignee_id && updates.assignee_id !== ticket.assignee_id) {
        notifyUser(updates.assignee_id, 'Ticket assigned to you', `${ticket.number} — ${ticket.title}`, `/tickets/${id}`, req.workspaceId);
        notifyAssignmentEmail(req, ticket, updates.assignee_id);
      }
      const updated = getTicket(id, req.workspaceId);
      evaluateAutomations('ticket_updated', updated).catch((e) => console.error('automation error', e));
      pushToLinkedConnections(updated, req.workspaceId).catch((e) => console.error('external sync push error', e));
      succeeded.push(id);
    } catch (e) {
      failed.push({ id, error: e.message });
    }
  }
  if (succeeded.length) broadcastToWorkspace(req.workspaceId, 'ticket.bulk_updated', { ticketIds: succeeded });
  res.json({ succeeded, failed });
});

// ---- Merge duplicates into one surviving ticket. Comments and attachments
// move onto the primary so its Activity feed shows the full consolidated
// conversation; the duplicate is closed (never deleted) and stamped with
// merged_into_id for traceability. The duplicate's own requester becomes a
// read-only watcher on the primary rather than losing visibility entirely --
// see ticket_watchers in db.js. ----
router.post('/merge', requireRole('agent', 'admin'), (req, res) => {
  const { primary_id, duplicate_ids } = req.body;
  if (!primary_id || !Array.isArray(duplicate_ids) || !duplicate_ids.length) {
    return res.status(400).json({ error: 'primary_id and duplicate_ids required' });
  }
  const primary = getTicket(primary_id, req.workspaceId);
  if (!primary) return res.status(404).json({ error: 'Primary ticket not found' });
  if (['resolved', 'closed'].includes(primary.status)) {
    return res.status(409).json({ error: `${primary.number} is already resolved/closed — pick an active ticket as the merge target.` });
  }

  const mergedNumbers = [];
  for (const dupId of duplicate_ids) {
    if (dupId === primary_id) continue;
    const dup = getTicket(dupId, req.workspaceId);
    if (!dup || dup.merged_into_id) continue; // missing or already-merged -- skip rather than fail the whole batch

    db.prepare('UPDATE ticket_comments SET ticket_id = ? WHERE ticket_id = ?').run(primary_id, dupId);
    db.prepare('UPDATE attachments SET ticket_id = ? WHERE ticket_id = ?').run(primary_id, dupId);

    if (dup.requester_id && dup.requester_id !== primary.requester_id) {
      db.prepare('INSERT OR IGNORE INTO ticket_watchers (id, ticket_id, user_id) VALUES (?,?,?)').run(uid('wch'), primary_id, dup.requester_id);
      notifyUser(dup.requester_id, `Your ticket ${dup.number} was merged`, `${dup.number} — ${dup.title} was merged into ${primary.number}. You can still follow its progress there.`, `/tickets/${primary_id}`, req.workspaceId);
    }

    db.prepare("UPDATE tickets SET status = 'closed', merged_into_id = ?, closed_at = COALESCE(closed_at, datetime('now')), updated_at = datetime('now') WHERE id = ?").run(primary_id, dupId);
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), dupId, 'merged', `Merged into ${primary.number}`);
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), primary_id, 'merged', `Merged ${dup.number} — ${dup.title} into this ticket`);
    mergedNumbers.push(dup.number);
  }

  if (mergedNumbers.length) broadcastToWorkspace(req.workspaceId, 'ticket.bulk_updated', { ticketIds: [primary_id, ...duplicate_ids] });
  res.json({ ok: true, merged: mergedNumbers, primary: getTicket(primary_id, req.workspaceId) });
});

router.get('/:id', (req, res) => {
  const ticket = db.prepare(
    `SELECT t.*, ru.name AS requester_name, ru.email AS requester_email, au.name AS assignee_name, au.email AS assignee_email, ci.name AS catalog_item_name,
            rwm.employee_id AS requester_employee_id, rmu.name AS requester_manager_name
     FROM tickets t
     LEFT JOIN users ru ON ru.id = t.requester_id
     LEFT JOIN workspace_members rwm ON rwm.workspace_id = t.workspace_id AND rwm.user_id = t.requester_id
     LEFT JOIN users rmu ON rmu.id = rwm.manager_id
     LEFT JOIN users au ON au.id = t.assignee_id
     LEFT JOIN catalog_items ci ON ci.id = t.catalog_item_id
     WHERE t.id = ? AND t.workspace_id = ? AND t.deleted_at IS NULL`
  ).get(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  // A watcher (currently: the original requester of a ticket that got
  // merged into this one) can view it read-only, same as the requester --
  // just never gets the write routes below (comments/attachments/CSAT stay
  // requester-or-agent-only).
  if (req.user.role === 'requester' && ticket.requester_id !== req.user.id && !isWatcher(ticket.id, req.user.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Evaluated before comments/history are fetched below, so a level that
  // fires right now (crossed its threshold since the last time anyone
  // looked) shows up in this same response's Activity feed immediately,
  // not just on the next load.
  evaluateEscalationsSafely(ticket);
  stampSlaBreach(ticket);
  // Private notes are agent/admin-only -- filtered server-side, not just
  // hidden in the UI, so a requester can never see one even by calling this
  // endpoint directly.
  const commentRows = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
  const comments = req.user.role === 'requester' ? commentRows.filter((c) => !c.is_private) : commentRows;
  const history = db.prepare('SELECT * FROM ticket_history WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
  const approvals = db.prepare('SELECT * FROM approvals WHERE ticket_id = ? ORDER BY step_order').all(ticket.id);
  const linkedAssets = db.prepare(
    'SELECT a.* FROM ticket_assets ta JOIN assets a ON a.id = ta.asset_id WHERE ta.ticket_id = ?'
  ).all(ticket.id);
  const csat = db.prepare('SELECT * FROM csat_surveys WHERE ticket_id = ?').get(ticket.id);
  const attachments = db.prepare('SELECT id, filename, mime, size, uploaded_by, created_at FROM attachments WHERE ticket_id = ? ORDER BY created_at DESC').all(ticket.id);
  const businessRules = listBusinessRules(req.workspaceId, ticket.type);
  const fieldOptions = buildFieldOptionsMap(req.workspaceId, ticket.type);
  const blastRadius = computeBlastRadius(linkedAssets.map((a) => a.id), req.workspaceId);
  const customFields = listCustomFields(req.workspaceId, ticket.type);
  const custom = getCustomValues(ticket.id);
  const lifecycle = describeAvailableTransitions(req.workspaceId, ticket, req.user);
  const externalLinks = db.prepare(
    `SELECT l.*, c.platform, c.name AS connection_name
     FROM ticket_external_links l JOIN external_connections c ON c.id = l.connection_id
     WHERE l.ticket_id = ? ORDER BY l.created_at`
  ).all(ticket.id);
  // ai_summary is generated from the full comment thread including private
  // notes (see POST /:id/ai/summarize) -- it's an agent productivity aid,
  // not customer-facing, so it's redacted here rather than trusting the
  // frontend to just not render it.
  const ticketOut = req.user.role === 'requester'
    ? { ...ticket, ai_summary: null, requester_employee_id: null, requester_manager_name: null }
    : ticket;
  // Merge context: if this ticket absorbed others, list them; if this
  // ticket itself was the one merged away, name where it went.
  const mergedFrom = db.prepare('SELECT id, number, title FROM tickets WHERE merged_into_id = ?').all(ticket.id);
  const mergedInto = ticket.merged_into_id
    ? db.prepare('SELECT id, number, title FROM tickets WHERE id = ?').get(ticket.merged_into_id)
    : null;
  // Major Incident context, hidden entirely from requesters (they see the
  // same information as ordinary mirrored ticket comments instead) -- either
  // this ticket IS the anchor of one, or it's linked as a related/symptom
  // ticket under someone else's.
  let majorIncident = null;
  let relatedMajorIncidents = [];
  if (req.user.role !== 'requester') {
    const anchorMi = db.prepare("SELECT * FROM major_incidents WHERE ticket_id = ? ORDER BY declared_at DESC LIMIT 1").get(ticket.id);
    if (anchorMi) majorIncident = withComputed(anchorMi);
    relatedMajorIncidents = db.prepare(
      `SELECT mi.* FROM major_incident_related_tickets mrt JOIN major_incidents mi ON mi.id = mrt.major_incident_id WHERE mrt.ticket_id = ?`
    ).all(ticket.id).map(withComputed);
  }

  const tasks = listTasks(ticket.id);

  res.json({ ticket: ticketOut, comments, history, approvals, linkedAssets, csat: csat || null, attachments, businessRules, fieldOptions, blastRadius, customFields, custom, lifecycle, externalLinks, mergedFrom, mergedInto, majorIncident, relatedMajorIncidents, tasks });
});

router.post('/', async (req, res) => {
  const { title, type = 'incident', custom, catalog_item_id } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const customDefs = listCustomFields(req.workspaceId, type);
  const { values: customValues, error: customError } = normalizeCustomValues(customDefs, custom);
  if (customError) return res.status(400).json({ error: customError });

  // Service Item is a synthetic, live-backed Business Rules field for
  // Request tickets -- resolve the real catalog item's name up front so a
  // rule can condition on "Service Item = X" the same way it would on any
  // other field.
  let catalogItem = null;
  if (catalog_item_id) {
    catalogItem = db.prepare('SELECT id, name FROM catalog_items WHERE id = ? AND workspace_id = ?').get(catalog_item_id, req.workspaceId);
    if (!catalogItem) return res.status(400).json({ error: 'Invalid service item' });
  }

  // Business Rules can target/condition on built-in AND custom fields, so
  // give it one flat, mutable view -- hiding a field here deletes its key,
  // set_value writes through, and we read the persisted values back out of
  // this same object below, so both effects are real, not just cosmetic in the UI.
  const evalBody = { ...req.body, ...customValues, catalog_item_name: catalogItem?.name || null };
  const fieldOptions = buildFieldOptionsMap(req.workspaceId, type);
  const ruleError = applyBusinessRules(req.workspaceId, type, evalBody, fieldOptions);
  if (ruleError) return res.status(400).json({ error: ruleError });
  for (const key of Object.keys(customValues)) {
    if (!(key in evalBody)) delete customValues[key];
  }
  // A rule hiding "Service Item" deletes catalog_item_name from evalBody --
  // drop the real FK too so a hidden field's value never persists either.
  const finalCatalogItemId = ('catalog_item_name' in evalBody) ? (catalogItem?.id || null) : null;

  const {
    description, priority = 'medium', category, subcategory, team, impact, requester_id, source = 'portal',
    risk, planned_start, planned_end, rollback_plan,
  } = evalBody;

  const id = uid('tkt');
  const number = nextTicketNumber(req.workspaceId, type);

  const policy = findSlaPolicy({ workspaceId: req.workspaceId, type, priority, category, subcategory, team, impact, risk, source, title, description });
  const sla_due_at = computeSlaDueDate(policy?.resolution_minutes ?? { critical: 240, high: 480, medium: 1440, low: 4320 }[priority] ?? 1440, policy?.business_hours_only, new Date(), req.workspaceId);
  const response_due_at = computeSlaDueDate(policy?.response_minutes ?? 60, policy?.business_hours_only, new Date(), req.workspaceId);

  const isChange = type === 'change';
  const cab_status = isChange ? 'pending' : 'not_required';
  // When this type has an active lifecycle, tickets start life in its first
  // stage instead of the hardcoded 'open' default -- status is derived from
  // that stage's bucket so every existing status-based query still works.
  const initialStage = initialStageFor(req.workspaceId, type);

  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, priority, impact, category, subcategory, team, requester_id, sla_due_at, response_due_at, sla_policy_id, source, risk, planned_start, planned_end, rollback_plan, cab_status, catalog_item_id, lifecycle_stage, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, req.workspaceId, number, type, title, description || '', priority, impact || 'medium', category || null,
    reconcileSubcategories(req.workspaceId, category, subcategory), team || null,
    requester_id || req.user.id, sla_due_at, response_due_at, policy?.id || null, source,
    risk || null, planned_start || null, planned_end || null, rollback_plan || null, cab_status, finalCatalogItemId,
    initialStage?.key || null, initialStage?.bucket || 'open'
  );
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), id, 'created', `Ticket created via ${source}`);
  if (Object.keys(customValues).length) saveCustomValues(id, customDefs, customValues);

  if (isChange) {
    db.prepare('INSERT INTO approvals (id, ticket_id, approver_role, step_order, status) VALUES (?,?,?,?,?)').run(
      uid('apr'), id, 'admin', 1, 'pending'
    );
    const cabMembers = db.prepare(
      `SELECT u.id, u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND wm.role = 'admin' AND wm.active = 1`
    ).all(req.workspaceId);
    const cabRequester = db.prepare('SELECT name FROM users WHERE id = ?').get(requester_id || req.user.id);
    for (const m of cabMembers) {
      notifyUser(m.id, 'CAB approval requested', `${number} — ${title}`, `/tickets/${id}`, req.workspaceId);
      sendTemplatedEmail(req.workspaceId, 'cab_approval_requested', m.email, {
        'approver.name': m.name, 'requester.name': cabRequester?.name || req.user.name, 'ticket.number': number, 'ticket.title': title, 'ticket.link': ticketLink(req, id),
      }).catch((e) => console.error('cab approval email error', e));
    }
  }

  const ticket = getTicket(id, req.workspaceId);
  const ticketRequester = db.prepare('SELECT name, email FROM users WHERE id = ?').get(ticket.requester_id);
  if (ticketRequester?.email) {
    sendTemplatedEmail(req.workspaceId, 'ticket_created', ticketRequester.email, {
      'requester.name': ticketRequester.name, 'ticket.number': number, 'ticket.title': title, 'ticket.priority': priority, 'ticket.link': ticketLink(req, id),
    }).catch((e) => console.error('ticket created email error', e));
  }
  // Availability-based routing. Deliberately after the ticket exists and
  // before automations run, so a workflow's own assign action still has the
  // last word -- and fire-and-forget like escalation, since a routing
  // failure must never be the reason a ticket couldn't be raised. No-ops
  // when the ticket already has an owner or no policy matches.
  autoAssignSafely(ticket);
  evaluateAutomations('ticket_created', ticket).catch((e) => console.error('automation error', e));
  broadcastToWorkspace(req.workspaceId, 'ticket.created', { ticketId: id });
  res.status(201).json({ ticket, custom: getCustomValues(id) });
});

router.patch('/:id', (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  // A requester may edit ONLY their own ticket, and only its title/
  // description -- everything else (status, priority, assignment, type...)
  // is agent/admin territory. Previously this route had no ownership check
  // at all: any authenticated requester could PATCH any ticket in the
  // workspace, including someone else's, and set fields the UI never even
  // exposes to them (the frontend just disabled those inputs -- nothing
  // enforced it server-side). 404 rather than 403 on a ticket that isn't
  // theirs, matching GET /:id's same "don't reveal it exists" behavior.
  if (req.user.role === 'requester') {
    if (ticket.requester_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
    const requesterAllowed = new Set(['title', 'description']);
    const attemptedOther = Object.keys(req.body).some((k) => !requesterAllowed.has(k));
    if (attemptedOther) return res.status(403).json({ error: 'You can only edit the title and description of your own ticket.' });
    if (['resolved', 'closed'].includes(ticket.status)) {
      return res.status(409).json({ error: 'This ticket is already resolved/closed and can no longer be edited.' });
    }
  }

  // Hard enforcement: once a type has an active lifecycle, status can only
  // move through validated stage transitions (POST /:id/transition), never
  // by patching the field directly -- from the UI, from automations, or
  // from any other API caller.
  if (req.body.status !== undefined && getLifecycle(req.workspaceId, ticket.type)) {
    return res.status(409).json({ error: 'This ticket type is governed by a configured lifecycle — move it through stages instead of setting status directly.' });
  }

  // CAB gate: a change cannot move into progress until CAB has approved it.
  // Kept as a safety net for changes NOT governed by a lifecycle (the
  // lifecycle's own cab_review -> scheduled gate covers governed ones).
  if (ticket.type === 'change' && req.body.status === 'in_progress' && ticket.cab_status !== 'approved') {
    return res.status(409).json({ error: 'This change is not yet CAB-approved. It cannot move to in_progress until approval is granted.' });
  }

  if (req.body.type !== undefined && !['incident', 'request', 'problem', 'change'].includes(req.body.type)) {
    return res.status(400).json({ error: 'type must be one of: incident, request, problem, change' });
  }

  const customDefs = listCustomFields(req.workspaceId, ticket.type);
  const { values: customValues, error: customError } = normalizeCustomValues(customDefs, req.body.custom);
  if (customError) return res.status(400).json({ error: customError });

  // Task aggregates merged in here (not touching req.body itself) let a
  // Business Rule condition on all_tasks_completed/tasks_open the same way
  // it would on any real column -- e.g. "block resolving until every task on
  // this ticket is done" -- without those synthetic keys ever reaching the
  // `allowed`-gated SQL update below (that loop only reads keys present in
  // req.body's own allowlist, so the extras are harmlessly ignored there).
  const evalBody = { ...req.body, ...customValues, ...computeTaskAggregates(ticket.id) };
  const fieldOptions = buildFieldOptionsMap(req.workspaceId, ticket.type);
  const ruleError = applyBusinessRules(req.workspaceId, ticket.type, evalBody, fieldOptions, { partial: true });
  if (ruleError) return res.status(400).json({ error: ruleError });
  for (const key of Object.keys(customValues)) {
    if (!(key in evalBody)) delete customValues[key];
  }

  const allowed = ['title', 'description', 'status', 'type', 'priority', 'category', 'subcategory', 'assignee_id', 'team', 'impact', 'risk', 'planned_start', 'planned_end', 'rollback_plan'];

  // Subcategories only mean anything under their own category, so they are
  // normalized against the category this ticket will actually have once this
  // request is applied -- not the one it had before. Changing category alone
  // therefore also drops subcategories that no longer belong, rather than
  // leaving a Network ticket tagged "Payroll" because the UI only sent the
  // category field.
  const effectiveCategory = evalBody.category !== undefined ? evalBody.category : ticket.category;
  if (evalBody.subcategory !== undefined) {
    evalBody.subcategory = reconcileSubcategories(req.workspaceId, effectiveCategory, evalBody.subcategory);
  } else if (evalBody.category !== undefined && evalBody.category !== ticket.category && ticket.subcategory) {
    evalBody.subcategory = reconcileSubcategories(req.workspaceId, effectiveCategory, ticket.subcategory);
  }

  const fields = [];
  const params = [];
  for (const key of allowed) {
    if (evalBody[key] !== undefined) { fields.push(`${key} = ?`); params.push(evalBody[key]); }
  }
  // The ticket number's prefix (INC-/REQ-/PRB-/CHG-) identifies its type --
  // changing type without renumbering would leave e.g. an INC- number on a
  // ticket that's now a Request. Draws the next number from the *target*
  // type's own counter, same as a ticket created as that type from scratch,
  // so the two numbering sequences never collide or skip.
  const previousNumber = ticket.number;
  let newNumber = null;
  if (evalBody.type !== undefined && evalBody.type !== ticket.type) {
    newNumber = nextTicketNumber(req.workspaceId, evalBody.type);
    fields.push('number = ?'); params.push(newNumber);
  }
  if (Object.keys(customValues).length) saveCustomValues(req.params.id, customDefs, customValues);
  if (!fields.length && !Object.keys(customValues).length) return res.status(400).json({ error: 'No valid fields to update' });
  if (fields.length) {
    if (req.body.status === 'resolved' && ticket.status !== 'resolved') { fields.push("resolved_at = datetime('now')"); }
    if (req.body.status === 'closed' && ticket.status !== 'closed') { fields.push("closed_at = datetime('now')"); }
    fields.push("updated_at = datetime('now')");
    params.push(req.params.id);
    db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), req.params.id, 'updated', Object.keys(req.body).join(', ')
  );
  if (newNumber) {
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
      uid('h'), req.params.id, 'renumbered', `Type changed from ${ticket.type} to ${evalBody.type} — ${previousNumber} became ${newNumber}`
    );
  }

  if (req.body.assignee_id && req.body.assignee_id !== ticket.assignee_id) {
    notifyUser(req.body.assignee_id, 'Ticket assigned to you', `${ticket.number} — ${ticket.title}`, `/tickets/${ticket.id}`, req.workspaceId);
    notifyAssignmentEmail(req, ticket, req.body.assignee_id);
  }
  if (req.body.status === 'resolved' && ticket.status !== 'resolved') {
    const tpl = renderTemplate('ticket_resolved', { number: ticket.number, title: ticket.title }, req.workspaceId);
    notifyUser(ticket.requester_id, tpl?.subject || 'Your ticket was resolved', tpl?.body || `${ticket.number} — ${ticket.title}. Let us know how we did!`, `/tickets/${ticket.id}`, req.workspaceId);
    notifyRequesterStatusEmail(req, 'ticket_resolved', ticket);
  }
  if (req.body.status === 'closed' && ticket.status !== 'closed') {
    notifyRequesterStatusEmail(req, 'ticket_closed', ticket);
  }

  const updated = getTicket(req.params.id, req.workspaceId);
  evaluateAutomations('ticket_updated', updated).catch((e) => console.error('automation error', e));
  pushToLinkedConnections(updated, req.workspaceId).catch((e) => console.error('external sync push error', e));
  broadcastToWorkspace(req.workspaceId, 'ticket.updated', { ticketId: req.params.id });
  res.json({ ticket: updated, custom: getCustomValues(req.params.id) });
});

// ---- Delete (itil_admin persona, tickets.delete permission) -- soft, like
// every other "remove" in this app (merge, spam): stamps deleted_at rather
// than a real DELETE FROM, so it's excluded from getTicket()/every list from
// this point on but nothing is actually lost or breaks a foreign key
// elsewhere (comments, history, approvals, attachments all stay intact). ----
router.delete('/:id', requirePermission('tickets.delete'), (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE tickets SET deleted_at = datetime('now') WHERE id = ?").run(ticket.id);
  logAudit(req, { action: 'ticket.deleted', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number });
  res.json({ ok: true });
});

// ---- Requester self-service: reopen own resolved/closed incident within a
// short window, or cancel own still-open request -- the two "own ticket"
// status changes a requester legitimately needs that the general PATCH
// above deliberately doesn't allow them (it locks requesters to title/
// description only). Each is its own narrow, fully-gated route rather than
// widening PATCH's allowlist for them. ----
const REOPEN_WINDOW_DAYS = 7;

router.post('/:id/reopen', (req, res) => {
  if (req.user.role !== 'requester') return res.status(403).json({ error: 'Only the requester can reopen their own ticket this way — agents use a normal status change.' });
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket || ticket.requester_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (ticket.type !== 'incident') return res.status(400).json({ error: 'Only incidents can be reopened this way.' });
  if (!['resolved', 'closed'].includes(ticket.status)) return res.status(409).json({ error: 'This ticket is not resolved or closed.' });
  const closedAt = new Date(ticket.resolved_at || ticket.closed_at || ticket.updated_at);
  const daysSince = (Date.now() - closedAt.getTime()) / 86400000;
  if (daysSince > REOPEN_WINDOW_DAYS) {
    return res.status(409).json({ error: `This ticket was resolved more than ${REOPEN_WINDOW_DAYS} days ago and can no longer be reopened — please open a new ticket instead.` });
  }

  const nextStage = stageForBucket(req.workspaceId, ticket.type, 'in_progress');
  db.prepare(
    `UPDATE tickets SET status = 'in_progress', lifecycle_stage = COALESCE(?, lifecycle_stage), reopened_count = reopened_count + 1, resolved_at = NULL, closed_at = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(nextStage?.key || null, ticket.id);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), ticket.id, 'reopened', `Reopened by ${req.user.name}`);
  if (ticket.assignee_id) {
    notifyUser(ticket.assignee_id, `${ticket.number} was reopened`, `${req.user.name} reopened "${ticket.title}".`, `/tickets/${ticket.id}`, req.workspaceId);
  }
  const updated = getTicket(req.params.id, req.workspaceId);
  broadcastToWorkspace(req.workspaceId, 'ticket.updated', { ticketId: req.params.id });
  res.json({ ticket: updated });
});

router.post('/:id/cancel', (req, res) => {
  if (req.user.role !== 'requester') return res.status(403).json({ error: 'Only the requester can cancel their own request this way.' });
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket || ticket.requester_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  if (ticket.type !== 'request') return res.status(400).json({ error: 'Only requests can be cancelled this way.' });
  if (['resolved', 'closed'].includes(ticket.status)) return res.status(409).json({ error: 'This request is already fulfilled/closed and can no longer be cancelled.' });

  const nextStage = stageForBucket(req.workspaceId, ticket.type, 'closed');
  db.prepare(
    `UPDATE tickets SET status = 'closed', lifecycle_stage = COALESCE(?, lifecycle_stage), closed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(nextStage?.key || null, ticket.id);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), ticket.id, 'cancelled', `Cancelled by ${req.user.name}`);
  const updated = getTicket(req.params.id, req.workspaceId);
  broadcastToWorkspace(req.workspaceId, 'ticket.updated', { ticketId: req.params.id });
  res.json({ ticket: updated });
});

// ---- Spam moderation -- reversible, keeps the ticket (no delete), just
// pulls it out of every default queue/report via GET /'s is_spam filter. ----
router.post('/:id/spam', (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Forbidden' });
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE tickets SET is_spam = 1, spam_marked_at = datetime('now'), status = 'closed', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), req.params.id, 'spam', `Marked as spam by ${req.user.name}`);
  broadcastToWorkspace(req.workspaceId, 'ticket.updated', { ticketId: req.params.id });
  res.json({ ticket: getTicket(req.params.id, req.workspaceId) });
});

router.post('/:id/unspam', (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Forbidden' });
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE tickets SET is_spam = 0, spam_marked_at = NULL, updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), req.params.id, 'spam', `Unmarked as spam by ${req.user.name}`);
  broadcastToWorkspace(req.workspaceId, 'ticket.updated', { ticketId: req.params.id });
  res.json({ ticket: getTicket(req.params.id, req.workspaceId) });
});

// ---- Lifecycle stage transitions (only path allowed to move status once a
// ticket type has an active lifecycle -- see the guard in PATCH above) ----
router.post('/:id/transition', (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Not permitted' });
  const { to_stage } = req.body;
  if (!to_stage) return res.status(400).json({ error: 'to_stage required' });

  let result;
  try {
    result = transitionTicket(req.workspaceId, ticket, to_stage, req.user);
  } catch (e) {
    return res.status(409).json({ error: e.message });
  }

  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticket.id, 'stage_changed', `${result.fromStage.label} → ${result.toStage.label}`
  );
  if (result.toStage.bucket === 'resolved' && ticket.status !== 'resolved') {
    const tpl = renderTemplate('ticket_resolved', { number: ticket.number, title: ticket.title }, req.workspaceId);
    notifyUser(ticket.requester_id, tpl?.subject || 'Your ticket was resolved', tpl?.body || `${ticket.number} — ${ticket.title}. Let us know how we did!`, `/tickets/${ticket.id}`, req.workspaceId);
    notifyRequesterStatusEmail(req, 'ticket_resolved', ticket);
  } else if (result.toStage.bucket === 'closed' && ticket.status !== 'closed') {
    notifyRequesterStatusEmail(req, 'ticket_closed', ticket);
  }

  const updated = getTicket(req.params.id, req.workspaceId);
  evaluateAutomations('ticket_updated', updated).catch((e) => console.error('automation error', e));
  pushToLinkedConnections(updated, req.workspaceId).catch((e) => console.error('external sync push error', e));
  broadcastToWorkspace(req.workspaceId, 'ticket.updated', { ticketId: req.params.id });
  res.json({ ticket: updated, lifecycle: describeAvailableTransitions(req.workspaceId, updated, req.user) });
});

// ---- Bilateral external ticket sync (ServiceNow / Jira / Freshservice) ----
// Agent/admin only, same gate as the other cross-cutting ticket actions below.
router.post('/:id/external-links', async (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Not permitted' });
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const { connection_id, mode, external_id } = req.body;
  const connection = db.prepare('SELECT * FROM external_connections WHERE id = ? AND workspace_id = ?').get(connection_id, req.workspaceId);
  if (!connection) return res.status(404).json({ error: 'Connection not found' });
  try {
    const link = mode === 'link'
      ? await linkExistingTicket(connection, ticket, String(external_id || '').trim())
      : await createExternalTicket(connection, ticket);
    res.status(201).json({ link });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/external-links/:linkId/push', async (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Not permitted' });
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const link = db.prepare('SELECT * FROM ticket_external_links WHERE id = ? AND ticket_id = ? AND workspace_id = ?').get(req.params.linkId, ticket.id, req.workspaceId);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  await pushTicketUpdate(link, ticket);
  res.json({ link: db.prepare('SELECT * FROM ticket_external_links WHERE id = ?').get(link.id) });
});

router.post('/:id/external-links/:linkId/pull', async (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Not permitted' });
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const link = db.prepare('SELECT * FROM ticket_external_links WHERE id = ? AND ticket_id = ? AND workspace_id = ?').get(req.params.linkId, ticket.id, req.workspaceId);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  try {
    await pullTicketUpdate(link);
    res.json({ ticket: getTicket(ticket.id, req.workspaceId), link: db.prepare('SELECT * FROM ticket_external_links WHERE id = ?').get(link.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id/external-links/:linkId', (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Not permitted' });
  const link = db.prepare('SELECT id FROM ticket_external_links WHERE id = ? AND ticket_id = ? AND workspace_id = ?').get(req.params.linkId, req.params.id, req.workspaceId);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  db.prepare('DELETE FROM ticket_external_links WHERE id = ?').run(req.params.linkId);
  res.json({ ok: true });
});

router.get('/:id/external-links/:linkId/logs', (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Not permitted' });
  const link = db.prepare('SELECT id FROM ticket_external_links WHERE id = ? AND ticket_id = ? AND workspace_id = ?').get(req.params.linkId, req.params.id, req.workspaceId);
  if (!link) return res.status(404).json({ error: 'Link not found' });
  const logs = db.prepare('SELECT * FROM ticket_sync_logs WHERE link_id = ? ORDER BY created_at DESC LIMIT 50').all(req.params.linkId);
  res.json({ logs });
});

// ---- Tasks: a per-ticket checklist of assignable, sequenceable work items
// (see services/tasks.js). Read is open to anyone who can see the ticket
// (a requester sees what's being done for them, same transparency as public
// comments); creating/editing/deleting is agent/admin only, matching every
// other ticket-management action. ----
router.get('/:id/tasks', (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'requester' && ticket.requester_id !== req.user.id && !isWatcher(ticket.id, req.user.id)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.json({ tasks: listTasks(ticket.id) });
});

router.post('/:id/tasks', (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Not permitted' });
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const { title, description, assignee_id, due_date, priority, depends_on_task_id } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'title required' });
  let task;
  try {
    task = createTask(ticket, { title: title.trim(), description, assignee_id, due_date, priority, depends_on_task_id, created_by: req.user.id });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const ctx = {
    ...ticket, ...computeTaskAggregates(ticket.id),
    task_id: task.id, task_title: task.title, task_status: task.status, task_priority: task.priority,
    task_assignee_id: task.assignee_id, task_due_date: task.due_date,
  };
  evaluateAutomations('task_created', ctx).catch((e) => console.error('automation error', e));
  broadcastToWorkspace(req.workspaceId, 'ticket.updated', { ticketId: ticket.id });
  res.status(201).json({ task, tasks: listTasks(ticket.id) });
});

router.patch('/:id/tasks/:taskId', (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Not permitted' });
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const allowed = ['title', 'description', 'status', 'assignee_id', 'due_date', 'priority', 'sort_order', 'depends_on_task_id'];
  const patch = {};
  for (const key of allowed) if (req.body[key] !== undefined) patch[key] = req.body[key];
  let task;
  try {
    task = updateTask(ticket, req.params.taskId, patch, req.user.name);
  } catch (e) {
    return res.status(409).json({ error: e.message });
  }
  if (!task) return res.status(404).json({ error: 'Task not found' });

  if (patch.status === 'done') {
    const ctx = {
      ...ticket, ...computeTaskAggregates(ticket.id),
      task_id: task.id, task_title: task.title, task_status: task.status, task_priority: task.priority,
      task_assignee_id: task.assignee_id, task_due_date: task.due_date,
    };
    evaluateAutomations('task_completed', ctx).catch((e) => console.error('automation error', e));
  }
  broadcastToWorkspace(req.workspaceId, 'ticket.updated', { ticketId: ticket.id });
  res.json({ task, tasks: listTasks(ticket.id) });
});

router.delete('/:id/tasks/:taskId', (req, res) => {
  if (req.user.role === 'requester') return res.status(403).json({ error: 'Not permitted' });
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  deleteTask(ticket.id, req.params.taskId);
  broadcastToWorkspace(req.workspaceId, 'ticket.updated', { ticketId: ticket.id });
  res.json({ tasks: listTasks(ticket.id) });
});

router.post('/:id/comments', (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  // A requester replying on their own ticket is the normal flow -- but
  // nothing was stopping them posting a "reply" on any OTHER ticket in the
  // workspace, which even emails that other person as if it came through
  // their ticket thread. Same ownership gate GET /:id already applies.
  if (req.user.role === 'requester' && ticket.requester_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const { body, is_private = false } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  // A private note is agent/admin-only -- a requester has no legitimate use
  // for one (it's never shown to them either way, per GET /:id's filter),
  // so silently downgrade rather than trust the flag from a requester caller.
  const privateNote = !!is_private && req.user.role !== 'requester';
  const id = uid('cmt');
  db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_id, author_name, body, is_private) VALUES (?,?,?,?,?,?)').run(
    id, req.params.id, req.user.id, req.user.name, body, privateNote ? 1 : 0
  );
  const isAgentReplying = req.user.id !== ticket.requester_id;
  const fields = ["updated_at = datetime('now')"];
  if (!ticket.responded_at && isAgentReplying) fields.push("responded_at = datetime('now')");
  db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(req.params.id);

  // A public Reply from an agent is meant to actually reach the requester --
  // an in-app notification always, plus a real templated email via the
  // dedicated Email Configuration system (Admin Settings → Email
  // Configuration → "New Reply From an Agent"). This used to go out through
  // whatever email_smtp integration happened to be configured on the
  // Integrations page with a hardcoded plain-text body; that generic path
  // still exists for other integration types, but ticket-lifecycle mail is
  // now sent exclusively through email_templates so there's one place an
  // admin edits what these messages say. A private note never notifies the
  // requester in any form.
  if (!privateNote && isAgentReplying) {
    const requester = db.prepare('SELECT name, email FROM users WHERE id = ?').get(ticket.requester_id);
    if (requester) {
      notifyUser(ticket.requester_id, `New reply on ${ticket.number}`, body.slice(0, 200), `/tickets/${ticket.id}`, req.workspaceId);
      if (requester.email) {
        sendTemplatedEmail(req.workspaceId, 'ticket_comment_reply', requester.email, {
          'requester.name': requester.name, 'agent.name': req.user.name, 'ticket.number': ticket.number, 'ticket.title': ticket.title,
          'comment.body': body, 'ticket.link': ticketLink(req, ticket.id),
        }).catch((e) => console.error('reply email error', e));
      }
    }
  }

  // A public Reply also flows out to any bilaterally-connected external
  // platform (ServiceNow/Jira/Freshservice/SDP) as a real comment there --
  // a private note never does, matching its agents-only intent.
  if (!privateNote) {
    pushCommentToConnections(ticket, { body }).catch((e) => console.error('external comment push error', e));
  }

  // Broadcast even a private note -- the payload is just an id, and the
  // receiving client re-fetches through the normal permission-checked GET
  // /:id, which already filters private notes out for a requester.
  broadcastToWorkspace(req.workspaceId, 'ticket.comment', { ticketId: req.params.id });
  res.status(201).json({ comment: db.prepare('SELECT * FROM ticket_comments WHERE id = ?').get(id) });
});

// ---- CMDB: link/unlink assets to a ticket ----
// CMDB asset linking is an agent/admin tool -- the UI never even shows this
// panel to a requester (see TicketDetail.jsx's isAgent-gated "Linked assets"
// card), so unlike comments/attachments/CSAT below this isn't "ownership",
// it's a plain role gate: no requester has a legitimate use for it on any
// ticket, including their own.
router.post('/:id/assets', requireRole('agent', 'admin'), (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const { asset_id } = req.body;
  if (!asset_id) return res.status(400).json({ error: 'asset_id required' });
  const asset = db.prepare('SELECT id FROM assets WHERE id = ? AND workspace_id = ?').get(asset_id, req.workspaceId);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  db.prepare('INSERT INTO ticket_assets (id, ticket_id, asset_id) VALUES (?,?,?)').run(uid('ta'), req.params.id, asset_id);
  res.status(201).json({ ok: true });
});

router.delete('/:id/assets/:assetId', requireRole('agent', 'admin'), (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM ticket_assets WHERE ticket_id = ? AND asset_id = ?').run(req.params.id, req.params.assetId);
  res.json({ ok: true });
});

// ---- Attachments -- a requester legitimately uploads/views/downloads
// these on their OWN ticket (the UI shows this card to everyone, unlike
// CMDB assets above), so each route below gates on ownership, not role. ----
router.post('/:id/attachments', (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'requester' && ticket.requester_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  upload.array('files', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const files = req.files || [];
    for (const f of files) {
      db.prepare(
        'INSERT INTO attachments (id, workspace_id, ticket_id, filename, stored_path, mime, size, uploaded_by) VALUES (?,?,?,?,?,?,?,?)'
      ).run(uid('att'), req.workspaceId, req.params.id, f.originalname, f.path, f.mimetype, f.size, req.user.id);
    }
    if (files.length) {
      db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
        uid('h'), req.params.id, 'attachment_added', files.map((f) => f.originalname).join(', ')
      );
    }
    res.status(201).json({ ok: true, count: files.length });
  });
});

router.get('/:id/attachments', (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'requester' && ticket.requester_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare('SELECT id, filename, mime, size, uploaded_by, created_at FROM attachments WHERE ticket_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ attachments: rows });
});

// The most sensitive of this group -- this is real file content leaving the
// server, not just metadata, so a missing ownership check here means one
// requester could download another person's uploaded files just by guessing
// a ticket id.
router.get('/:id/attachments/:attachmentId/download', (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'requester' && ticket.requester_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND ticket_id = ? AND workspace_id = ?').get(req.params.attachmentId, req.params.id, req.workspaceId);
  if (!att) return res.status(404).json({ error: 'Not found' });
  res.download(att.stored_path, att.filename);
});

router.delete('/:id/attachments/:attachmentId', (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'requester' && ticket.requester_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND ticket_id = ? AND workspace_id = ?').get(req.params.attachmentId, req.params.id, req.workspaceId);
  if (!att) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(att.stored_path); } catch { /* file already gone */ }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
  res.json({ ok: true });
});

// ---- CSAT -- a requester submits this on their OWN resolved ticket. ----
router.post('/:id/csat', (req, res) => {
  const ticket = getTicket(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  if (req.user.role === 'requester' && ticket.requester_id !== req.user.id) return res.status(404).json({ error: 'Not found' });
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be 1-5' });
  const existing = db.prepare('SELECT id FROM csat_surveys WHERE ticket_id = ?').get(req.params.id);
  if (existing) return res.status(409).json({ error: 'Survey already submitted for this ticket' });
  db.prepare('INSERT INTO csat_surveys (id, ticket_id, rating, comment) VALUES (?,?,?,?)').run(uid('csat'), req.params.id, rating, comment || null);
  res.status(201).json({ ok: true });
});

// ---- AI actions on a specific ticket — these are agent/admin tools for
// working a ticket, not something a requester submitting one needs (or
// should be able to trigger on tickets they don't own). ----

router.post('/:id/ai/summarize', requireRole('agent', 'admin'), async (req, res) => {
  try {
    const ticket = getTicket(req.params.id, req.workspaceId);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
    const provider = getProvider(req.workspaceId, req.body.provider_id);
    const summary = await summarizeTicket(provider, ticket, comments);
    db.prepare("UPDATE tickets SET ai_summary = ?, updated_at = datetime('now') WHERE id = ?").run(summary, ticket.id);
    res.json({ summary });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/ai/suggest-resolution', requireRole('agent', 'admin'), async (req, res) => {
  try {
    const ticket = getTicket(req.params.id, req.workspaceId);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
    const provider = getProvider(req.workspaceId, req.body.provider_id);
    const kb = db.prepare('SELECT title, body FROM kb_articles WHERE workspace_id = ? AND category = ? LIMIT 3').all(req.workspaceId, ticket.category || '');
    const kbContext = kb.map((k) => `## ${k.title}\n${k.body.slice(0, 500)}`).join('\n\n');
    const suggestion = await suggestResolution(provider, ticket, comments, kbContext);
    res.json({ suggestion });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/ai/root-cause', requireRole('agent', 'admin'), async (req, res) => {
  try {
    const ticket = getTicket(req.params.id, req.workspaceId);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
    const provider = getProvider(req.workspaceId, req.body.provider_id);
    const analysis = await analyzeRootCause(provider, ticket, comments);
    res.json({ analysis });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/ai/categorize', requireRole('agent', 'admin'), async (req, res) => {
  try {
    const ticket = getTicket(req.params.id, req.workspaceId);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    const provider = getProvider(req.workspaceId, req.body.provider_id);
    const taxonomy = listTaxonomy(req.workspaceId);
    const result = await categorizeTicket(provider, ticket, taxonomy);

    // The model's answer is checked against the real taxonomy before it is
    // allowed to change anything -- same allowlist discipline as
    // POST /reports/sona and the assignment engine. Previously whatever
    // string came back was written straight onto the ticket, so one bad
    // response could invent a category that exists nowhere and quietly
    // fragment reporting.
    const match = taxonomy.find((c) => c.name.toLowerCase() === String(result.category || '').trim().toLowerCase());
    const category = match ? match.name : null;
    const subcategory = category
      ? reconcileSubcategories(req.workspaceId, category, [result.subcategory].filter(Boolean))
      : null;
    const sentiment = ['positive', 'neutral', 'frustrated', 'angry'].includes(result.sentiment) ? result.sentiment : null;

    if (!category) {
      // Recorded as a suggestion only, so the agent can see what the model
      // thought without it overwriting a real value.
      db.prepare("UPDATE tickets SET ai_sentiment = ?, ai_suggested_category = ?, updated_at = datetime('now') WHERE id = ?")
        .run(sentiment, String(result.category || '').slice(0, 100) || null, ticket.id);
      return res.json({ result, applied: false, reason: 'The suggested category is not in this workspace\'s taxonomy' });
    }

    db.prepare(
      "UPDATE tickets SET category = ?, subcategory = ?, ai_sentiment = ?, ai_suggested_category = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(category, subcategory, sentiment, category, ticket.id);
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
      uid('h'), ticket.id, 'updated', `AI categorised as ${category}${subcategory ? ` / ${subcategory}` : ''}`
    );
    res.json({ result: { ...result, category, subcategory }, applied: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
