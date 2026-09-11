import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import { resolveConditions } from '../services/sla.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

const CONDITION_OPS = new Set(['equals', 'not_equals', 'contains', 'greater_than', 'less_than', 'is_empty', 'is_not_empty']);

// A malformed rule (unknown operator, missing field) would either silently
// never match or throw deep inside the matcher at evaluation time on some
// future ticket -- caught here instead, at save time, with a message that
// says which rule is wrong.
function validateConditions(conditions) {
  if (conditions === undefined) return null;
  if (conditions === null) return null; // explicit "no conditions" is valid -- an unconditional catch-all
  if (typeof conditions !== 'object' || !Array.isArray(conditions.rules)) return 'conditions must be an object with a rules array';
  for (const [i, r] of conditions.rules.entries()) {
    if (!r.field) return `Rule ${i + 1}: choose a field`;
    if (!CONDITION_OPS.has(r.operator)) return `Rule ${i + 1}: unknown operator "${r.operator}"`;
    const needsValue = r.operator !== 'is_empty' && r.operator !== 'is_not_empty';
    if (needsValue && (r.value === undefined || r.value === '')) return `Rule ${i + 1}: enter a value`;
  }
  return null;
}

// Ordered exactly as they're EVALUATED (sort_order, then created_at) --
// the list the admin sees IS the precedence, first match wins, so the UI
// never has to explain a separate "specificity" concept.
router.get('/policies', (req, res) => {
  const rows = db.prepare('SELECT * FROM sla_policies WHERE workspace_id = ? ORDER BY sort_order ASC, created_at ASC').all(req.workspaceId);
  res.json({ policies: rows.map((p) => ({ ...p, conditions: resolveConditions(p) })) });
});

router.post('/policies', requirePermission('sla.manage'), (req, res) => {
  const { name, conditions, response_minutes = 60, resolution_minutes = 1440, business_hours_only = false, enabled = true } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const conditionsError = validateConditions(conditions);
  if (conditionsError) return res.status(400).json({ error: conditionsError });
  // Appended to the end of the evaluation order by default, never inserted
  // ahead of existing policies unasked -- an admin drags/reorders it into
  // place afterward if it needs to run earlier.
  const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM sla_policies WHERE workspace_id = ?').get(req.workspaceId).m;
  const id = uid('sla');
  db.prepare(
    `INSERT INTO sla_policies (id, workspace_id, name, conditions, sort_order, response_minutes, resolution_minutes, business_hours_only, enabled)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, name, conditions ? JSON.stringify(conditions) : null, (maxOrder ?? -1) + 1, response_minutes, resolution_minutes, business_hours_only ? 1 : 0, enabled ? 1 : 0);
  logAudit(req, { action: 'sla_policy.created', entityType: 'sla_policy', entityId: id, entityLabel: name });
  res.status(201).json({ id });
});

router.patch('/policies/:id', requirePermission('sla.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM sla_policies WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (req.body.conditions !== undefined) {
    const conditionsError = validateConditions(req.body.conditions);
    if (conditionsError) return res.status(400).json({ error: conditionsError });
  }
  const allowed = ['name', 'sort_order', 'response_minutes', 'resolution_minutes', 'business_hours_only', 'enabled'];
  const fields = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : req.body[key]);
    }
  }
  if (req.body.conditions !== undefined) {
    fields.push('conditions = ?');
    params.push(req.body.conditions ? JSON.stringify(req.body.conditions) : null);
  }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE sla_policies SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'sla_policy.updated', entityType: 'sla_policy', entityId: req.params.id, entityLabel: row.name, details: { name: req.body.name, enabled: req.body.enabled, sort_order: req.body.sort_order } });
  res.json({ ok: true });
});

router.delete('/policies/:id', requirePermission('sla.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM sla_policies WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM sla_policies WHERE id = ?').run(req.params.id);
  logAudit(req, { action: 'sla_policy.deleted', entityType: 'sla_policy', entityId: req.params.id, entityLabel: row.name });
  res.json({ ok: true });
});

router.get('/business-hours', (req, res) => {
  res.json({ businessHours: db.prepare('SELECT * FROM business_hours WHERE workspace_id = ? ORDER BY day_of_week').all(req.workspaceId) });
});

router.put('/business-hours', requirePermission('sla.manage'), (req, res) => {
  const { hours = [] } = req.body; // [{day_of_week, start_time, end_time}]
  db.prepare('DELETE FROM business_hours WHERE workspace_id = ?').run(req.workspaceId);
  for (const h of hours) {
    db.prepare('INSERT INTO business_hours (id, workspace_id, day_of_week, start_time, end_time) VALUES (?,?,?,?,?)').run(
      uid('bh'), req.workspaceId, h.day_of_week, h.start_time, h.end_time
    );
  }
  logAudit(req, { action: 'business_hours.updated', entityType: 'business_hours', details: { days: hours.length } });
  res.json({ ok: true });
});

// Tickets currently at risk of breaching (due within 2 hours) or already breached.
router.get('/at-risk', (req, res) => {
  const rows = db.prepare(`
    SELECT id, number, title, priority, status, sla_due_at, response_due_at, responded_at
    FROM tickets
    WHERE workspace_id = ? AND status NOT IN ('resolved', 'closed')
      AND (
        sla_due_at < datetime('now', '+2 hours')
        OR (response_due_at < datetime('now') AND responded_at IS NULL)
      )
    ORDER BY sla_due_at ASC
  `).all(req.workspaceId);
  res.json({ tickets: rows });
});

export default router;
