// The ten-state change lifecycle from the flow diagram, as a guarded state
// machine.
//
// Why this and not the generic lifecycle engine: lifecycleEngine.js gates
// transitions on role and simple field comparisons, which cannot express
// "In Progress requires the change to be both approved AND to hold a
// reserved calendar slot" or "Closed requires a completed PIR when the risk
// band demands one". Those are the gates that make change management
// actually control anything, so they live here as real predicates.
//
// tickets.change_state is authoritative for a change; tickets.status is
// written to the matching bucket on every transition so that every existing
// status-based query, filter, report and SLA calculation keeps working
// without knowing change states exist. That mirrors how lifecycleEngine.js
// already derives status from a stage's bucket.
//
// transition() is the single entry point. It evaluates guards, writes
// change_state_transitions (the audit table the diagram's developer notes
// ask for) and fires integration webhooks -- so no call site can move a
// change without leaving a trail.
import { db, uid } from '../db.js';
import { pirRequiredFor, requiresBackout, effectiveChangeType } from './changeTypes.js';
import { notifyUser } from './notifications.js';
import { broadcastToWorkspace } from './realtime.js';
import { sendIntegrationMessage, getEnabledIntegrations } from './notify.js';

// state -> the tickets.status bucket it maps onto.
export const CHANGE_STATES = {
  new: { label: 'New', bucket: 'open', description: 'Change request created' },
  in_review: { label: 'In Review', bucket: 'open', description: 'Validation and categorization' },
  pending_approval: { label: 'Pending Approval', bucket: 'pending_approval', description: 'Waiting for CAB / ECAB / approver' },
  approved: { label: 'Approved', bucket: 'open', description: 'Change approved' },
  scheduled: { label: 'Scheduled', bucket: 'open', description: 'Scheduled for implementation' },
  in_progress: { label: 'In Progress', bucket: 'in_progress', description: 'Implementation started' },
  implemented: { label: 'Implemented', bucket: 'in_progress', description: 'Implementation completed' },
  rolled_back: { label: 'Rolled Back', bucket: 'in_progress', description: 'Backout executed' },
  closed: { label: 'Closed', bucket: 'closed', description: 'Change closed' },
  reopened: { label: 'Reopened', bucket: 'open', description: 'Change reopened after a failure' },
};

export const STATE_KEYS = Object.keys(CHANGE_STATES);

// ---- guards --------------------------------------------------------------
// Each returns null when satisfied, or a human-readable reason when not.
// They are returned to the caller rather than thrown, so the UI can explain
// a disabled transition instead of just greying it out.

function guardMandatoryFields(ctx) {
  const type = effectiveChangeType(ctx.workspaceId, ctx.ticket.change_type);
  const missing = [];
  for (const field of type?.mandatory_fields || []) {
    // 'justification' has no column of its own -- an Expedite change states
    // its case in the description, which is already mandatory for that type.
    if (field === 'justification') continue;
    const value = ctx.ticket[field];
    if (value === null || value === undefined || String(value).trim() === '') missing.push(field);
  }
  if (missing.length) return `Missing required field(s) for a ${type?.label || 'change'} change: ${missing.join(', ')}`;
  return null;
}

function guardClassified(ctx) {
  if (!ctx.ticket.change_type) return 'The change has not been categorized yet (no change type set)';
  if (ctx.ticket.risk_band === null || ctx.ticket.risk_band === undefined || ctx.ticket.risk_band === '') {
    return 'Risk has not been assessed yet';
  }
  return null;
}

function guardApproved(ctx) {
  const pending = db.prepare("SELECT COUNT(*) c FROM approvals WHERE ticket_id = ? AND status = 'pending'").get(ctx.ticket.id).c;
  if (pending > 0) return `${pending} approval(s) still pending`;
  const rejected = db.prepare("SELECT COUNT(*) c FROM approvals WHERE ticket_id = ? AND status = 'rejected'").get(ctx.ticket.id).c;
  if (rejected > 0) return 'The change was rejected by an approver';
  const total = db.prepare('SELECT COUNT(*) c FROM approvals WHERE ticket_id = ?').get(ctx.ticket.id).c;
  if (total === 0) return 'No approval has been recorded for this change';
  return null;
}

function guardScheduled(ctx) {
  if (!ctx.ticket.scheduled_start || !ctx.ticket.scheduled_end) return 'No implementation window has been scheduled';
  const slot = db.prepare(
    "SELECT id FROM change_calendar_slots WHERE ticket_id = ? AND status = 'reserved' LIMIT 1"
  ).get(ctx.ticket.id);
  if (!slot) return 'No calendar slot is reserved for this change';
  return null;
}

// Business rule 8 from the diagram: a backout plan is mandatory for Normal,
// Emergency and Expedite. Enforced at the point it matters -- starting
// implementation -- rather than at creation, so a draft can be saved without
// one.
function guardBackoutPlan(ctx) {
  if (!requiresBackout(ctx.workspaceId, ctx.ticket.change_type)) return null;
  if (!String(ctx.ticket.rollback_plan || '').trim()) {
    return 'A backout plan is required for this change type before implementation can start';
  }
  return null;
}

// Business rule 7: prevent implementation if not approved and scheduled.
function guardReadyToImplement(ctx) {
  return guardApproved(ctx) || guardScheduled(ctx) || guardBackoutPlan(ctx);
}

function guardImplementationTasksDone(ctx) {
  const open = db.prepare(
    "SELECT COUNT(*) c FROM ticket_tasks WHERE ticket_id = ? AND status != 'done'"
  ).get(ctx.ticket.id).c;
  if (open > 0) return `${open} implementation task(s) are still open`;
  return null;
}

// Business rule 9: PIR required for high / critical changes.
function guardPirComplete(ctx) {
  const required = ctx.ticket.pir_required
    || pirRequiredFor(ctx.workspaceId, ctx.ticket.change_type, ctx.ticket.risk_band);
  if (!required) return null;
  const pir = db.prepare('SELECT completed_at FROM change_pir WHERE ticket_id = ?').get(ctx.ticket.id);
  if (!pir) return 'A post-implementation review is required for this change but has not been started';
  if (!pir.completed_at) return 'The post-implementation review has not been completed';
  return null;
}

function guardClosureApproved(ctx) {
  if (!ctx.ticket.closure_approved_by) return 'Closure has not been approved by a change manager';
  return null;
}

// ---- the machine ---------------------------------------------------------
// Each edge names its guards. A transition with no guards is always legal
// from that state.
const TRANSITIONS = {
  new: {
    in_review: { guards: [guardMandatoryFields], label: 'Submit for review' },
  },
  in_review: {
    pending_approval: { guards: [guardClassified], label: 'Send for approval' },
    // The Standard path: a template match auto-approves, bypassing the CAB.
    //
    // Marked internal because it is a step *inside* POST
    // /changes/:id/submit-for-approval, not something anyone should click.
    // Offering it as its own button showed an agent an "Auto-approve" action
    // that could never succeed on its own -- it is only reachable once that
    // handler has written the template's auto-approval row.
    approved: { guards: [guardClassified, guardApproved], label: 'Auto-approve (standard change)', internal: true },
    new: { guards: [], label: 'Return to requester' },
  },
  pending_approval: {
    approved: { guards: [guardApproved], label: 'Record approval' },
    new: { guards: [], label: 'Reject and return to requester' },
  },
  approved: {
    scheduled: { guards: [guardScheduled], label: 'Confirm schedule' },
  },
  scheduled: {
    in_progress: { guards: [guardReadyToImplement], label: 'Start implementation' },
    approved: { guards: [], label: 'Release the scheduled slot' },
  },
  in_progress: {
    implemented: { guards: [guardImplementationTasksDone], label: 'Mark implementation complete' },
    rolled_back: { guards: [], label: 'Execute backout plan' },
  },
  implemented: {
    closed: { guards: [guardPirComplete, guardClosureApproved], label: 'Close change' },
    reopened: { guards: [], label: 'Reopen (validation failed)' },
  },
  rolled_back: {
    reopened: { guards: [], label: 'Reopen to retry' },
    closed: { guards: [guardPirComplete, guardClosureApproved], label: 'Close as rolled back' },
  },
  reopened: {
    scheduled: { guards: [guardScheduled], label: 'Re-schedule' },
    in_progress: { guards: [guardReadyToImplement], label: 'Resume implementation' },
    closed: { guards: [guardPirComplete, guardClosureApproved], label: 'Close without retrying' },
  },
  closed: {},
};

// Outbound integration hook for state changes, per the diagram's "provide
// event hooks/webhooks for external integrations" note. Goes out over the
// generic webhook integrations already configured under Integrations, so
// there is no second delivery mechanism to configure or secure.
// Fire-and-forget by design: an external listener being down must never roll
// back a state change that has already happened.
function emitStateWebhook(workspaceId, payload) {
  let integrations = [];
  try {
    integrations = getEnabledIntegrations(workspaceId, 'webhook');
  } catch (e) {
    console.error('[change] could not read webhook integrations', e.message);
    return;
  }
  for (const integration of integrations) {
    sendIntegrationMessage(integration, {
      event: 'change.state_changed',
      text: `[${payload.number}] ${payload.from_state} → ${payload.to_state}`,
      ...payload,
    }).catch((e) => console.error('[change] webhook delivery failed', e.message));
  }
}

export function currentState(ticket) {
  const state = ticket?.change_state;
  return state && CHANGE_STATES[state] ? state : 'new';
}

// What could this change do next, and for each option whether it is legal
// right now and if not, why. This is what lets the UI show a blocked button
// with a real explanation attached.
export function availableTransitions(workspaceId, ticket) {
  const from = currentState(ticket);
  const ctx = { workspaceId, ticket };
  return Object.entries(TRANSITIONS[from] || {}).map(([to, edge]) => {
    const blockers = edge.guards.map((g) => g(ctx)).filter(Boolean);
    return {
      to,
      label: edge.label,
      state_label: CHANGE_STATES[to].label,
      allowed: blockers.length === 0,
      blockers,
      // Internal edges are real transitions the engine uses, but not actions
      // a person should be offered -- the UI filters on this rather than
      // hardcoding a list of edge names it knows about.
      internal: !!edge.internal,
    };
  });
}

export function canTransition(workspaceId, ticket, to) {
  const from = currentState(ticket);
  const edge = TRANSITIONS[from]?.[to];
  if (!edge) return { allowed: false, blockers: [`A change cannot move from ${CHANGE_STATES[from].label} to ${CHANGE_STATES[to]?.label || to}`] };
  const blockers = edge.guards.map((g) => g({ workspaceId, ticket })).filter(Boolean);
  return { allowed: blockers.length === 0, blockers, edge };
}

// The only way a change's state may change.
//
// `force` exists for one legitimate case: an admin correcting a stuck record.
// It still writes the audit row, still records which guards it overrode, and
// is exposed only to change managers -- an unlogged escape hatch would make
// the audit table untrustworthy.
export function transition(workspaceId, ticketId, to, { actor = null, reason = null, force = false } = {}) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ?').get(ticketId, workspaceId);
  if (!ticket) return { ok: false, error: 'Change not found' };
  if (ticket.type !== 'change') return { ok: false, error: 'That ticket is not a change' };
  if (!CHANGE_STATES[to]) return { ok: false, error: `Unknown change state "${to}"` };

  const from = currentState(ticket);
  if (from === to) return { ok: true, unchanged: true, state: to };

  const check = canTransition(workspaceId, ticket, to);
  if (!check.allowed && !force) {
    return { ok: false, error: check.blockers[0], blockers: check.blockers };
  }

  const bucket = CHANGE_STATES[to].bucket;
  const sets = ["change_state = ?", "status = ?", "updated_at = datetime('now')"];
  const params = [to, bucket];

  // Timestamps that belong to specific edges rather than to a generic update.
  if (to === 'in_progress' && !ticket.actual_start) { sets.push("actual_start = datetime('now')"); }
  if ((to === 'implemented' || to === 'rolled_back') && !ticket.actual_end) { sets.push("actual_end = datetime('now')"); }
  if (to === 'closed') { sets.push("closed_at = datetime('now')"); }
  if (to === 'implemented') { sets.push("resolved_at = COALESCE(resolved_at, datetime('now'))"); }

  db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params, ticketId);

  // Keep the legacy cab_status column meaningful for anything still reading
  // it (the old ChangeManagement list, the public API) rather than leaving
  // it frozen at whatever it was when this module replaced it.
  if (to === 'approved') db.prepare("UPDATE tickets SET cab_status = 'approved' WHERE id = ?").run(ticketId);
  if (to === 'pending_approval') db.prepare("UPDATE tickets SET cab_status = 'pending' WHERE id = ?").run(ticketId);

  db.prepare(
    'INSERT INTO change_state_transitions (id, workspace_id, ticket_id, from_state, to_state, actor_id, actor_name, reason, guards) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(
    uid('cst'), workspaceId, ticketId, from, to,
    actor?.id || null, actor?.name || null, reason || null,
    JSON.stringify({ forced: !!force && !check.allowed, overridden_blockers: check.allowed ? [] : check.blockers })
  );

  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticketId, 'change_state',
    `${CHANGE_STATES[from].label} → ${CHANGE_STATES[to].label}`
      + (reason ? ` — ${reason}` : '')
      + (!check.allowed && force ? ' (forced by a change manager)' : '')
  );

  // Business rule 12: notify at each state change.
  if (ticket.requester_id) {
    notifyUser(
      ticket.requester_id,
      `${ticket.number} is now ${CHANGE_STATES[to].label}`,
      `${ticket.number} — ${ticket.title}${reason ? `: ${reason}` : ''}`,
      `/tickets/${ticketId}`,
      workspaceId
    );
  }
  if (ticket.assignee_id && ticket.assignee_id !== ticket.requester_id) {
    notifyUser(
      ticket.assignee_id,
      `${ticket.number} is now ${CHANGE_STATES[to].label}`,
      `${ticket.number} — ${ticket.title}`,
      `/tickets/${ticketId}`,
      workspaceId
    );
  }

  broadcastToWorkspace(workspaceId, 'ticket.updated', { ticketId });

  emitStateWebhook(workspaceId, {
    ticket_id: ticketId,
    number: ticket.number,
    from_state: from,
    to_state: to,
    change_type: ticket.change_type,
    risk_band: ticket.risk_band,
    actor: actor?.name || null,
    reason: reason || null,
  });

  return { ok: true, from, state: to, forced: !check.allowed && !!force };
}

export function transitionHistory(ticketId) {
  return db.prepare(
    'SELECT * FROM change_state_transitions WHERE ticket_id = ? ORDER BY created_at DESC, id DESC'
  ).all(ticketId).map((r) => {
    let guards = {};
    try { guards = r.guards ? JSON.parse(r.guards) : {}; } catch { guards = {}; }
    return { ...r, guards };
  });
}

// Safe wrapper for call sites where a failed transition must not fail the
// request, matching evaluateEscalationsSafely in escalationEngine.js.
export function transitionSafely(workspaceId, ticketId, to, opts) {
  try {
    return transition(workspaceId, ticketId, to, opts);
  } catch (e) {
    console.error('[change] transition error', e);
    return { ok: false, error: e.message };
  }
}
