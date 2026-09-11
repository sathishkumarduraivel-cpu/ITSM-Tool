import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { getLifecycleForAdmin, listLifecycleSummaries, createLifecycle, seedTemplate, LIFECYCLE_TEMPLATES } from '../services/lifecycleEngine.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

const TICKET_TYPES = ['incident', 'request', 'problem', 'change'];

function loadOwnedLifecycle(req, res, next) {
  const lifecycle = db.prepare('SELECT * FROM ticket_lifecycles WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!lifecycle) return res.status(404).json({ error: 'Not found' });
  req.lifecycle = lifecycle;
  next();
}

// Every type's summary (stage count, enabled) for the admin hub. Reading
// this doesn't require admin -- agents benefit from knowing what governs a
// type even though only admins can change it.
router.get('/', (req, res) => {
  const summaries = listLifecycleSummaries(req.workspaceId);
  res.json({
    lifecycles: TICKET_TYPES.map((type) => summaries.find((s) => s.ticket_type === type) || { ticket_type: type, enabled: 0, stageCount: 0, id: null }),
  });
});

router.get('/:type/detail', (req, res) => {
  if (!TICKET_TYPES.includes(req.params.type)) return res.status(400).json({ error: 'Invalid ticket type' });
  const lifecycle = getLifecycleForAdmin(req.workspaceId, req.params.type);
  res.json({ lifecycle, template: LIFECYCLE_TEMPLATES[req.params.type] || null });
});

router.post('/', requirePermission('lifecycles.manage'), (req, res) => {
  const { ticket_type, use_template = true } = req.body;
  if (!TICKET_TYPES.includes(ticket_type)) return res.status(400).json({ error: 'Invalid ticket type' });
  try {
    const id = createLifecycle(req.workspaceId, ticket_type, use_template);
    logAudit(req, { action: 'lifecycle.created', entityType: 'lifecycle', entityId: id, entityLabel: ticket_type });
    res.status(201).json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/:id', requirePermission('lifecycles.manage'), loadOwnedLifecycle, (req, res) => {
  const { enabled } = req.body;
  if (enabled === undefined) return res.status(400).json({ error: 'enabled required' });
  db.prepare("UPDATE ticket_lifecycles SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(enabled ? 1 : 0, req.lifecycle.id);
  logAudit(req, { action: 'lifecycle.updated', entityType: 'lifecycle', entityId: req.lifecycle.id, entityLabel: req.lifecycle.ticket_type, details: { enabled } });
  res.json({ ok: true });
});

router.post('/:id/reset-template', requirePermission('lifecycles.manage'), loadOwnedLifecycle, (req, res) => {
  if (!LIFECYCLE_TEMPLATES[req.lifecycle.ticket_type]) return res.status(400).json({ error: 'No template available for this ticket type' });
  seedTemplate(req.lifecycle.id, req.lifecycle.ticket_type);
  logAudit(req, { action: 'lifecycle.reset', entityType: 'lifecycle', entityId: req.lifecycle.id, entityLabel: req.lifecycle.ticket_type });
  res.json({ ok: true });
});

router.delete('/:id', requirePermission('lifecycles.manage'), loadOwnedLifecycle, (req, res) => {
  db.prepare('DELETE FROM ticket_lifecycles WHERE id = ?').run(req.lifecycle.id); // cascades stages + transitions
  logAudit(req, { action: 'lifecycle.deleted', entityType: 'lifecycle', entityId: req.lifecycle.id, entityLabel: req.lifecycle.ticket_type });
  res.json({ ok: true });
});

// ---- Stages ----

router.post('/:id/stages', requirePermission('lifecycles.manage'), loadOwnedLifecycle, (req, res) => {
  const { key, label, bucket = 'open', is_terminal = false } = req.body;
  if (!key || !label) return res.status(400).json({ error: 'key and label required' });
  if (!/^[a-z][a-z0-9_]*$/.test(key)) return res.status(400).json({ error: 'Key must be lowercase letters, numbers and underscores, starting with a letter.' });
  const existing = db.prepare('SELECT id FROM lifecycle_stages WHERE lifecycle_id = ? AND key = ?').get(req.lifecycle.id, key);
  if (existing) return res.status(409).json({ error: 'A stage with this key already exists on this lifecycle.' });
  const maxOrder = db.prepare('SELECT MAX(sort_order) m FROM lifecycle_stages WHERE lifecycle_id = ?').get(req.lifecycle.id).m;
  const id = uid('lcs');
  db.prepare(
    'INSERT INTO lifecycle_stages (id, lifecycle_id, key, label, bucket, is_terminal, sort_order) VALUES (?,?,?,?,?,?,?)'
  ).run(id, req.lifecycle.id, key, label, bucket, is_terminal ? 1 : 0, (maxOrder ?? -1) + 1);
  logAudit(req, { action: 'lifecycle.stage_created', entityType: 'lifecycle', entityId: req.lifecycle.id, entityLabel: `${req.lifecycle.ticket_type}: ${label}` });
  res.status(201).json({ id });
});

router.patch('/stages/:stageId', requirePermission('lifecycles.manage'), (req, res) => {
  const stage = db.prepare(
    `SELECT s.*, lc.ticket_type FROM lifecycle_stages s JOIN ticket_lifecycles lc ON lc.id = s.lifecycle_id WHERE s.id = ? AND lc.workspace_id = ?`
  ).get(req.params.stageId, req.workspaceId);
  if (!stage) return res.status(404).json({ error: 'Not found' });
  const { label, bucket, is_terminal, sort_order } = req.body;
  const fields = []; const params = [];
  if (label !== undefined) { fields.push('label = ?'); params.push(label); }
  if (bucket !== undefined) { fields.push('bucket = ?'); params.push(bucket); }
  if (is_terminal !== undefined) { fields.push('is_terminal = ?'); params.push(is_terminal ? 1 : 0); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(sort_order); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });
  params.push(stage.id);
  db.prepare(`UPDATE lifecycle_stages SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'lifecycle.stage_updated', entityType: 'lifecycle', entityId: stage.lifecycle_id, entityLabel: `${stage.ticket_type}: ${label || stage.label}`, details: req.body });
  res.json({ ok: true });
});

router.delete('/stages/:stageId', requirePermission('lifecycles.manage'), (req, res) => {
  const stage = db.prepare(
    `SELECT s.*, lc.workspace_id, lc.ticket_type FROM lifecycle_stages s JOIN ticket_lifecycles lc ON lc.id = s.lifecycle_id WHERE s.id = ? AND lc.workspace_id = ?`
  ).get(req.params.stageId, req.workspaceId);
  if (!stage) return res.status(404).json({ error: 'Not found' });
  const inUse = db.prepare('SELECT COUNT(*) c FROM tickets WHERE workspace_id = ? AND type = ? AND lifecycle_stage = ?').get(stage.workspace_id, stage.ticket_type, stage.key).c;
  if (inUse > 0) return res.status(409).json({ error: `${inUse} ticket(s) are currently in this stage — move them first.` });
  db.prepare('DELETE FROM lifecycle_stages WHERE id = ?').run(stage.id); // cascades transitions touching it
  logAudit(req, { action: 'lifecycle.stage_deleted', entityType: 'lifecycle', entityId: stage.lifecycle_id, entityLabel: `${stage.ticket_type}: ${stage.label}` });
  res.json({ ok: true });
});

// ---- Transitions ----

router.post('/:id/transitions', requirePermission('lifecycles.manage'), loadOwnedLifecycle, (req, res) => {
  const { from_stage_id, to_stage_id, requires_role, condition_field, condition_operator, condition_value } = req.body;
  if (!from_stage_id || !to_stage_id) return res.status(400).json({ error: 'from_stage_id and to_stage_id required' });
  if (from_stage_id === to_stage_id) return res.status(400).json({ error: 'A stage cannot transition to itself.' });
  const stages = db.prepare('SELECT id FROM lifecycle_stages WHERE lifecycle_id = ?').all(req.lifecycle.id).map((s) => s.id);
  if (!stages.includes(from_stage_id) || !stages.includes(to_stage_id)) return res.status(400).json({ error: 'Both stages must belong to this lifecycle.' });
  const existing = db.prepare('SELECT id FROM lifecycle_transitions WHERE lifecycle_id = ? AND from_stage_id = ? AND to_stage_id = ?').get(req.lifecycle.id, from_stage_id, to_stage_id);
  if (existing) return res.status(409).json({ error: 'This transition already exists.' });
  const id = uid('lct');
  db.prepare(
    'INSERT INTO lifecycle_transitions (id, lifecycle_id, from_stage_id, to_stage_id, requires_role, condition_field, condition_operator, condition_value) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, req.lifecycle.id, from_stage_id, to_stage_id, requires_role || null, condition_field || null, condition_operator || null, condition_value || null);
  logAudit(req, { action: 'lifecycle.transition_created', entityType: 'lifecycle', entityId: req.lifecycle.id, entityLabel: req.lifecycle.ticket_type, details: { requires_role } });
  res.status(201).json({ id });
});

router.patch('/transitions/:transitionId', requirePermission('lifecycles.manage'), (req, res) => {
  const transition = db.prepare(
    `SELECT t.*, lc.ticket_type FROM lifecycle_transitions t JOIN ticket_lifecycles lc ON lc.id = t.lifecycle_id WHERE t.id = ? AND lc.workspace_id = ?`
  ).get(req.params.transitionId, req.workspaceId);
  if (!transition) return res.status(404).json({ error: 'Not found' });
  const { requires_role, condition_field, condition_operator, condition_value } = req.body;
  db.prepare(
    'UPDATE lifecycle_transitions SET requires_role = ?, condition_field = ?, condition_operator = ?, condition_value = ? WHERE id = ?'
  ).run(
    requires_role !== undefined ? (requires_role || null) : transition.requires_role,
    condition_field !== undefined ? (condition_field || null) : transition.condition_field,
    condition_operator !== undefined ? (condition_operator || null) : transition.condition_operator,
    condition_value !== undefined ? (condition_value || null) : transition.condition_value,
    transition.id
  );
  logAudit(req, { action: 'lifecycle.transition_updated', entityType: 'lifecycle', entityId: transition.lifecycle_id, entityLabel: transition.ticket_type, details: { requires_role, condition_field, condition_operator, condition_value } });
  res.json({ ok: true });
});

router.delete('/transitions/:transitionId', requirePermission('lifecycles.manage'), (req, res) => {
  const transition = db.prepare(
    `SELECT t.*, lc.ticket_type FROM lifecycle_transitions t JOIN ticket_lifecycles lc ON lc.id = t.lifecycle_id WHERE t.id = ? AND lc.workspace_id = ?`
  ).get(req.params.transitionId, req.workspaceId);
  if (!transition) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM lifecycle_transitions WHERE id = ?').run(transition.id);
  logAudit(req, { action: 'lifecycle.transition_deleted', entityType: 'lifecycle', entityId: transition.lifecycle_id, entityLabel: transition.ticket_type });
  res.json({ ok: true });
});

export default router;
