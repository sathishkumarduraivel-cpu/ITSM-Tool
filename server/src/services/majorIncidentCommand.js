import { db, uid } from '../db.js';
import { SEVERITIES, nextMajorIncidentNumber, getMajorIncident } from './majorIncidents.js';

export class MajorIncidentError extends Error {
  constructor(message, status = 400, field_errors) {
    super(message);
    this.status = status;
    if (field_errors) this.field_errors = field_errors;
  }
}

export const MI_ROLES = [
  { key: 'commander_id', label: 'Major Incident Manager', hint: 'Owns the response and the decisions.' },
  { key: 'incident_lead_id', label: 'Incident Lead', hint: 'Runs the bridge and coordinates the teams.' },
  { key: 'technical_lead_id', label: 'Technical Lead', hint: 'Owns the technical investigation and recovery.' },
  { key: 'comms_lead_id', label: 'Communications Lead', hint: 'Talks to stakeholders, on the approved cadence.' },
];

export const COMMS_AUDIENCES = ['executives', 'affected_users', 'all_staff', 'customers', 'support_teams', 'vendor'];
export const COMMS_CHANNELS = ['email', 'chat', 'status_page', 'bridge', 'phone', 'in_person'];
const ACTION_STATES = ['open', 'in_progress', 'done', 'abandoned'];

// The benchmark targets from §6.6, in minutes from promotion. Starting
// values -- the specification is explicit that benchmarks are configured and
// baselined per customer, so these are what the dashboard measures against
// until somebody changes them, not a contractual promise.
export const MI_BENCHMARKS = {
  acknowledged: { minutes: 5, label: 'Acknowledged' },
  lead_assigned: { minutes: 10, label: 'Incident Lead assigned' },
  first_comms: { minutes: 15, label: 'First stakeholder update' },
};

/**
 * The automated criteria check (§6.2/§6.3).
 *
 * It returns what it found rather than a verdict. Whether something is a
 * major incident is a judgement about business impact that no rule can make,
 * so the value here is putting the evidence in front of the person who does
 * decide -- "four related incidents in the last hour, all on one service" is
 * the thing they would otherwise have had to notice themselves.
 */
export function evaluateCriteria(workspaceId, ticket) {
  const signals = [];
  if (!ticket) return signals;

  if (ticket.priority === 'critical') {
    signals.push({ key: 'critical_priority', met: true, detail: 'The incident is already graded critical.' });
  }
  if (ticket.impact === 'high') {
    signals.push({ key: 'high_impact', met: true, detail: 'Impact is recorded as high — a whole site or service.' });
  }

  // Several open incidents sharing this one's classification, which is the
  // clearest signal available that something systemic is happening.
  if (ticket.category) {
    const since = new Date(Date.now() - 2 * 3600000).toISOString();
    const related = db.prepare(
      `SELECT COUNT(*) c FROM tickets
       WHERE workspace_id = ? AND type = 'incident' AND id != ? AND deleted_at IS NULL
         AND COALESCE(is_spam, 0) = 0
         AND category = ? AND status NOT IN ('resolved','closed')
         AND datetime(created_at) >= datetime(?)`
    ).get(workspaceId, ticket.id, ticket.category, since).c;
    if (related >= 3) {
      signals.push({ key: 'multiple_related', met: true, detail: `${related} other open incidents in ${ticket.category} in the last two hours.` });
    }
  }

  // A configuration item that other services depend on. blast radius is
  // already computed elsewhere for change risk; here the simple count of
  // dependants is enough to say "this one matters".
  const assets = db.prepare('SELECT asset_id FROM ticket_assets WHERE ticket_id = ?').all(ticket.id).map((r) => r.asset_id);
  if (assets.length) {
    const marks = assets.map(() => '?').join(',');
    // Counted in both directions: a relationship is stored once, so a CI that
    // other things hang off appears sometimes as the source and sometimes as
    // the related end depending on how it was recorded.
    const dependants = db.prepare(
      `SELECT COUNT(*) c FROM asset_relationships
       WHERE asset_id IN (${marks}) OR related_asset_id IN (${marks})`
    ).get(...assets, ...assets).c;
    if (dependants > 0) {
      signals.push({ key: 'critical_ci', met: true, detail: `${dependants} relationship(s) connect the affected CI to other services.` });
    }
  }

  // Raised by monitoring rather than a person, which is often how a genuine
  // outage arrives first.
  if (ticket.source === 'alert' || ticket.source === 'monitoring') {
    signals.push({ key: 'monitoring_raised', met: true, detail: 'Raised automatically by monitoring.' });
  }

  return signals;
}

const ticketFor = (workspaceId, ticketId) => db.prepare(
  "SELECT * FROM tickets WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL"
).get(ticketId, workspaceId);

// ---- proposal ------------------------------------------------------------

export function propose(workspaceId, user, body) {
  const ticket = ticketFor(workspaceId, body.ticket_id);
  if (!ticket) throw new MajorIncidentError('That ticket no longer exists.', 404);
  if (ticket.type !== 'incident') throw new MajorIncidentError('Only an incident can become a Major Incident.', 400);

  const reason = String(body.reason || '').trim();
  if (!reason) {
    throw new MajorIncidentError('Say why this should be a Major Incident.', 400, [{ field: 'reason', message: 'Required' }]);
  }
  if (body.suggested_severity && !SEVERITIES.includes(body.suggested_severity)) {
    throw new MajorIncidentError(`Severity must be one of: ${SEVERITIES.join(', ')}`, 400, [{ field: 'suggested_severity', message: 'Not a severity' }]);
  }
  const live = db.prepare("SELECT id FROM major_incidents WHERE ticket_id = ? AND status NOT IN ('resolved','closed')").get(ticket.id);
  if (live) throw new MajorIncidentError('This incident already has an active Major Incident.', 409);
  const pending = db.prepare("SELECT id FROM major_incident_proposals WHERE ticket_id = ? AND status = 'pending'").get(ticket.id);
  if (pending) throw new MajorIncidentError('Someone has already proposed this one; it is waiting for a decision.', 409);

  const id = uid('mip');
  db.prepare(
    `INSERT INTO major_incident_proposals (id, workspace_id, ticket_id, proposed_by, reason, suggested_severity, affected_service, users_affected, criteria)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, workspaceId, ticket.id, user.id, reason, body.suggested_severity || null,
    String(body.affected_service || '').trim() || null, String(body.users_affected || '').trim() || null,
    JSON.stringify(evaluateCriteria(workspaceId, ticket)));

  // The source incident is deliberately untouched. Proposing is not
  // declaring, and an incident whose priority jumped because somebody
  // suggested something would make the suggestion consequential on its own.
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)')
    .run(uid('h'), ticket.id, 'major_incident_proposed', `Proposed as a Major Incident — ${reason}`);

  return getProposal(workspaceId, id);
}

export function getProposal(workspaceId, id) {
  const row = db.prepare(
    `SELECT p.*, t.number AS ticket_number, t.title AS ticket_title, t.priority, t.status AS ticket_status,
            pu.name AS proposed_by_name, du.name AS decided_by_name
     FROM major_incident_proposals p
     JOIN tickets t ON t.id = p.ticket_id
     LEFT JOIN users pu ON pu.id = p.proposed_by
     LEFT JOIN users du ON du.id = p.decided_by
     WHERE p.id = ? AND p.workspace_id = ?`
  ).get(id, workspaceId);
  if (!row) throw new MajorIncidentError('That proposal no longer exists.', 404);
  return { ...row, criteria: row.criteria ? JSON.parse(row.criteria) : [] };
}

export function listProposals(workspaceId, { status = 'pending' } = {}) {
  const rows = status === 'all'
    ? db.prepare(
      `SELECT p.*, t.number AS ticket_number, t.title AS ticket_title, t.priority,
              pu.name AS proposed_by_name, du.name AS decided_by_name
       FROM major_incident_proposals p JOIN tickets t ON t.id = p.ticket_id
       LEFT JOIN users pu ON pu.id = p.proposed_by LEFT JOIN users du ON du.id = p.decided_by
       WHERE p.workspace_id = ? ORDER BY p.created_at DESC`
    ).all(workspaceId)
    : db.prepare(
      `SELECT p.*, t.number AS ticket_number, t.title AS ticket_title, t.priority,
              pu.name AS proposed_by_name, du.name AS decided_by_name
       FROM major_incident_proposals p JOIN tickets t ON t.id = p.ticket_id
       LEFT JOIN users pu ON pu.id = p.proposed_by LEFT JOIN users du ON du.id = p.decided_by
       WHERE p.workspace_id = ? AND p.status = ? ORDER BY p.created_at DESC`
    ).all(workspaceId, status);
  return rows.map((r) => ({ ...r, criteria: r.criteria ? JSON.parse(r.criteria) : [] }));
}

export function withdraw(workspaceId, id, user) {
  const p = getProposal(workspaceId, id);
  if (p.status !== 'pending') throw new MajorIncidentError('That proposal has already been decided.', 409);
  if (p.proposed_by !== user.id && user.role !== 'admin') {
    throw new MajorIncidentError('Only the person who proposed it, or an admin, can withdraw it.', 403);
  }
  db.prepare("UPDATE major_incident_proposals SET status = 'withdrawn', decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(user.id, id);
  return getProposal(workspaceId, id);
}

export function reject(workspaceId, id, user, comment) {
  const p = getProposal(workspaceId, id);
  if (p.status !== 'pending') throw new MajorIncidentError('That proposal has already been decided.', 409);
  const note = String(comment || '').trim();
  if (!note) {
    // Turning one down without saying why teaches the proposer nothing, and
    // the next borderline incident gets proposed again the same way.
    throw new MajorIncidentError('Say why this is not a Major Incident.', 400, [{ field: 'comment', message: 'Required when rejecting' }]);
  }
  db.prepare("UPDATE major_incident_proposals SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_comment = ? WHERE id = ?")
    .run(user.id, note, id);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)')
    .run(uid('h'), p.ticket_id, 'major_incident_rejected', `Major Incident proposal declined — ${note}`);
  return getProposal(workspaceId, id);
}

/**
 * Promote a proposal into a real Major Incident.
 *
 * The source incident is preserved and linked rather than converted, which
 * §25 requires explicitly: the incident keeps its own number and history, and
 * the relationship between the two is traceable in both directions.
 */
export function promote(workspaceId, id, user, body = {}) {
  const p = getProposal(workspaceId, id);
  if (p.status !== 'pending') throw new MajorIncidentError('That proposal has already been decided.', 409);
  const ticket = ticketFor(workspaceId, p.ticket_id);
  if (!ticket) throw new MajorIncidentError('The incident behind this proposal no longer exists.', 404);

  const severity = body.severity || p.suggested_severity || 'sev2';
  if (!SEVERITIES.includes(severity)) {
    throw new MajorIncidentError(`Severity must be one of: ${SEVERITIES.join(', ')}`, 400, [{ field: 'severity', message: 'Not a severity' }]);
  }
  const interval = Math.min(240, Math.max(5, Number(body.update_interval_minutes) || 30));
  const miId = uid('mi');
  const number = nextMajorIncidentNumber(workspaceId);
  const now = new Date();

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO major_incidents (id, workspace_id, ticket_id, number, severity, summary, impact_description,
                                    commander_id, incident_lead_id, technical_lead_id, comms_lead_id,
                                    declared_by, update_interval_minutes, next_update_due_at, promoted_at,
                                    lead_assigned_at, users_affected, bridge_url)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      miId, workspaceId, ticket.id, number, severity,
      String(body.summary || ticket.title).trim(),
      String(body.impact_description || p.reason).trim(),
      body.commander_id || user.id,
      body.incident_lead_id || null, body.technical_lead_id || null, body.comms_lead_id || null,
      user.id, interval,
      new Date(now.getTime() + interval * 60000).toISOString(),
      now.toISOString(),
      body.incident_lead_id ? now.toISOString() : null,
      p.users_affected || null,
      String(body.bridge_url || '').trim() || null
    );
    db.prepare("UPDATE major_incident_proposals SET status = 'promoted', decided_by = ?, decided_at = datetime('now'), decision_comment = ?, major_incident_id = ? WHERE id = ?")
      .run(user.id, String(body.comment || '').trim() || null, miId, id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // Priority only ever moves up, the same safety rule the escalation engine
  // uses -- promoting must not silently downgrade something already critical.
  const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
  if ((RANK[ticket.priority] ?? -1) < RANK.critical) {
    db.prepare("UPDATE tickets SET priority = 'critical' WHERE id = ?").run(ticket.id);
  }
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)')
    .run(uid('h'), ticket.id, 'major_incident_declared', `${number} promoted from a proposal (${severity.toUpperCase()})`);

  return { proposal: getProposal(workspaceId, id), majorIncidentId: miId };
}

// ---- the command logs ----------------------------------------------------

const mustGetMi = (workspaceId, id) => {
  const mi = getMajorIncident(id, workspaceId);
  if (!mi) throw new MajorIncidentError('That major incident no longer exists.', 404);
  return mi;
};

export function addAction(workspaceId, miId, user, body) {
  mustGetMi(workspaceId, miId);
  const action = String(body.action || '').trim();
  if (!action) throw new MajorIncidentError('Say what needs doing.', 400, [{ field: 'action', message: 'Required' }]);
  db.prepare(
    `INSERT INTO major_incident_actions (id, workspace_id, major_incident_id, action, owner_id, eta, started_at, created_by)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(uid('mia'), workspaceId, miId, action, body.owner_id || null, body.eta || null,
    body.started_at || new Date().toISOString(), user.id);
  return listActions(workspaceId, miId);
}

export function updateAction(workspaceId, actionId, user, body) {
  const row = db.prepare('SELECT * FROM major_incident_actions WHERE id = ? AND workspace_id = ?').get(actionId, workspaceId);
  if (!row) throw new MajorIncidentError('That action no longer exists.', 404);
  const fields = []; const params = [];
  for (const k of ['action', 'owner_id', 'eta', 'outcome']) {
    if (body[k] !== undefined) { fields.push(`${k} = ?`); params.push(body[k] || null); }
  }
  if (body.status !== undefined) {
    if (!ACTION_STATES.includes(body.status)) {
      throw new MajorIncidentError(`Status must be one of: ${ACTION_STATES.join(', ')}`, 400, [{ field: 'status', message: 'Not a status' }]);
    }
    fields.push('status = ?'); params.push(body.status);
    fields.push(body.status === 'done' ? "completed_at = datetime('now')" : 'completed_at = NULL');
  }
  if (!fields.length) throw new MajorIncidentError('Nothing to update.', 400);
  params.push(actionId);
  db.prepare(`UPDATE major_incident_actions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return listActions(workspaceId, row.major_incident_id);
}

export const listActions = (workspaceId, miId) => db.prepare(
  `SELECT a.*, u.name AS owner_name FROM major_incident_actions a
   LEFT JOIN users u ON u.id = a.owner_id
   WHERE a.major_incident_id = ? AND a.workspace_id = ?
   ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, a.created_at`
).all(miId, workspaceId);

export function addDecision(workspaceId, miId, user, body) {
  mustGetMi(workspaceId, miId);
  const decision = String(body.decision || '').trim();
  if (!decision) throw new MajorIncidentError('Record what was decided.', 400, [{ field: 'decision', message: 'Required' }]);
  db.prepare(
    `INSERT INTO major_incident_decisions (id, workspace_id, major_incident_id, decision, options_considered, rationale, decided_by)
     VALUES (?,?,?,?,?,?,?)`
  ).run(uid('mid'), workspaceId, miId, decision,
    String(body.options_considered || '').trim() || null,
    String(body.rationale || '').trim() || null, user.id);
  return listDecisions(workspaceId, miId);
}

export const listDecisions = (workspaceId, miId) => db.prepare(
  `SELECT d.*, u.name AS decided_by_name FROM major_incident_decisions d
   LEFT JOIN users u ON u.id = d.decided_by
   WHERE d.major_incident_id = ? AND d.workspace_id = ? ORDER BY d.decided_at`
).all(miId, workspaceId);

export function addComms(workspaceId, miId, user, body) {
  const mi = mustGetMi(workspaceId, miId);
  const message = String(body.message || '').trim();
  if (!message) throw new MajorIncidentError('Write the update before sending it.', 400, [{ field: 'message', message: 'Required' }]);
  if (!COMMS_AUDIENCES.includes(body.audience)) {
    throw new MajorIncidentError(`Audience must be one of: ${COMMS_AUDIENCES.join(', ')}`, 400, [{ field: 'audience', message: 'Choose who this went to' }]);
  }
  if (!COMMS_CHANNELS.includes(body.channel)) {
    throw new MajorIncidentError(`Channel must be one of: ${COMMS_CHANNELS.join(', ')}`, 400, [{ field: 'channel', message: 'Choose how it was sent' }]);
  }
  db.prepare(
    'INSERT INTO major_incident_comms (id, workspace_id, major_incident_id, audience, channel, message, sent_by) VALUES (?,?,?,?,?,?,?)'
  ).run(uid('mic'), workspaceId, miId, body.audience, body.channel, message, user.id);

  // The first stakeholder update is one of the benchmark clocks, so it is
  // stamped the first time one is actually sent.
  if (!mi.first_comms_at) {
    db.prepare("UPDATE major_incidents SET first_comms_at = datetime('now') WHERE id = ?").run(miId);
  }
  return listComms(workspaceId, miId);
}

export const listComms = (workspaceId, miId) => db.prepare(
  `SELECT c.*, u.name AS sent_by_name FROM major_incident_comms c
   LEFT JOIN users u ON u.id = c.sent_by
   WHERE c.major_incident_id = ? AND c.workspace_id = ? ORDER BY c.sent_at DESC`
).all(miId, workspaceId);

// Acknowledging is its own act: it is the first benchmark, and it means
// somebody has actually picked the response up rather than merely seeing it.
export function acknowledge(workspaceId, miId, user) {
  const mi = mustGetMi(workspaceId, miId);
  if (mi.acknowledged_at) return mi;
  db.prepare("UPDATE major_incidents SET acknowledged_at = datetime('now') WHERE id = ?").run(miId);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)')
    .run(uid('h'), mi.ticket_id, 'major_incident_acknowledged', `${mi.number} acknowledged`);
  return getMajorIncident(miId, workspaceId);
}

export function assignRoles(workspaceId, miId, user, body) {
  const mi = mustGetMi(workspaceId, miId);
  const fields = []; const params = [];
  for (const role of MI_ROLES) {
    if (body[role.key] === undefined) continue;
    if (body[role.key]) {
      const exists = db.prepare('SELECT id FROM users WHERE id = ?').get(body[role.key]);
      if (!exists) throw new MajorIncidentError(`No such user for ${role.label}.`, 400, [{ field: role.key, message: 'Unknown user' }]);
    }
    fields.push(`${role.key} = ?`); params.push(body[role.key] || null);
  }
  if (!fields.length) throw new MajorIncidentError('Nothing to update.', 400);
  // Assigning the Incident Lead starts its benchmark clock, once.
  if (body.incident_lead_id && !mi.lead_assigned_at) fields.push("lead_assigned_at = datetime('now')");
  params.push(miId);
  db.prepare(`UPDATE major_incidents SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getMajorIncident(miId, workspaceId);
}

// ---- benchmarks (§6.6) ---------------------------------------------------

const minutesBetween = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);

export function benchmarksFor(mi) {
  const from = mi.promoted_at || mi.declared_at || mi.created_at;
  const out = {};
  for (const [key, spec] of Object.entries(MI_BENCHMARKS)) {
    const at = { acknowledged: mi.acknowledged_at, lead_assigned: mi.lead_assigned_at, first_comms: mi.first_comms_at }[key];
    const actual = minutesBetween(from, at);
    out[key] = {
      label: spec.label,
      target_minutes: spec.minutes,
      actual_minutes: actual,
      // Still outstanding: measured against now, so an overdue one shows as
      // overdue rather than simply "pending" for ever.
      elapsed_minutes: at ? actual : minutesBetween(from, new Date().toISOString()),
      met: at ? actual <= spec.minutes : null,
      at: at || null,
    };
  }
  return out;
}

export function commandSummary(workspaceId, miId) {
  const mi = mustGetMi(workspaceId, miId);
  const actions = listActions(workspaceId, miId);
  return {
    actions,
    open_actions: actions.filter((a) => ['open', 'in_progress'].includes(a.status)).length,
    decisions: listDecisions(workspaceId, miId),
    comms: listComms(workspaceId, miId),
    benchmarks: benchmarksFor(mi),
    roles: MI_ROLES.map((r) => ({ ...r, user_id: mi[r.key] || null })),
  };
}

export function commandMeta() {
  return {
    roles: MI_ROLES,
    audiences: COMMS_AUDIENCES,
    channels: COMMS_CHANNELS,
    action_states: ACTION_STATES,
    benchmarks: MI_BENCHMARKS,
    severities: SEVERITIES,
  };
}
