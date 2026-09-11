// Escalation Rules engine. No scheduler/cron exists anywhere in this app by
// design (see server/src/services/ticketNumbering.js and friends for the
// same "compute at read/write time" philosophy) -- so instead of a
// background job ticking every minute, evaluateEscalations() runs whenever
// a ticket is actually read or written (GET /tickets, GET /tickets/:id,
// POST/PATCH on a ticket). In practice that covers every active ticket
// almost immediately, since dashboards and ticket lists are viewed/polled
// continuously -- but it is genuinely access-triggered, not time-triggered,
// and that distinction matters if this is ever demoed as "real-time."
import { db, uid } from '../db.js';
import { notifyUser, notifyRole } from './notifications.js';
import { sendTemplatedEmail, absoluteUrl } from './emailService.js';

const PRIORITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

// Same specificity-scoring approach as findSlaPolicy in sla.js: the policy
// that matches the most non-null fields wins.
export function findEscalationPolicy(workspaceId, { type, priority, team }) {
  const policies = db.prepare('SELECT * FROM escalation_policies WHERE workspace_id = ? AND enabled = 1').all(workspaceId);
  let best = null;
  let bestScore = -1;
  for (const p of policies) {
    if (p.ticket_type && p.ticket_type !== type) continue;
    if (p.priority && p.priority !== priority) continue;
    if (p.team && p.team !== team) continue;
    const score = (p.ticket_type ? 1 : 0) + (p.priority ? 1 : 0) + (p.team ? 1 : 0);
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}

function elapsedPct(ticket) {
  if (!ticket.sla_due_at) return null;
  const created = new Date(ticket.created_at).getTime();
  const due = new Date(ticket.sla_due_at).getTime();
  if (!(due > created)) return 100;
  return ((Date.now() - created) / (due - created)) * 100;
}

// Evaluates one ticket against its matching policy's levels, firing any
// level whose threshold has newly been crossed. Safe to call as often as
// you like -- ticket_escalations' UNIQUE(ticket_id, level_id) means a level
// only ever fires once per ticket, so repeated evaluation (e.g. on every
// ticket-list page load) is idempotent, not spammy.
export function evaluateEscalations(ticket) {
  if (!ticket || ['resolved', 'closed'].includes(ticket.status)) return [];
  const pct = elapsedPct(ticket);
  if (pct === null) return [];

  const policy = findEscalationPolicy(ticket.workspace_id, { type: ticket.type, priority: ticket.priority, team: ticket.team });
  if (!policy) return [];

  const levels = db.prepare('SELECT * FROM escalation_levels WHERE policy_id = ? AND threshold_pct <= ? ORDER BY level_order ASC').all(policy.id, pct);
  if (!levels.length) return [];

  const alreadyFired = new Set(
    db.prepare('SELECT level_id FROM ticket_escalations WHERE ticket_id = ?').all(ticket.id).map((r) => r.level_id)
  );

  const newlyFired = [];
  for (const level of levels) {
    if (alreadyFired.has(level.id)) continue;

    // Priority only ever moves up on escalation, never down -- a level
    // configured to "bump to medium" should never demote an already-
    // critical ticket just because it also crossed an earlier threshold.
    if (level.set_priority && (PRIORITY_RANK[level.set_priority] ?? -1) > (PRIORITY_RANK[ticket.priority] ?? -1)) {
      db.prepare("UPDATE tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(level.set_priority, ticket.id);
      ticket = { ...ticket, priority: level.set_priority };
    }

    const detail = `Escalation level ${level.level_order} (${level.threshold_pct}% of SLA elapsed)` + (level.set_priority ? ` — priority raised to ${level.set_priority}` : '');
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), ticket.id, 'escalated', detail);
    if (level.post_comment) {
      db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_id, author_name, body, is_private) VALUES (?,?,?,?,?,1)').run(
        uid('cmt'), ticket.id, null, 'Escalation', `${detail}.`
      );
    }
    const escalationVars = {
      'ticket.number': ticket.number, 'ticket.title': ticket.title, 'ticket.priority': ticket.priority,
      'escalation.level': String(level.level_order), 'escalation.detail': detail, 'ticket.link': absoluteUrl(`/tickets/${ticket.id}`),
    };
    if (level.notify_user_id) {
      notifyUser(level.notify_user_id, `Escalation: ${ticket.number}`, `${ticket.number} — ${ticket.title} has reached escalation level ${level.level_order}.`, `/tickets/${ticket.id}`, ticket.workspace_id);
      const notifiedAgent = db.prepare('SELECT name, email FROM users WHERE id = ?').get(level.notify_user_id);
      if (notifiedAgent?.email) {
        sendTemplatedEmail(ticket.workspace_id, 'escalation_alert', notifiedAgent.email, { 'agent.name': notifiedAgent.name, ...escalationVars }).catch((e) => console.error('escalation alert email error', e));
      }
    }
    if (level.notify_role) {
      notifyRole(level.notify_role, `Escalation: ${ticket.number}`, `${ticket.number} — ${ticket.title} has reached escalation level ${level.level_order}.`, `/tickets/${ticket.id}`, ticket.workspace_id);
      const roleMembers = db.prepare(
        `SELECT u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND wm.role = ? AND wm.active = 1`
      ).all(ticket.workspace_id, level.notify_role);
      for (const m of roleMembers) {
        if (m.email) sendTemplatedEmail(ticket.workspace_id, 'escalation_alert', m.email, { 'agent.name': m.name, ...escalationVars }).catch((e) => console.error('escalation alert email error', e));
      }
    }

    db.prepare('INSERT INTO ticket_escalations (id, ticket_id, level_id) VALUES (?,?,?)').run(uid('esc'), ticket.id, level.id);
    newlyFired.push(level);
  }
  return newlyFired;
}

// Fire-and-forget wrapper for route handlers -- escalation is a side effect
// of reading/writing a ticket, never something that should fail the actual
// request if something about it goes wrong.
export function evaluateEscalationsSafely(ticket) {
  try {
    evaluateEscalations(ticket);
  } catch (e) {
    console.error('escalation evaluation error', e);
  }
}
