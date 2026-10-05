// Post Implementation Review -- the flow diagram's "Trigger PIR", "Capture
// Lessons Learned" and "PIR Completed" steps.
//
// A PIR is required when the change type says so for the change's risk band
// (Normal: high and critical; Emergency: always). changeWorkflow.js's
// guardPirComplete refuses to close a change whose PIR is required and
// unfinished, which is the only thing that stops a PIR being a box nobody
// ever ticks.
import { db, uid } from '../db.js';
import { pirRequiredFor } from './changeTypes.js';
import { notifyUser } from './notifications.js';

export const OUTCOMES = ['successful', 'successful_with_issues', 'failed', 'rolled_back'];

export function isPirRequired(workspaceId, ticket) {
  if (ticket.pir_required) return true;
  return pirRequiredFor(workspaceId, ticket.change_type, ticket.risk_band);
}

export function getPir(ticketId) {
  const row = db.prepare('SELECT * FROM change_pir WHERE ticket_id = ?').get(ticketId);
  if (!row) return null;
  return { ...row, met_objectives: row.met_objectives === null ? null : !!row.met_objectives, caused_incident: !!row.caused_incident };
}

// Opens the review. Called when a change reaches Implemented or Rolled Back,
// and idempotent so a re-entered state does not create a second one.
export function openPir(workspaceId, ticket, { actorId = null } = {}) {
  const existing = getPir(ticket.id);
  if (existing) return { ok: true, alreadyOpen: true, pir: existing };

  const required = isPirRequired(workspaceId, ticket);
  const id = uid('pir');
  // A rolled-back change has its outcome pre-filled: it is not in question.
  const presetOutcome = ticket.change_state === 'rolled_back' ? 'rolled_back' : null;
  db.prepare('INSERT INTO change_pir (id, workspace_id, ticket_id, outcome) VALUES (?,?,?,?)')
    .run(id, workspaceId, ticket.id, presetOutcome);

  if (required) {
    db.prepare('UPDATE tickets SET pir_required = 1 WHERE id = ?').run(ticket.id);
  }

  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticket.id, 'updated',
    required
      ? 'Post-implementation review opened (required for this change type and risk band)'
      : 'Post-implementation review opened'
  );

  // The diagram's "PIR Reminder" notification.
  const reviewer = ticket.assignee_id || ticket.requester_id;
  if (required && reviewer) {
    notifyUser(
      reviewer,
      `PIR required: ${ticket.number}`,
      `${ticket.number} — ${ticket.title} needs a post-implementation review before it can be closed.`,
      `/tickets/${ticket.id}`,
      workspaceId
    );
  }

  return { ok: true, required, pir: getPir(ticket.id) };
}

export function updatePir(workspaceId, ticketId, fields = {}) {
  const pir = db.prepare(
    'SELECT p.* FROM change_pir p JOIN tickets t ON t.id = p.ticket_id WHERE p.ticket_id = ? AND t.workspace_id = ?'
  ).get(ticketId, workspaceId);
  if (!pir) return { ok: false, error: 'No post-implementation review has been opened for that change' };
  if (pir.completed_at) return { ok: false, error: 'That review is already complete' };

  if (fields.outcome !== undefined && fields.outcome !== null && !OUTCOMES.includes(fields.outcome)) {
    return { ok: false, error: `Unknown outcome "${fields.outcome}"` };
  }

  const bool = (v) => (v === undefined ? undefined : (v === null ? null : (v ? 1 : 0)));
  const next = {
    outcome: fields.outcome !== undefined ? fields.outcome : pir.outcome,
    met_objectives: bool(fields.met_objectives) !== undefined ? bool(fields.met_objectives) : pir.met_objectives,
    caused_incident: bool(fields.caused_incident) !== undefined ? bool(fields.caused_incident) : pir.caused_incident,
    incident_ticket_id: fields.incident_ticket_id !== undefined ? fields.incident_ticket_id : pir.incident_ticket_id,
    lessons_learned: fields.lessons_learned !== undefined ? fields.lessons_learned : pir.lessons_learned,
    follow_up_actions: fields.follow_up_actions !== undefined ? fields.follow_up_actions : pir.follow_up_actions,
  };

  db.prepare(
    `UPDATE change_pir SET outcome = ?, met_objectives = ?, caused_incident = ?, incident_ticket_id = ?,
       lessons_learned = ?, follow_up_actions = ? WHERE id = ?`
  ).run(
    next.outcome, next.met_objectives, next.caused_incident, next.incident_ticket_id,
    next.lessons_learned, next.follow_up_actions, pir.id
  );
  return { ok: true, pir: getPir(ticketId) };
}

// Completing the review is what unlocks closure. Deliberately demands an
// outcome and lessons learned -- a review with neither is not a review, and
// the entire value of a PIR is the write-up nobody wants to do.
export function completePir(workspaceId, ticketId, { actor = null } = {}) {
  const pir = getPir(ticketId);
  if (!pir) return { ok: false, error: 'No post-implementation review has been opened for that change' };
  if (pir.completed_at) return { ok: true, alreadyComplete: true, pir };

  if (!pir.outcome) return { ok: false, error: 'Record the outcome before completing the review' };
  if (!String(pir.lessons_learned || '').trim()) {
    return { ok: false, error: 'Record what was learned before completing the review' };
  }

  db.prepare("UPDATE change_pir SET completed_at = datetime('now'), reviewed_by = ? WHERE id = ?")
    .run(actor?.id || null, pir.id);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticketId, 'updated',
    `Post-implementation review completed — outcome: ${pir.outcome.replace(/_/g, ' ')}`
  );
  return { ok: true, pir: getPir(ticketId) };
}

// Changes sitting in Implemented or Rolled Back with a required PIR still
// outstanding. Driven from the scheduler tick for the diagram's "PIR
// Reminder", and surfaced in the change workspace as a work queue.
export function outstandingPirs(workspaceId) {
  return db.prepare(
    `SELECT t.id, t.number, t.title, t.change_state, t.risk_band, t.assignee_id, t.actual_end,
            p.id AS pir_id, p.outcome, p.lessons_learned
     FROM tickets t
     LEFT JOIN change_pir p ON p.ticket_id = t.id
     WHERE t.workspace_id = ? AND t.type = 'change'
       AND t.change_state IN ('implemented','rolled_back')
       AND COALESCE(t.pir_required, 0) = 1
       AND (p.id IS NULL OR p.completed_at IS NULL)
     ORDER BY t.actual_end ASC`
  ).all(workspaceId);
}
