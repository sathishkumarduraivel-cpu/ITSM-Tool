import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { resolveOnCall, resolveShiftRange, getOnCallUserIds } from '../services/oncallEngine.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

const ROTATION_TYPES = ['daily', 'weekly', 'custom'];
const TARGET_TYPES = ['oncall_layer', 'user', 'group', 'role'];

// Validated server-side rather than trusted from the client: an invalid IANA
// zone would make every handoff calculation for this schedule throw at
// resolve time, i.e. long after the bad value was saved. Intl is the same
// timezone database oncallEngine.js computes with, so if it accepts the name
// here the engine can definitely use it.
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const isHhMm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

function ownedSchedule(id, workspaceId) {
  return db.prepare('SELECT * FROM oncall_schedules WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
}

// A layer is only reachable through its schedule, so every layer-scoped
// route re-checks workspace ownership via the join rather than trusting the
// layer id alone -- otherwise a layer id from another workspace would be
// editable by anyone who guessed it.
function ownedLayer(layerId, workspaceId) {
  return db.prepare(
    `SELECT l.* FROM oncall_layers l JOIN oncall_schedules s ON s.id = l.schedule_id
     WHERE l.id = ? AND s.workspace_id = ?`
  ).get(layerId, workspaceId);
}

function hydrate(schedule) {
  const layers = db.prepare('SELECT * FROM oncall_layers WHERE schedule_id = ? ORDER BY layer_order ASC').all(schedule.id);
  for (const layer of layers) {
    layer.members = db.prepare(
      `SELECT lm.id, lm.user_id, lm.member_order, u.name, u.email
       FROM oncall_layer_members lm JOIN users u ON u.id = lm.user_id
       WHERE lm.layer_id = ? ORDER BY lm.member_order ASC, lm.id ASC`
    ).all(layer.id);
  }
  const overrides = db.prepare(
    `SELECT o.*, u.name AS user_name FROM oncall_overrides o JOIN users u ON u.id = o.user_id
     WHERE o.schedule_id = ? ORDER BY o.start_at DESC`
  ).all(schedule.id);
  const escalation = db.prepare(
    'SELECT * FROM oncall_escalation_steps WHERE schedule_id = ? ORDER BY step_order ASC'
  ).all(schedule.id);
  const current = resolveOnCall(schedule.id, new Date());
  return {
    ...schedule,
    layers,
    overrides,
    escalation_steps: escalation,
    current_oncall: current?.user || null,
    current_reason: current?.reason || null,
    current_source: current?.source || null,
  };
}

// Readable by any authenticated member: knowing who is on call is
// operational information the whole team needs, not admin configuration.
// Mutation below is gated on oncall.manage.
router.get('/schedules', (req, res) => {
  const rows = db.prepare('SELECT * FROM oncall_schedules WHERE workspace_id = ? ORDER BY name').all(req.workspaceId);
  res.json({ schedules: rows.map(hydrate) });
});

router.get('/schedules/:id', (req, res) => {
  const schedule = ownedSchedule(req.params.id, req.workspaceId);
  if (!schedule) return res.status(404).json({ error: 'Not found' });
  res.json({ schedule: hydrate(schedule) });
});

// The calendar preview. Bounded to 60 days because resolveShiftRange samples
// the resolver rather than reading stored shifts -- an unbounded range would
// let one request sample it tens of thousands of times.
router.get('/schedules/:id/shifts', (req, res) => {
  const schedule = ownedSchedule(req.params.id, req.workspaceId);
  if (!schedule) return res.status(404).json({ error: 'Not found' });

  const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
  const from = req.query.from ? new Date(req.query.from) : new Date();
  if (Number.isNaN(from.getTime())) return res.status(400).json({ error: 'Invalid from date' });
  const to = new Date(from.getTime() + days * 24 * 3600 * 1000);

  res.json({ shifts: resolveShiftRange(schedule.id, from, to, Number(req.query.step) || 60), from: from.toISOString(), to: to.toISOString() });
});

router.get('/who-is-on-call', (req, res) => {
  const ids = [...getOnCallUserIds(req.workspaceId, new Date())];
  if (!ids.length) return res.json({ users: [] });
  const placeholders = ids.map(() => '?').join(',');
  const users = db.prepare(`SELECT id, name, email FROM users WHERE id IN (${placeholders})`).all(...ids);
  res.json({ users });
});

router.use(requirePermission('oncall.manage'));

router.post('/schedules', (req, res) => {
  const { name, description, timezone = 'UTC', team } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!isValidTimezone(timezone)) return res.status(400).json({ error: `Unknown timezone "${timezone}"` });

  const id = uid('ocs');
  db.prepare(
    'INSERT INTO oncall_schedules (id, workspace_id, name, description, timezone, team) VALUES (?,?,?,?,?,?)'
  ).run(id, req.workspaceId, String(name).trim(), description || null, timezone, team || null);
  logAudit(req, { action: 'oncall_schedule.create', entityType: 'oncall_schedule', entityId: id, entityLabel: name });
  res.status(201).json({ schedule: hydrate(ownedSchedule(id, req.workspaceId)) });
});

router.patch('/schedules/:id', (req, res) => {
  const schedule = ownedSchedule(req.params.id, req.workspaceId);
  if (!schedule) return res.status(404).json({ error: 'Not found' });

  const { name, description, timezone, team, enabled } = req.body || {};
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    return res.status(400).json({ error: `Unknown timezone "${timezone}"` });
  }
  db.prepare(
    `UPDATE oncall_schedules SET name = ?, description = ?, timezone = ?, team = ?, enabled = ? WHERE id = ?`
  ).run(
    name !== undefined ? String(name).trim() || schedule.name : schedule.name,
    description !== undefined ? description : schedule.description,
    timezone !== undefined ? timezone : schedule.timezone,
    team !== undefined ? team : schedule.team,
    enabled !== undefined ? (enabled ? 1 : 0) : schedule.enabled,
    schedule.id
  );
  logAudit(req, { action: 'oncall_schedule.update', entityType: 'oncall_schedule', entityId: schedule.id, entityLabel: name || schedule.name });
  res.json({ schedule: hydrate(ownedSchedule(schedule.id, req.workspaceId)) });
});

router.delete('/schedules/:id', (req, res) => {
  const schedule = ownedSchedule(req.params.id, req.workspaceId);
  if (!schedule) return res.status(404).json({ error: 'Not found' });
  // Layers, members, overrides and steps all cascade (see db.js).
  db.prepare('DELETE FROM oncall_schedules WHERE id = ?').run(schedule.id);
  logAudit(req, { action: 'oncall_schedule.delete', entityType: 'oncall_schedule', entityId: schedule.id, entityLabel: schedule.name });
  res.json({ ok: true });
});

router.post('/schedules/:id/layers', (req, res) => {
  const schedule = ownedSchedule(req.params.id, req.workspaceId);
  if (!schedule) return res.status(404).json({ error: 'Not found' });

  const {
    name = 'Primary', rotation_type = 'weekly', rotation_length_days = 7,
    handoff_time = '09:00', start_date, restriction = null,
  } = req.body || {};

  if (!ROTATION_TYPES.includes(rotation_type)) return res.status(400).json({ error: 'Invalid rotation type' });
  if (!isHhMm(handoff_time)) return res.status(400).json({ error: 'Handoff time must be HH:MM' });
  if (!isIsoDate(start_date)) return res.status(400).json({ error: 'Start date must be YYYY-MM-DD' });
  const lengthDays = Math.min(365, Math.max(1, Number(rotation_length_days) || 7));
  if (restriction !== null && restriction !== undefined) {
    try {
      JSON.parse(typeof restriction === 'string' ? restriction : JSON.stringify(restriction));
    } catch {
      return res.status(400).json({ error: 'Restriction must be valid JSON' });
    }
  }

  const nextOrder = (db.prepare('SELECT MAX(layer_order) m FROM oncall_layers WHERE schedule_id = ?').get(schedule.id).m || 0) + 1;
  const id = uid('ocl');
  db.prepare(
    `INSERT INTO oncall_layers (id, schedule_id, layer_order, name, rotation_type, rotation_length_days, handoff_time, start_date, restriction)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id, schedule.id, nextOrder, String(name).trim() || 'Primary', rotation_type, lengthDays,
    handoff_time, start_date,
    restriction ? (typeof restriction === 'string' ? restriction : JSON.stringify(restriction)) : null
  );
  logAudit(req, { action: 'oncall_layer.create', entityType: 'oncall_layer', entityId: id, entityLabel: `${schedule.name} / ${name}` });
  res.status(201).json({ schedule: hydrate(ownedSchedule(schedule.id, req.workspaceId)) });
});

router.patch('/layers/:layerId', (req, res) => {
  const layer = ownedLayer(req.params.layerId, req.workspaceId);
  if (!layer) return res.status(404).json({ error: 'Not found' });

  const { name, rotation_type, rotation_length_days, handoff_time, start_date, restriction, enabled, layer_order } = req.body || {};
  if (rotation_type !== undefined && !ROTATION_TYPES.includes(rotation_type)) return res.status(400).json({ error: 'Invalid rotation type' });
  if (handoff_time !== undefined && !isHhMm(handoff_time)) return res.status(400).json({ error: 'Handoff time must be HH:MM' });
  if (start_date !== undefined && !isIsoDate(start_date)) return res.status(400).json({ error: 'Start date must be YYYY-MM-DD' });

  db.prepare(
    `UPDATE oncall_layers SET name = ?, rotation_type = ?, rotation_length_days = ?, handoff_time = ?, start_date = ?, restriction = ?, enabled = ?, layer_order = ?
     WHERE id = ?`
  ).run(
    name !== undefined ? String(name).trim() || layer.name : layer.name,
    rotation_type !== undefined ? rotation_type : layer.rotation_type,
    rotation_length_days !== undefined ? Math.min(365, Math.max(1, Number(rotation_length_days) || 7)) : layer.rotation_length_days,
    handoff_time !== undefined ? handoff_time : layer.handoff_time,
    start_date !== undefined ? start_date : layer.start_date,
    restriction !== undefined ? (restriction ? (typeof restriction === 'string' ? restriction : JSON.stringify(restriction)) : null) : layer.restriction,
    enabled !== undefined ? (enabled ? 1 : 0) : layer.enabled,
    layer_order !== undefined ? Math.max(1, Number(layer_order) || layer.layer_order) : layer.layer_order,
    layer.id
  );
  res.json({ schedule: hydrate(ownedSchedule(layer.schedule_id, req.workspaceId)) });
});

router.delete('/layers/:layerId', (req, res) => {
  const layer = ownedLayer(req.params.layerId, req.workspaceId);
  if (!layer) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM oncall_layers WHERE id = ?').run(layer.id);
  res.json({ schedule: hydrate(ownedSchedule(layer.schedule_id, req.workspaceId)) });
});

// Replaces a layer's whole membership in one call. Order matters (it *is*
// the rotation order), so a partial add/remove API would make reordering a
// multi-request dance with a broken rotation in between.
router.put('/layers/:layerId/members', (req, res) => {
  const layer = ownedLayer(req.params.layerId, req.workspaceId);
  if (!layer) return res.status(404).json({ error: 'Not found' });

  const userIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids : null;
  if (!userIds) return res.status(400).json({ error: 'user_ids array is required' });

  // Only agents/admins with an active membership in THIS workspace can hold
  // a rotation -- a requester or a user from another workspace must not be
  // insertable by id.
  const eligible = new Set(db.prepare(
    `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role IN ('admin','agent') AND active = 1`
  ).all(req.workspaceId).map((r) => r.user_id));
  const rejected = userIds.filter((id) => !eligible.has(id));
  if (rejected.length) return res.status(400).json({ error: `Not assignable in this workspace: ${rejected.length} user(s)` });

  db.prepare('DELETE FROM oncall_layer_members WHERE layer_id = ?').run(layer.id);
  userIds.forEach((userId, i) => {
    db.prepare('INSERT INTO oncall_layer_members (id, layer_id, user_id, member_order) VALUES (?,?,?,?)').run(
      uid('oclm'), layer.id, userId, i + 1
    );
  });
  logAudit(req, { action: 'oncall_layer.members', entityType: 'oncall_layer', entityId: layer.id, details: { count: userIds.length } });
  res.json({ schedule: hydrate(ownedSchedule(layer.schedule_id, req.workspaceId)) });
});

router.post('/schedules/:id/overrides', (req, res) => {
  const schedule = ownedSchedule(req.params.id, req.workspaceId);
  if (!schedule) return res.status(404).json({ error: 'Not found' });

  const { user_id, start_at, end_at, reason } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  const start = new Date(start_at);
  const end = new Date(end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return res.status(400).json({ error: 'Valid start_at and end_at are required' });
  if (end <= start) return res.status(400).json({ error: 'The override must end after it starts' });

  const eligible = db.prepare(
    `SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND role IN ('admin','agent') AND active = 1`
  ).get(req.workspaceId, user_id);
  if (!eligible) return res.status(400).json({ error: 'That user cannot take an on-call override in this workspace' });

  const id = uid('oco');
  db.prepare(
    'INSERT INTO oncall_overrides (id, schedule_id, user_id, start_at, end_at, reason, created_by) VALUES (?,?,?,?,?,?,?)'
  ).run(id, schedule.id, user_id, start.toISOString(), end.toISOString(), reason || null, req.user.id);
  logAudit(req, { action: 'oncall_override.create', entityType: 'oncall_schedule', entityId: schedule.id, details: { user_id, start_at: start.toISOString(), end_at: end.toISOString() } });
  res.status(201).json({ schedule: hydrate(ownedSchedule(schedule.id, req.workspaceId)) });
});

router.delete('/overrides/:overrideId', (req, res) => {
  const row = db.prepare(
    `SELECT o.*, s.workspace_id FROM oncall_overrides o JOIN oncall_schedules s ON s.id = o.schedule_id
     WHERE o.id = ? AND s.workspace_id = ?`
  ).get(req.params.overrideId, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM oncall_overrides WHERE id = ?').run(row.id);
  res.json({ schedule: hydrate(ownedSchedule(row.schedule_id, req.workspaceId)) });
});

// Escalation steps are replaced wholesale for the same ordering reason as
// layer membership.
router.put('/schedules/:id/escalation', (req, res) => {
  const schedule = ownedSchedule(req.params.id, req.workspaceId);
  if (!schedule) return res.status(404).json({ error: 'Not found' });

  const steps = Array.isArray(req.body?.steps) ? req.body.steps : null;
  if (!steps) return res.status(400).json({ error: 'steps array is required' });
  for (const step of steps) {
    if (!TARGET_TYPES.includes(step.target_type)) return res.status(400).json({ error: `Invalid target type "${step.target_type}"` });
    if (step.target_type !== 'oncall_layer' && !step.target_id) return res.status(400).json({ error: `A ${step.target_type} step needs a target` });
    if (step.target_type === 'role' && !['admin', 'agent'].includes(step.target_id)) return res.status(400).json({ error: 'A role step must target admin or agent' });
  }

  db.prepare('DELETE FROM oncall_escalation_steps WHERE schedule_id = ?').run(schedule.id);
  steps.forEach((step, i) => {
    db.prepare(
      'INSERT INTO oncall_escalation_steps (id, schedule_id, step_order, target_type, target_id, delay_minutes) VALUES (?,?,?,?,?,?)'
    ).run(
      uid('oces'), schedule.id, i + 1, step.target_type, step.target_id || null,
      Math.min(1440, Math.max(0, Number(step.delay_minutes) || 0))
    );
  });
  logAudit(req, { action: 'oncall_escalation.update', entityType: 'oncall_schedule', entityId: schedule.id, details: { steps: steps.length } });
  res.json({ schedule: hydrate(ownedSchedule(schedule.id, req.workspaceId)) });
});

export default router;
