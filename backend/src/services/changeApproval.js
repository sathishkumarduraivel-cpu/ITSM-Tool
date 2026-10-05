// Approval routing for changes: the flow diagram's four approval lanes.
//
//   Standard  -> auto-approved off a matched template (no route needed)
//   Normal    -> the CAB, either at a scheduled sitting or asynchronously
//   Emergency -> the ECAB, immediately
//   Expedite  -> a named set of expedited approvers, against a short SLA
//
// Routes are matched on change type + risk band by the same
// most-specific-wins scoring as findSlaPolicy and findAssignmentPolicy.
//
// Quorum: a group step may require several approvals ("a real CAB does not
// pass because one member clicked approve"). That is modelled by creating
// one approvals row per eligible approver and marking the rest
// 'not_required' the moment the quorum is met -- which keeps the existing
// "no rows still pending" test in changeWorkflow.js's guardApproved and in
// approvalEngine.js honest, while the audit still shows exactly who voted.
import { db, uid } from '../db.js';
import { effectiveChangeType, slaHoursFor } from './changeTypes.js';
import { notifyUser } from './notifications.js';
import { sendTemplatedEmail, absoluteUrl } from './emailService.js';

export const APPROVER_TYPES = ['cab_group', 'ecab_group', 'group', 'role', 'user', 'requester_manager'];
export const DECISIONS = ['approved', 'rejected', 'approved_with_conditions', 'deferred'];

// Group names the defaults look for. The seed already creates a "Change
// Advisory Board" group; an ECAB group is created on demand if missing,
// because an Emergency change cannot wait for someone to set one up.
const CAB_GROUP_NAME = 'Change Advisory Board';
const ECAB_GROUP_NAME = 'Emergency Change Advisory Board';

function findOrCreateGroup(workspaceId, name, description) {
  let group = db.prepare('SELECT * FROM groups WHERE workspace_id = ? AND name = ?').get(workspaceId, name);
  if (!group) {
    const id = uid('grp');
    db.prepare('INSERT INTO groups (id, workspace_id, name, description) VALUES (?,?,?,?)').run(id, workspaceId, name, description);
    group = db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
  }
  return group;
}

export const cabGroup = (workspaceId) =>
  findOrCreateGroup(workspaceId, CAB_GROUP_NAME, 'Reviews and approves Normal changes at scheduled sittings.');
export const ecabGroup = (workspaceId) =>
  findOrCreateGroup(workspaceId, ECAB_GROUP_NAME, 'Approves Emergency changes immediately, out of band.');

export function ensureDefaultRoutes(workspaceId) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM change_approval_routes WHERE workspace_id = ?').get(workspaceId);
  if (c > 0) return;

  const make = (name, matchType, matchBand, steps) => {
    const routeId = uid('car');
    db.prepare(
      'INSERT INTO change_approval_routes (id, workspace_id, name, match_change_type, match_risk_band) VALUES (?,?,?,?,?)'
    ).run(routeId, workspaceId, name, matchType, matchBand);
    steps.forEach((s, i) => {
      db.prepare(
        'INSERT INTO change_approval_route_steps (id, route_id, step_order, approver_type, approver_id, sla_hours, quorum) VALUES (?,?,?,?,?,?,?)'
      ).run(uid('cars'), routeId, i + 1, s.approver_type, s.approver_id || null, s.sla_hours ?? null, s.quorum ?? 1);
    });
  };

  // Normal: the requester's manager signs off first for anything above low
  // risk, then the CAB. A low-risk Normal change goes straight to the CAB.
  make('Normal change — CAB', 'normal', null, [
    { approver_type: 'cab_group', sla_hours: 72, quorum: 2 },
  ]);
  make('Normal change — high risk', 'normal', 'high', [
    { approver_type: 'requester_manager', sla_hours: 24, quorum: 1 },
    { approver_type: 'cab_group', sla_hours: 72, quorum: 2 },
  ]);
  make('Normal change — critical risk', 'normal', 'critical', [
    { approver_type: 'requester_manager', sla_hours: 24, quorum: 1 },
    { approver_type: 'cab_group', sla_hours: 72, quorum: 3 },
  ]);
  make('Emergency change — ECAB', 'emergency', null, [
    { approver_type: 'ecab_group', sla_hours: 1, quorum: 1 },
  ]);
  make('Expedited change', 'expedite', null, [
    { approver_type: 'cab_group', sla_hours: 4, quorum: 1 },
  ]);
}

export function listRoutes(workspaceId, { includeDisabled = false } = {}) {
  ensureDefaultRoutes(workspaceId);
  const routes = db.prepare(
    `SELECT * FROM change_approval_routes WHERE workspace_id = ?${includeDisabled ? '' : ' AND enabled = 1'}
     ORDER BY created_at ASC`
  ).all(workspaceId);
  for (const route of routes) {
    route.steps = db.prepare(
      'SELECT * FROM change_approval_route_steps WHERE route_id = ? ORDER BY step_order ASC'
    ).all(route.id);
  }
  return routes;
}

// Most-specific-wins, matching findSlaPolicy (sla.js) and
// findAssignmentPolicy (assignmentEngine.js).
export function findRoute(workspaceId, { changeType, riskBand } = {}) {
  const routes = listRoutes(workspaceId);
  let best = null;
  let bestScore = -1;
  for (const route of routes) {
    if (route.match_change_type && route.match_change_type !== changeType) continue;
    if (route.match_risk_band && route.match_risk_band !== riskBand) continue;
    const score = (route.match_change_type ? 1 : 0) + (route.match_risk_band ? 1 : 0);
    if (score > bestScore) { best = route; bestScore = score; }
  }
  return best;
}

// Who may act on one route step. Returns user rows; an empty result means
// the step cannot be satisfied and is reported to the caller rather than
// silently creating an unapprovable change.
function resolveApprovers(workspaceId, step, ticket) {
  const activeMembers = (extraSql = '', params = []) => db.prepare(
    `SELECT u.id, u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND wm.active = 1 AND wm.role IN ('admin','agent') ${extraSql}`
  ).all(workspaceId, ...params);

  switch (step.approver_type) {
    case 'cab_group':
    case 'ecab_group':
    case 'group': {
      const groupId = step.approver_type === 'cab_group' ? cabGroup(workspaceId).id
        : step.approver_type === 'ecab_group' ? ecabGroup(workspaceId).id
          : step.approver_id;
      if (!groupId) return [];
      return db.prepare(
        `SELECT u.id, u.name, u.email FROM group_members gm
         JOIN users u ON u.id = gm.user_id
         JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
         WHERE gm.group_id = ? AND wm.active = 1`
      ).all(workspaceId, groupId);
    }
    case 'role':
      return activeMembers('AND wm.role = ?', [step.approver_id || 'admin']);
    case 'user': {
      if (!step.approver_id) return [];
      const u = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(step.approver_id);
      return u ? [u] : [];
    }
    case 'requester_manager': {
      const membership = db.prepare(
        'SELECT manager_id FROM workspace_members WHERE workspace_id = ? AND user_id = ?'
      ).get(workspaceId, ticket.requester_id);
      if (!membership?.manager_id) return [];
      const u = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(membership.manager_id);
      return u ? [u] : [];
    }
    default:
      return [];
  }
}

function slaDueAt(hours) {
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return new Date(Date.now() + hours * 3600000).toISOString();
}

// Builds the approval queue for a change. Replaces any existing queue, so
// re-routing after a risk re-assessment does not leave stale approvals
// behind. Returns what it created, or why it could not.
export function createApprovalQueue(workspaceId, ticket, { actorId = null } = {}) {
  const type = effectiveChangeType(workspaceId, ticket.change_type);
  const route = findRoute(workspaceId, { changeType: ticket.change_type, riskBand: ticket.risk_band });
  if (!route) return { ok: false, error: `No approval route matches a ${ticket.change_type || 'normal'} change at ${ticket.risk_band || 'unassessed'} risk` };
  if (!route.steps.length) return { ok: false, error: `Approval route "${route.name}" has no steps configured` };

  // Only clear rows that are still open -- decided ones are audit history.
  db.prepare("DELETE FROM approvals WHERE ticket_id = ? AND status = 'pending'").run(ticket.id);

  const created = [];
  const unsatisfiable = [];
  for (const step of route.steps) {
    const approvers = resolveApprovers(workspaceId, step, ticket);
    if (!approvers.length) {
      unsatisfiable.push({ step: step.step_order, approver_type: step.approver_type });
      continue;
    }
    const hours = step.sla_hours ?? slaHoursFor(workspaceId, ticket.change_type);
    const due = slaDueAt(hours);
    for (const approver of approvers) {
      const id = uid('apr');
      db.prepare(
        `INSERT INTO approvals (id, ticket_id, approver_id, approver_role, approver_type, route_step_id, step_order, status, sla_due_at)
         VALUES (?,?,?,?,?,?,?,'pending',?)`
      ).run(id, ticket.id, approver.id, null, step.approver_type, step.id, step.step_order, due);
      created.push({ id, step_order: step.step_order, approver_id: approver.id, approver_name: approver.name, sla_due_at: due });
    }
  }

  if (!created.length) {
    return { ok: false, error: `No eligible approvers for route "${route.name}" — check the CAB/ECAB group membership`, unsatisfiable };
  }

  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticket.id, 'updated',
    `Approval route "${route.name}" applied — ${created.length} approver(s) across ${route.steps.length} step(s)`
  );

  // Emergency is the one lane the diagram marks "Immediate", so its
  // approvers are notified at once rather than waiting for a meeting.
  notifyApprovers(workspaceId, ticket, created, { immediate: type?.approval_mode === 'ecab' });

  return { ok: true, route: { id: route.id, name: route.name }, approvals: created, unsatisfiable };
}

function notifyApprovers(workspaceId, ticket, created, { immediate = false } = {}) {
  // Only the first step is asked to act; later steps are notified when the
  // step before them clears, so approvers are not spammed about changes they
  // cannot yet action.
  const firstStep = Math.min(...created.map((a) => a.step_order));
  for (const approval of created.filter((a) => a.step_order === firstStep)) {
    notifyUser(
      approval.approver_id,
      `${immediate ? 'URGENT — ' : ''}Approval needed: ${ticket.number}`,
      `${ticket.number} — ${ticket.title} (${ticket.change_type || 'normal'} change, ${ticket.risk_band || 'unassessed'} risk)`
        + (approval.sla_due_at ? ` · due ${new Date(approval.sla_due_at).toLocaleString()}` : ''),
      `/tickets/${ticket.id}`,
      workspaceId
    );
    const user = db.prepare('SELECT name, email FROM users WHERE id = ?').get(approval.approver_id);
    if (user?.email) {
      sendTemplatedEmail(workspaceId, 'cab_approval_requested', user.email, {
        'approver.name': user.name,
        'requester.name': ticket.requester_name || '',
        'ticket.number': ticket.number,
        'ticket.title': ticket.title,
        'ticket.link': absoluteUrl(`/tickets/${ticket.id}`),
      }).catch((e) => console.error('[change-approval] email error', e.message));
    }
  }
}

export function listApprovals(ticketId) {
  return db.prepare(
    `SELECT a.*, u.name AS approver_name, u.email AS approver_email
     FROM approvals a LEFT JOIN users u ON u.id = a.approver_id
     WHERE a.ticket_id = ? ORDER BY a.step_order ASC, a.created_at ASC`
  ).all(ticketId);
}

// The step a change is currently waiting on: the lowest step_order that
// still has pending rows.
export function currentStep(ticketId) {
  const row = db.prepare(
    "SELECT MIN(step_order) s FROM approvals WHERE ticket_id = ? AND status = 'pending'"
  ).get(ticketId);
  return row?.s ?? null;
}

function stepQuorum(routeStepId) {
  if (!routeStepId) return 1;
  const row = db.prepare('SELECT quorum FROM change_approval_route_steps WHERE id = ?').get(routeStepId);
  return Math.max(1, Number(row?.quorum) || 1);
}

// Records one approver's decision.
//
// A rejection is terminal for the whole change -- the diagram's CAB lane
// routes a rejected change back to the requester -- so every remaining
// pending row is closed out rather than left hanging.
export function recordDecision(workspaceId, ticketId, approvalId, { decision, comments = null, conditions = null, actor = null } = {}) {
  if (!DECISIONS.includes(decision)) return { ok: false, error: `Unknown decision "${decision}"` };

  const approval = db.prepare(
    'SELECT a.* FROM approvals a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ? AND a.ticket_id = ? AND t.workspace_id = ?'
  ).get(approvalId, ticketId, workspaceId);
  if (!approval) return { ok: false, error: 'Approval not found' };
  if (approval.status !== 'pending') return { ok: false, error: 'That approval has already been decided' };

  // Only the step currently in play may be decided, so a later approver
  // cannot pre-approve past an earlier gate.
  const step = currentStep(ticketId);
  if (step !== null && approval.step_order !== step) {
    return { ok: false, error: `Step ${step} must be decided first` };
  }

  if (decision === 'deferred') {
    // A deferral leaves the row pending but records that it was discussed --
    // the change simply waits for the next sitting.
    db.prepare('UPDATE approvals SET comments = ? WHERE id = ?').run(comments || 'Deferred', approvalId);
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
      uid('h'), ticketId, 'updated', `Approval deferred by ${actor?.name || 'an approver'}${comments ? `: ${comments}` : ''}`
    );
    return { ok: true, deferred: true };
  }

  const storedStatus = decision === 'rejected' ? 'rejected' : 'approved';
  db.prepare(
    "UPDATE approvals SET status = ?, comments = ?, conditions = ?, decided_at = datetime('now') WHERE id = ?"
  ).run(storedStatus, comments || null, decision === 'approved_with_conditions' ? (conditions || comments || 'Conditions recorded') : null, approvalId);

  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticketId, storedStatus === 'rejected' ? 'rejected' : 'approved',
    `${decision.replace(/_/g, ' ')} by ${actor?.name || 'an approver'}${comments ? `: ${comments}` : ''}`
  );

  if (storedStatus === 'rejected') {
    db.prepare("UPDATE approvals SET status = 'not_required' WHERE ticket_id = ? AND status = 'pending'").run(ticketId);
    db.prepare("UPDATE tickets SET cab_status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(ticketId);
    return { ok: true, rejected: true, queueCleared: true };
  }

  // Quorum: once this step has enough approvals, close the rest of it and
  // notify the next step's approvers.
  const quorum = stepQuorum(approval.route_step_id);
  const approvedInStep = db.prepare(
    "SELECT COUNT(*) c FROM approvals WHERE ticket_id = ? AND step_order = ? AND status = 'approved'"
  ).get(ticketId, approval.step_order).c;

  let stepComplete = false;
  if (approvedInStep >= quorum) {
    stepComplete = true;
    db.prepare(
      "UPDATE approvals SET status = 'not_required' WHERE ticket_id = ? AND step_order = ? AND status = 'pending'"
    ).run(ticketId, approval.step_order);

    const nextStep = currentStep(ticketId);
    if (nextStep !== null) {
      const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
      const next = db.prepare(
        "SELECT a.*, u.name AS approver_name FROM approvals a LEFT JOIN users u ON u.id = a.approver_id WHERE a.ticket_id = ? AND a.step_order = ? AND a.status = 'pending'"
      ).all(ticketId, nextStep);
      notifyApprovers(workspaceId, ticket, next.map((a) => ({
        step_order: a.step_order, approver_id: a.approver_id, approver_name: a.approver_name, sla_due_at: a.sla_due_at,
      })));
    }
  }

  const remaining = db.prepare("SELECT COUNT(*) c FROM approvals WHERE ticket_id = ? AND status = 'pending'").get(ticketId).c;
  return {
    ok: true,
    stepComplete,
    quorum,
    approvedInStep,
    fullyApproved: remaining === 0,
    withConditions: decision === 'approved_with_conditions',
  };
}

// SLA breach sweep, called from the scheduler tick. Nothing reads a missed
// approval deadline into existence, which is the bar the existing schedulers
// document for being real background work.
export function sweepApprovalSlaBreaches() {
  const breached = db.prepare(
    `SELECT a.*, t.workspace_id, t.number, t.title, t.requester_id, t.assignee_id
     FROM approvals a JOIN tickets t ON t.id = a.ticket_id
     WHERE a.status = 'pending' AND COALESCE(a.sla_breached, 0) = 0
       AND a.sla_due_at IS NOT NULL AND datetime(a.sla_due_at) < datetime('now')`
  ).all();

  for (const row of breached) {
    db.prepare('UPDATE approvals SET sla_breached = 1 WHERE id = ?').run(row.id);
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
      uid('h'), row.ticket_id, 'escalated',
      `Approval SLA breached at step ${row.step_order} (due ${row.sla_due_at})`
    );
    // Tell the people who can actually do something about it.
    for (const userId of new Set([row.approver_id, row.assignee_id].filter(Boolean))) {
      notifyUser(
        userId,
        `Approval overdue: ${row.number}`,
        `${row.number} — ${row.title} has passed its approval SLA at step ${row.step_order}.`,
        `/tickets/${row.ticket_id}`,
        row.workspace_id
      );
    }
  }
  return breached.length;
}

// ---- CAB meetings --------------------------------------------------------

export function listMeetings(workspaceId, { from = null, status = null, limit = 50 } = {}) {
  const clauses = ['m.workspace_id = ?'];
  const params = [workspaceId];
  if (status) { clauses.push('m.status = ?'); params.push(status); }
  if (from) { clauses.push("datetime(m.end_at) >= datetime(?)"); params.push(new Date(from).toISOString()); }

  const meetings = db.prepare(
    `SELECT m.*, u.name AS chair_name FROM cab_meetings m LEFT JOIN users u ON u.id = m.chair_id
     WHERE ${clauses.join(' AND ')} ORDER BY m.start_at ASC LIMIT ?`
  ).all(...params, Math.min(200, limit));

  for (const meeting of meetings) {
    meeting.agenda = db.prepare(
      `SELECT ai.*, t.number, t.title, t.change_type, t.risk_band, t.risk_score, t.change_state, t.scheduled_start,
              d.name AS decided_by_name
       FROM cab_agenda_items ai
       JOIN tickets t ON t.id = ai.ticket_id
       LEFT JOIN users d ON d.id = ai.decided_by
       WHERE ai.meeting_id = ? ORDER BY ai.sort_order ASC, ai.created_at ASC`
    ).all(meeting.id);
    meeting.attendance = db.prepare(
      `SELECT a.*, u.name FROM cab_attendance a JOIN users u ON u.id = a.user_id WHERE a.meeting_id = ?`
    ).all(meeting.id);
  }
  return meetings;
}

export function createMeeting(workspaceId, { title, kind = 'cab', start_at, end_at, chair_id = null, quorum = 1, actorId = null }) {
  if (!title || !String(title).trim()) return { ok: false, error: 'A meeting title is required' };
  const start = new Date(start_at);
  const end = new Date(end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return { ok: false, error: 'Valid start and end times are required' };
  if (end <= start) return { ok: false, error: 'The meeting must end after it starts' };
  if (!['cab', 'ecab'].includes(kind)) return { ok: false, error: 'kind must be cab or ecab' };

  const id = uid('cabm');
  db.prepare(
    'INSERT INTO cab_meetings (id, workspace_id, title, kind, start_at, end_at, chair_id, quorum, created_by) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, workspaceId, String(title).trim(), kind, start.toISOString(), end.toISOString(), chair_id, Math.max(1, Number(quorum) || 1), actorId);

  // Seat the relevant board as expected attendees.
  const group = kind === 'ecab' ? ecabGroup(workspaceId) : cabGroup(workspaceId);
  const members = db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(group.id);
  for (const m of members) {
    db.prepare('INSERT OR IGNORE INTO cab_attendance (id, meeting_id, user_id, present) VALUES (?,?,?,0)').run(uid('caba'), id, m.user_id);
  }
  return { ok: true, meetingId: id };
}

export function addToAgenda(workspaceId, meetingId, ticketId) {
  const meeting = db.prepare('SELECT * FROM cab_meetings WHERE id = ? AND workspace_id = ?').get(meetingId, workspaceId);
  if (!meeting) return { ok: false, error: 'Meeting not found' };
  if (['closed', 'cancelled'].includes(meeting.status)) return { ok: false, error: 'That meeting is already closed' };

  const ticket = db.prepare("SELECT * FROM tickets WHERE id = ? AND workspace_id = ? AND type = 'change'").get(ticketId, workspaceId);
  if (!ticket) return { ok: false, error: 'Change not found' };

  const existing = db.prepare('SELECT id FROM cab_agenda_items WHERE meeting_id = ? AND ticket_id = ?').get(meetingId, ticketId);
  if (existing) return { ok: true, alreadyOnAgenda: true, itemId: existing.id };

  const nextOrder = (db.prepare('SELECT MAX(sort_order) m FROM cab_agenda_items WHERE meeting_id = ?').get(meetingId).m ?? -1) + 1;
  const id = uid('caba');
  db.prepare('INSERT INTO cab_agenda_items (id, meeting_id, ticket_id, sort_order) VALUES (?,?,?,?)').run(id, meetingId, ticketId, nextOrder);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticketId, 'updated', `Added to CAB agenda: ${meeting.title}`
  );
  return { ok: true, itemId: id };
}

export function removeFromAgenda(workspaceId, itemId) {
  const item = db.prepare(
    'SELECT ai.* FROM cab_agenda_items ai JOIN cab_meetings m ON m.id = ai.meeting_id WHERE ai.id = ? AND m.workspace_id = ?'
  ).get(itemId, workspaceId);
  if (!item) return { ok: false, error: 'Agenda item not found' };
  if (item.decision) return { ok: false, error: 'That item already carries a decision and is part of the meeting record' };
  db.prepare('DELETE FROM cab_agenda_items WHERE id = ?').run(itemId);
  return { ok: true };
}

// Records the board's decision on one agenda item and applies it to that
// change's approval queue, so a meeting decision and the approval trail can
// never disagree.
export function decideAgendaItem(workspaceId, itemId, { decision, conditions = null, notes = null, actor = null } = {}) {
  if (!DECISIONS.includes(decision)) return { ok: false, error: `Unknown decision "${decision}"` };

  const item = db.prepare(
    'SELECT ai.*, m.workspace_id, m.quorum, m.title AS meeting_title FROM cab_agenda_items ai JOIN cab_meetings m ON m.id = ai.meeting_id WHERE ai.id = ? AND m.workspace_id = ?'
  ).get(itemId, workspaceId);
  if (!item) return { ok: false, error: 'Agenda item not found' };

  db.prepare(
    "UPDATE cab_agenda_items SET decision = ?, conditions = ?, notes = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?"
  ).run(decision, conditions, notes, actor?.id || null, itemId);

  if (decision === 'deferred') {
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
      uid('h'), item.ticket_id, 'updated', `Deferred at ${item.meeting_title}${notes ? `: ${notes}` : ''}`
    );
    return { ok: true, deferred: true };
  }

  // Apply the board's decision to every CAB row still pending on this
  // change. A meeting decision is the board acting collectively, so it
  // satisfies the step in one act rather than needing each member to click.
  const pending = db.prepare(
    "SELECT id FROM approvals WHERE ticket_id = ? AND status = 'pending' AND approver_type IN ('cab_group','ecab_group')"
  ).all(item.ticket_id);

  if (!pending.length) {
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
      uid('h'), item.ticket_id, 'updated',
      `${decision.replace(/_/g, ' ')} at ${item.meeting_title} (no open CAB approval to apply it to)`
    );
    return { ok: true, applied: false, reason: 'No open CAB approval on that change' };
  }

  const status = decision === 'rejected' ? 'rejected' : 'approved';
  for (const row of pending) {
    db.prepare(
      "UPDATE approvals SET status = ?, comments = ?, conditions = ?, decided_at = datetime('now') WHERE id = ?"
    ).run(
      status,
      `${decision.replace(/_/g, ' ')} at ${item.meeting_title}${notes ? ` — ${notes}` : ''}`,
      decision === 'approved_with_conditions' ? (conditions || 'Conditions recorded') : null,
      row.id
    );
  }

  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), item.ticket_id, status === 'rejected' ? 'rejected' : 'approved',
    `CAB ${decision.replace(/_/g, ' ')} at ${item.meeting_title}${conditions ? ` — conditions: ${conditions}` : ''}`
  );

  if (status === 'rejected') {
    db.prepare("UPDATE approvals SET status = 'not_required' WHERE ticket_id = ? AND status = 'pending'").run(item.ticket_id);
    db.prepare("UPDATE tickets SET cab_status = 'rejected' WHERE id = ?").run(item.ticket_id);
  }

  const remaining = db.prepare("SELECT COUNT(*) c FROM approvals WHERE ticket_id = ? AND status = 'pending'").get(item.ticket_id).c;
  return { ok: true, applied: true, rejected: status === 'rejected', fullyApproved: remaining === 0 };
}

export function setMeetingStatus(workspaceId, meetingId, status, { minutes = null } = {}) {
  if (!['scheduled', 'in_session', 'closed', 'cancelled'].includes(status)) return { ok: false, error: 'Invalid meeting status' };
  const meeting = db.prepare('SELECT * FROM cab_meetings WHERE id = ? AND workspace_id = ?').get(meetingId, workspaceId);
  if (!meeting) return { ok: false, error: 'Meeting not found' };

  // A meeting cannot close with business unfinished -- that is exactly how
  // changes silently fall off a CAB agenda.
  if (status === 'closed') {
    const undecided = db.prepare('SELECT COUNT(*) c FROM cab_agenda_items WHERE meeting_id = ? AND decision IS NULL').get(meetingId).c;
    if (undecided > 0) return { ok: false, error: `${undecided} agenda item(s) still have no decision` };
  }

  db.prepare('UPDATE cab_meetings SET status = ?, minutes = COALESCE(?, minutes) WHERE id = ?').run(status, minutes, meetingId);
  return { ok: true };
}

export function markAttendance(workspaceId, meetingId, userId, present) {
  const meeting = db.prepare('SELECT id FROM cab_meetings WHERE id = ? AND workspace_id = ?').get(meetingId, workspaceId);
  if (!meeting) return { ok: false, error: 'Meeting not found' };
  const existing = db.prepare('SELECT id FROM cab_attendance WHERE meeting_id = ? AND user_id = ?').get(meetingId, userId);
  if (existing) db.prepare('UPDATE cab_attendance SET present = ? WHERE id = ?').run(present ? 1 : 0, existing.id);
  else db.prepare('INSERT INTO cab_attendance (id, meeting_id, user_id, present) VALUES (?,?,?,?)').run(uid('caba'), meetingId, userId, present ? 1 : 0);
  return { ok: true };
}

// Changes waiting on the CAB and not yet on any open agenda -- the backlog a
// chair builds the next sitting from.
export function awaitingCab(workspaceId) {
  return db.prepare(
    `SELECT DISTINCT t.id, t.number, t.title, t.change_type, t.risk_band, t.risk_score, t.scheduled_start, t.planned_start
     FROM tickets t
     JOIN approvals a ON a.ticket_id = t.id
     WHERE t.workspace_id = ? AND t.type = 'change' AND t.change_state = 'pending_approval'
       AND a.status = 'pending' AND a.approver_type IN ('cab_group','ecab_group')
       AND NOT EXISTS (
         SELECT 1 FROM cab_agenda_items ai JOIN cab_meetings m ON m.id = ai.meeting_id
         WHERE ai.ticket_id = t.id AND ai.decision IS NULL AND m.status IN ('scheduled','in_session')
       )
     ORDER BY CASE t.risk_band WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, t.created_at ASC`
  ).all(workspaceId);
}
