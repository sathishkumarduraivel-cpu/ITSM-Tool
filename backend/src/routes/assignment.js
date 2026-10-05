import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { findAssignmentPolicy, scoreCandidates, decideAssignment, autoAssign } from '../services/assignmentEngine.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

const STRATEGIES = ['least_loaded', 'round_robin', 'oncall_first', 'ai_sona'];
const FALLBACKS = ['least_loaded', 'round_robin', 'oncall_first'];
const CANDIDATE_SOURCES = ['group', 'oncall_schedule', 'explicit_list'];
const STATUSES = ['available', 'busy', 'dnd'];

// Anyone signed in may read and set THEIR OWN availability -- an agent
// marking themselves do-not-disturb is ordinary self-service, not admin
// configuration. Everything that reads or writes someone else's row, or any
// policy, sits behind assignment.manage further down.
router.get('/my-availability', (req, res) => {
  const row = db.prepare('SELECT * FROM agent_availability WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, req.user.id);
  const timeOff = db.prepare(
    `SELECT * FROM agent_time_off WHERE workspace_id = ? AND user_id = ?
       AND datetime(end_at) > datetime('now') ORDER BY start_at ASC`
  ).all(req.workspaceId, req.user.id);
  res.json({ availability: row || null, time_off: timeOff });
});

function upsertAvailability(workspaceId, userId, patch) {
  const existing = db.prepare('SELECT * FROM agent_availability WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
  const next = {
    status: patch.status !== undefined ? patch.status : (existing?.status || 'available'),
    status_message: patch.status_message !== undefined ? patch.status_message : (existing?.status_message || null),
    max_concurrent_tickets: patch.max_concurrent_tickets !== undefined
      ? Math.min(999, Math.max(1, Number(patch.max_concurrent_tickets) || 10))
      : (existing?.max_concurrent_tickets ?? 10),
    skills: patch.skills !== undefined
      ? (Array.isArray(patch.skills) ? JSON.stringify(patch.skills.map(String).slice(0, 25)) : null)
      : (existing?.skills || null),
  };
  if (existing) {
    db.prepare(
      "UPDATE agent_availability SET status = ?, status_message = ?, max_concurrent_tickets = ?, skills = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(next.status, next.status_message, next.max_concurrent_tickets, next.skills, existing.id);
  } else {
    db.prepare(
      'INSERT INTO agent_availability (id, workspace_id, user_id, status, status_message, max_concurrent_tickets, skills) VALUES (?,?,?,?,?,?,?)'
    ).run(uid('aav'), workspaceId, userId, next.status, next.status_message, next.max_concurrent_tickets, next.skills);
  }
  return db.prepare('SELECT * FROM agent_availability WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId);
}

router.patch('/my-availability', (req, res) => {
  const { status, status_message } = req.body || {};
  if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  // Deliberately narrow: an agent may set their own presence status and
  // message, but not raise their own ticket capacity or edit their skill
  // tags -- those are workload policy, and belong to whoever owns routing.
  const row = upsertAvailability(req.workspaceId, req.user.id, {
    status, status_message: status_message !== undefined ? String(status_message || '').slice(0, 200) : undefined,
  });
  res.json({ availability: row });
});

router.use(requirePermission('assignment.manage'));

function hydratePolicy(policy) {
  const candidates = db.prepare(
    `SELECT apc.user_id, u.name FROM assignment_policy_candidates apc JOIN users u ON u.id = apc.user_id
     WHERE apc.policy_id = ?`
  ).all(policy.id);
  return { ...policy, explicit_candidates: candidates };
}

router.get('/policies', (req, res) => {
  const rows = db.prepare('SELECT * FROM assignment_policies WHERE workspace_id = ? ORDER BY created_at ASC').all(req.workspaceId);
  res.json({ policies: rows.map(hydratePolicy) });
});

function readPolicyBody(body, existing) {
  const pick = (key, fallback) => (body[key] !== undefined ? body[key] : fallback);
  const bool = (v) => (v ? 1 : 0);
  const strategy = pick('strategy', existing?.strategy || 'least_loaded');
  const fallback_strategy = pick('fallback_strategy', existing?.fallback_strategy || 'least_loaded');
  const candidate_source = pick('candidate_source', existing?.candidate_source || 'group');

  if (!STRATEGIES.includes(strategy)) return { error: 'Invalid strategy' };
  if (!FALLBACKS.includes(fallback_strategy)) return { error: 'Invalid fallback strategy' };
  if (!CANDIDATE_SOURCES.includes(candidate_source)) return { error: 'Invalid candidate source' };
  if (candidate_source === 'oncall_schedule' && !pick('candidate_schedule_id', existing?.candidate_schedule_id)) {
    return { error: 'Pick an on-call schedule to draw candidates from' };
  }

  return {
    values: {
      name: String(pick('name', existing?.name) || '').trim(),
      enabled: bool(pick('enabled', existing?.enabled ?? 1)),
      match_type: pick('match_type', existing?.match_type) || null,
      match_priority: pick('match_priority', existing?.match_priority) || null,
      match_team: pick('match_team', existing?.match_team) || null,
      match_category: pick('match_category', existing?.match_category) || null,
      strategy,
      candidate_source,
      candidate_group_id: pick('candidate_group_id', existing?.candidate_group_id) || null,
      candidate_schedule_id: pick('candidate_schedule_id', existing?.candidate_schedule_id) || null,
      respect_presence: bool(pick('respect_presence', existing?.respect_presence ?? 0)),
      respect_oncall: bool(pick('respect_oncall', existing?.respect_oncall ?? 0)),
      respect_status: bool(pick('respect_status', existing?.respect_status ?? 1)),
      respect_capacity: bool(pick('respect_capacity', existing?.respect_capacity ?? 1)),
      ai_enabled: bool(pick('ai_enabled', existing?.ai_enabled ?? 0)),
      fallback_strategy,
    },
  };
}

router.post('/policies', (req, res) => {
  const parsed = readPolicyBody(req.body || {}, null);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!parsed.values.name) return res.status(400).json({ error: 'Name is required' });

  const v = parsed.values;
  const id = uid('asp');
  db.prepare(
    `INSERT INTO assignment_policies (id, workspace_id, name, enabled, match_type, match_priority, match_team, match_category,
       strategy, candidate_source, candidate_group_id, candidate_schedule_id,
       respect_presence, respect_oncall, respect_status, respect_capacity, ai_enabled, fallback_strategy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, v.name, v.enabled, v.match_type, v.match_priority, v.match_team, v.match_category,
    v.strategy, v.candidate_source, v.candidate_group_id, v.candidate_schedule_id,
    v.respect_presence, v.respect_oncall, v.respect_status, v.respect_capacity, v.ai_enabled, v.fallback_strategy);

  if (Array.isArray(req.body?.explicit_user_ids)) {
    setExplicitCandidates(req.workspaceId, id, req.body.explicit_user_ids);
  }
  logAudit(req, { action: 'assignment_policy.create', entityType: 'assignment_policy', entityId: id, entityLabel: v.name });
  res.status(201).json({ policy: hydratePolicy(db.prepare('SELECT * FROM assignment_policies WHERE id = ?').get(id)) });
});

function setExplicitCandidates(workspaceId, policyId, userIds) {
  const eligible = new Set(db.prepare(
    `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role IN ('admin','agent') AND active = 1`
  ).all(workspaceId).map((r) => r.user_id));
  db.prepare('DELETE FROM assignment_policy_candidates WHERE policy_id = ?').run(policyId);
  for (const userId of userIds) {
    if (!eligible.has(userId)) continue; // silently skip anyone not assignable here
    db.prepare('INSERT INTO assignment_policy_candidates (id, policy_id, user_id) VALUES (?,?,?)').run(uid('apc'), policyId, userId);
  }
}

router.patch('/policies/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM assignment_policies WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const parsed = readPolicyBody(req.body || {}, existing);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.values;
  if (!v.name) return res.status(400).json({ error: 'Name is required' });

  db.prepare(
    `UPDATE assignment_policies SET name = ?, enabled = ?, match_type = ?, match_priority = ?, match_team = ?, match_category = ?,
       strategy = ?, candidate_source = ?, candidate_group_id = ?, candidate_schedule_id = ?,
       respect_presence = ?, respect_oncall = ?, respect_status = ?, respect_capacity = ?, ai_enabled = ?, fallback_strategy = ?
     WHERE id = ?`
  ).run(v.name, v.enabled, v.match_type, v.match_priority, v.match_team, v.match_category,
    v.strategy, v.candidate_source, v.candidate_group_id, v.candidate_schedule_id,
    v.respect_presence, v.respect_oncall, v.respect_status, v.respect_capacity, v.ai_enabled, v.fallback_strategy,
    existing.id);

  if (Array.isArray(req.body?.explicit_user_ids)) {
    setExplicitCandidates(req.workspaceId, existing.id, req.body.explicit_user_ids);
  }
  logAudit(req, { action: 'assignment_policy.update', entityType: 'assignment_policy', entityId: existing.id, entityLabel: v.name });
  res.json({ policy: hydratePolicy(db.prepare('SELECT * FROM assignment_policies WHERE id = ?').get(existing.id)) });
});

router.delete('/policies/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM assignment_policies WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM assignment_policies WHERE id = ?').run(existing.id);
  logAudit(req, { action: 'assignment_policy.delete', entityType: 'assignment_policy', entityId: existing.id, entityLabel: existing.name });
  res.json({ ok: true });
});

// The dry-run simulator. Runs the *real* decision path against a
// hypothetical ticket and returns the full scored candidate set without
// writing anything -- so an admin can see who a policy would pick, and
// crucially who it excluded and why, before trusting it with live tickets.
//
// AI is off by default here: the simulator is something admins click
// repeatedly while tuning, and each Sona call costs money on their own key.
router.post('/simulate', async (req, res) => {
  const { type = 'incident', priority = 'medium', team = null, category = null, title = '', description = '', use_ai = false } = req.body || {};
  const ticket = { type, priority, team, category, title, description };

  const policy = findAssignmentPolicy(req.workspaceId, { type, priority, team, category });
  if (!policy) {
    return res.json({ policy: null, candidates: [], chosen: null, rationale: 'No assignment policy matches a ticket like this' });
  }

  try {
    const decision = await decideAssignment(req.workspaceId, ticket, { useAi: !!use_ai });
    res.json({
      policy: { id: decision.policy.id, name: decision.policy.name, strategy: decision.policy.strategy },
      candidates: decision.candidates,
      chosen: decision.chosen,
      strategy_used: decision.strategyUsed,
      ai_used: decision.aiUsed,
      rationale: decision.rationale,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Re-run routing for one real ticket. An explicit action, never implicit --
// auto-assignment happens at creation, and a human reassigning by hand
// should not be silently undone by a policy change later.
router.post('/tickets/:ticketId/assign', async (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ?').get(req.params.ticketId, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  if (ticket.assignee_id && !req.body?.force) {
    return res.status(400).json({ error: 'That ticket already has an owner. Pass force to reassign it anyway.' });
  }
  if (req.body?.force) {
    db.prepare('UPDATE tickets SET assignee_id = NULL WHERE id = ?').run(ticket.id);
    ticket.assignee_id = null;
  }

  try {
    const result = await autoAssign(ticket);
    if (!result) return res.json({ assigned: null, reason: 'No eligible assignee was found' });
    logAudit(req, { action: 'assignment.manual_run', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, details: { assigned_to: result.userId } });
    res.json({ assigned: result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// The availability roster: every agent, their status, capacity and live
// load. This is the operational view that makes the policy toggles legible.
router.get('/roster', (req, res) => {
  const members = db.prepare(
    `SELECT u.id, u.name, u.email, wm.team, wm.role FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND wm.role IN ('admin','agent') AND wm.active = 1 ORDER BY u.name`
  ).all(req.workspaceId);

  const roster = members.map((m) => {
    const av = db.prepare('SELECT * FROM agent_availability WHERE workspace_id = ? AND user_id = ?').get(req.workspaceId, m.id);
    const open = db.prepare(
      "SELECT COUNT(*) c FROM tickets WHERE workspace_id = ? AND assignee_id = ? AND status NOT IN ('resolved','closed') AND COALESCE(is_spam,0) = 0"
    ).get(req.workspaceId, m.id).c;
    const timeOff = db.prepare(
      `SELECT * FROM agent_time_off WHERE workspace_id = ? AND user_id = ? AND datetime(end_at) > datetime('now') ORDER BY start_at ASC`
    ).all(req.workspaceId, m.id);
    let skills = [];
    try { if (av?.skills) skills = JSON.parse(av.skills); } catch { skills = []; }
    return {
      ...m,
      status: av?.status || 'available',
      status_message: av?.status_message || null,
      max_concurrent_tickets: av?.max_concurrent_tickets ?? 10,
      skills,
      open_tickets: open,
      time_off: timeOff,
    };
  });
  res.json({ roster });
});

router.patch('/roster/:userId', (req, res) => {
  const member = db.prepare(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('admin','agent')`
  ).get(req.workspaceId, req.params.userId);
  if (!member) return res.status(404).json({ error: 'Not an agent in this workspace' });

  const { status, status_message, max_concurrent_tickets, skills } = req.body || {};
  if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const row = upsertAvailability(req.workspaceId, req.params.userId, { status, status_message, max_concurrent_tickets, skills });
  logAudit(req, { action: 'agent_availability.update', entityType: 'user', entityId: req.params.userId, details: { status: row.status, capacity: row.max_concurrent_tickets } });
  res.json({ availability: row });
});

router.post('/roster/:userId/time-off', (req, res) => {
  const { start_at, end_at, reason } = req.body || {};
  const start = new Date(start_at);
  const end = new Date(end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return res.status(400).json({ error: 'Valid start_at and end_at are required' });
  if (end <= start) return res.status(400).json({ error: 'Time off must end after it starts' });

  const id = uid('ato');
  db.prepare('INSERT INTO agent_time_off (id, workspace_id, user_id, start_at, end_at, reason) VALUES (?,?,?,?,?,?)').run(
    id, req.workspaceId, req.params.userId, start.toISOString(), end.toISOString(), reason || null
  );
  logAudit(req, { action: 'agent_time_off.create', entityType: 'user', entityId: req.params.userId, details: { start_at: start.toISOString(), end_at: end.toISOString() } });
  res.status(201).json({ ok: true, id });
});

router.delete('/time-off/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM agent_time_off WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM agent_time_off WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// Recent routing decisions, for answering "why did this land on them?".
router.get('/log', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = db.prepare(
    `SELECT al.*, t.number AS ticket_number, t.title AS ticket_title, u.name AS assigned_name, p.name AS policy_name
     FROM assignment_log al
     LEFT JOIN tickets t ON t.id = al.ticket_id
     LEFT JOIN users u ON u.id = al.assigned_user_id
     LEFT JOIN assignment_policies p ON p.id = al.policy_id
     WHERE al.workspace_id = ? ORDER BY al.created_at DESC, al.id DESC LIMIT ?`
  ).all(req.workspaceId, limit);
  res.json({
    log: rows.map((r) => {
      let candidates = [];
      try { candidates = r.candidates ? JSON.parse(r.candidates) : []; } catch { candidates = []; }
      return { ...r, candidates };
    }),
  });
});

export default router;
