// What happens to an alert once it exists: which rule claims it, whether it
// becomes an incident, who gets paged.
//
// Incidents are created through the same columns POST /tickets writes, and
// then run through the same SLA, numbering and routing helpers, so an
// alert-raised incident is indistinguishable from a human-raised one
// downstream -- no parallel "alert ticket" concept to keep in sync.
import { db, uid } from '../db.js';
import { logAlertEvent, getAlert } from './alertIngest.js';
import { findSlaPolicy, computeSlaDueDate } from './sla.js';
import { nextTicketNumber } from './ticketNumbering.js';
import { resolveOnCall, resolveEscalationTargets } from './oncallEngine.js';
import { nextMajorIncidentNumber } from './majorIncidents.js';
import { autoAssign } from './assignmentEngine.js';
import { notifyUser } from './notifications.js';
import { sendTemplatedEmail } from './emailService.js';
import { broadcastToWorkspace } from './realtime.js';

// Severity maps onto ticket priority. 'info' deliberately has no priority:
// an informational alert that matched a create-incident rule still becomes a
// ticket, but at the policy's configured priority or 'low', never 'critical'.
const SEVERITY_TO_PRIORITY = { critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'low' };

// SQLite's datetime('now') emits "YYYY-MM-DD HH:MM:SS" in UTC, with no zone
// marker. `new Date()` on that string applies the *local* zone, so in any
// non-UTC deployment an alert would read as hours old the moment it was
// created -- which would fire every escalation step at once. Appending the
// 'Z' is what keeps the age honest.
function parseSqliteUtc(value) {
  if (!value) return null;
  const s = String(value);
  const normalized = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

function matches(rule, alert) {
  if (rule.match_severity && rule.match_severity !== alert.severity) return false;
  if (rule.match_source_id && rule.match_source_id !== alert.source_id) return false;
  if (rule.match_title_contains) {
    const needle = rule.match_title_contains.toLowerCase();
    if (!String(alert.title || '').toLowerCase().includes(needle)) return false;
  }
  if (rule.match_entity_contains) {
    const needle = rule.match_entity_contains.toLowerCase();
    if (!String(alert.entity || '').toLowerCase().includes(needle)) return false;
  }
  return true;
}

export function findMatchingRules(workspaceId, alert) {
  const rules = db.prepare(
    'SELECT * FROM alert_rules WHERE workspace_id = ? AND enabled = 1 ORDER BY rule_order ASC, created_at ASC'
  ).all(workspaceId);
  const matched = [];
  for (const rule of rules) {
    if (!matches(rule, alert)) continue;
    matched.push(rule);
    // Ordered rules with an explicit stop, like business rules and
    // automations elsewhere in this app -- so a specific rule at the top can
    // claim an alert and prevent a broad catch-all below from also firing.
    if (rule.stop_processing) break;
  }
  return matched;
}

// Creates the incident for an alert. Returns the ticket row.
function createIncidentForAlert(workspaceId, alert, rule) {
  const priority = rule.action_incident_priority || SEVERITY_TO_PRIORITY[alert.severity] || 'medium';
  const id = uid('tkt');
  const number = nextTicketNumber(workspaceId, 'incident');

  const title = alert.entity ? `${alert.title} (${alert.entity})` : alert.title;
  const description = [
    alert.description || '',
    '',
    `Raised automatically from alert ${alert.id}.`,
    alert.entity ? `Affected entity: ${alert.entity}` : null,
    `Severity: ${alert.severity}`,
    alert.occurrence_count > 1 ? `Occurrences so far: ${alert.occurrence_count}` : null,
  ].filter((l) => l !== null).join('\n');

  const policy = findSlaPolicy({
    workspaceId, type: 'incident', priority, category: 'Monitoring',
    subcategory: null, team: null, impact: 'medium', risk: null, source: 'alert', title, description,
  });
  const slaDueAt = computeSlaDueDate(
    policy?.resolution_minutes ?? { critical: 240, high: 480, medium: 1440, low: 4320 }[priority] ?? 1440,
    policy?.business_hours_only, new Date(), workspaceId
  );
  const responseDueAt = computeSlaDueDate(policy?.response_minutes ?? 60, policy?.business_hours_only, new Date(), workspaceId);

  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, priority, impact, category, status,
       requester_id, sla_due_at, response_due_at, sla_policy_id, source)
     VALUES (?,?,?,'incident',?,?,?,'medium','Monitoring','open',NULL,?,?,?,'alert')`
  ).run(id, workspaceId, number, title.slice(0, 300), description, priority, slaDueAt, responseDueAt, policy?.id || null);

  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), id, 'created', `Raised automatically from alert (${alert.severity}) by rule "${rule.name}"`
  );

  db.prepare('UPDATE alerts SET ticket_id = ? WHERE id = ?').run(id, alert.id);
  logAlertEvent(alert.id, 'incident_created', `Created ${number} at priority ${priority}`);

  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

function pageOnCall(workspaceId, alert, scheduleId, ticket) {
  const res = resolveOnCall(scheduleId, new Date());
  if (!res?.user) {
    logAlertEvent(alert.id, 'escalated', `Nobody on call for the configured schedule (${res?.reason || 'unknown'})`);
    return null;
  }
  const link = ticket ? `/tickets/${ticket.id}` : '/admin-settings?section=alertManagement';
  notifyUser(
    res.user.id,
    `Alert: ${alert.title}`,
    `${alert.severity.toUpperCase()} — ${alert.title}${alert.entity ? ` on ${alert.entity}` : ''}. You are on call (${res.reason}).`,
    link,
    workspaceId
  );
  if (res.user.email) {
    sendTemplatedEmail(workspaceId, 'escalation_alert', res.user.email, {
      'agent.name': res.user.name,
      'ticket.number': ticket?.number || alert.id,
      'ticket.title': alert.title,
      'ticket.priority': alert.severity,
      'escalation.level': '1',
      'escalation.detail': `On-call page — ${res.reason}`,
    }).catch((e) => console.error('[alerts] on-call email error', e.message));
  }
  logAlertEvent(alert.id, 'escalated', `Paged ${res.user.name} (step 1, ${res.reason})`);
  return res.user;
}

// Runs an alert through the rule set and executes whatever the first
// matching rule says. Synchronous except for the assignment step, which is
// awaited so an alert-raised incident is already routed by the time the
// webhook responds -- a monitoring tool's retry should not race our routing.
export async function applyAlertRules(workspaceId, alertId) {
  const alert = getAlert(alertId, workspaceId);
  if (!alert) return { applied: false, reason: 'Unknown alert' };
  if (alert.status === 'resolved') return { applied: false, reason: 'Alert is already resolved' };

  const rules = findMatchingRules(workspaceId, alert);
  if (!rules.length) return { applied: false, reason: 'No alert rule matched' };

  const outcome = { applied: true, rules: rules.map((r) => r.name), ticket: null, suppressed: false, paged: null, assigned: null };

  for (const rule of rules) {
    logAlertEvent(alert.id, 'rule_matched', `Matched rule "${rule.name}"`);

    if (rule.action_suppress) {
      db.prepare("UPDATE alerts SET status = 'suppressed' WHERE id = ?").run(alert.id);
      logAlertEvent(alert.id, 'suppressed', `Suppressed by rule "${rule.name}"`);
      outcome.suppressed = true;
      // A suppress rule is terminal by nature -- there is no sense creating
      // an incident for an alert we just decided to ignore.
      return outcome;
    }

    if (rule.action_create_incident && !alert.ticket_id) {
      const ticket = createIncidentForAlert(workspaceId, alert, rule);
      outcome.ticket = ticket;

      if (rule.action_promote_major) {
        // Mirrors POST /major-incidents: its own MI number sequence, a
        // severity from the sev1..sev3 vocabulary, a next-update deadline,
        // and critical as the priority floor for anything declared major.
        const miId = uid('mi');
        const miNumber = nextMajorIncidentNumber(workspaceId);
        const severity = alert.severity === 'critical' ? 'sev1' : 'sev2';
        const intervalMinutes = 30;
        db.prepare(
          `INSERT INTO major_incidents (id, workspace_id, ticket_id, number, severity, status, summary, declared_by, update_interval_minutes, next_update_due_at)
           VALUES (?,?,?,?,?,'active',?,NULL,?,?)`
        ).run(
          miId, workspaceId, ticket.id, miNumber, severity,
          `Declared automatically from a ${alert.severity} alert: ${alert.title}`.slice(0, 500),
          intervalMinutes, new Date(Date.now() + intervalMinutes * 60000).toISOString()
        );
        if (ticket.priority !== 'critical') {
          db.prepare('UPDATE tickets SET priority = ? WHERE id = ?').run('critical', ticket.id);
          ticket.priority = 'critical';
        }
        db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
          uid('h'), ticket.id, 'major_incident_declared', `${miNumber} declared (${severity.toUpperCase()}) automatically from an alert`
        );
        logAlertEvent(alert.id, 'escalated', `Promoted to major incident ${miNumber}`);
      }

      // Route it. autoAssign no-ops when no policy matches, so an alert
      // incident simply stays unassigned rather than erroring.
      try {
        const assigned = await autoAssign(ticket);
        if (assigned) {
          outcome.assigned = assigned;
          logAlertEvent(alert.id, 'escalated', `Incident assigned to ${assigned.name} (${assigned.rationale})`);
        }
      } catch (e) {
        console.error('[alerts] assignment of alert incident failed', e.message);
      }

      broadcastToWorkspace(workspaceId, 'ticket.created', { ticketId: ticket.id });
    }

    if (rule.action_notify_schedule_id) {
      outcome.paged = pageOnCall(workspaceId, alert, rule.action_notify_schedule_id, outcome.ticket);
    }
  }

  broadcastToWorkspace(workspaceId, 'alert.updated', { alertId: alert.id });
  return outcome;
}

// Unacknowledged-alert escalation, driven by the scheduler. Pages the next
// escalation step whose delay has elapsed, at most one step per tick, and
// records how far it has got in alerts.escalation_step so a step can never
// fire twice -- the same "record what already fired" idempotence as
// ticket_escalations in escalationEngine.js.
export function escalateUnacknowledged(workspaceId, alert) {
  if (alert.status !== 'open') return null;

  // Which schedule governs this alert: whichever matching rule named one.
  const rule = findMatchingRules(workspaceId, alert).find((r) => r.action_notify_schedule_id);
  if (!rule) return null;

  const targets = resolveEscalationTargets(rule.action_notify_schedule_id, new Date());
  if (!targets.length) return null;

  const firstSeen = parseSqliteUtc(alert.first_seen_at) || parseSqliteUtc(alert.created_at);
  if (!firstSeen) return null;
  const ageMinutes = (Date.now() - firstSeen.getTime()) / 60000;
  const alreadyDone = Number(alert.escalation_step) || 0;

  const next = targets[alreadyDone];
  if (!next) return null;
  if (ageMinutes < next.delayMinutes) return null;

  const ticket = alert.ticket_id ? db.prepare('SELECT id, number FROM tickets WHERE id = ?').get(alert.ticket_id) : null;
  for (const user of next.users) {
    notifyUser(
      user.id,
      `Unacknowledged alert: ${alert.title}`,
      `${alert.severity.toUpperCase()} — still unacknowledged after ${Math.round(ageMinutes)} minutes. Escalation step ${next.stepOrder}.`,
      ticket ? `/tickets/${ticket.id}` : '/admin-settings?section=alertManagement',
      workspaceId
    );
  }
  db.prepare('UPDATE alerts SET escalation_step = ? WHERE id = ?').run(alreadyDone + 1, alert.id);
  logAlertEvent(
    alert.id, 'escalated',
    `Escalation step ${next.stepOrder} paged ${next.users.length} recipient(s) after ${Math.round(ageMinutes)}m unacknowledged`
  );
  return { step: next.stepOrder, notified: next.users.length };
}
