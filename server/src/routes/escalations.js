import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

function withLevels(policy) {
  const levels = db.prepare('SELECT * FROM escalation_levels WHERE policy_id = ? ORDER BY level_order ASC').all(policy.id);
  return { ...policy, levels };
}

router.get('/policies', (req, res) => {
  const rows = db.prepare('SELECT * FROM escalation_policies WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({ policies: rows.map(withLevels) });
});

router.post('/policies', requirePermission('escalations.manage'), (req, res) => {
  const { name, ticket_type, priority, team, enabled = true, levels = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!Array.isArray(levels) || !levels.length) return res.status(400).json({ error: 'At least one escalation level is required' });
  const id = uid('esp');
  db.prepare(
    'INSERT INTO escalation_policies (id, workspace_id, name, ticket_type, priority, team, enabled) VALUES (?,?,?,?,?,?,?)'
  ).run(id, req.workspaceId, name, ticket_type || null, priority || null, team || null, enabled ? 1 : 0);
  levels.forEach((lvl, i) => {
    db.prepare(
      'INSERT INTO escalation_levels (id, policy_id, level_order, threshold_pct, notify_role, notify_user_id, set_priority, post_comment) VALUES (?,?,?,?,?,?,?,?)'
    ).run(uid('esl'), id, i + 1, Number(lvl.threshold_pct) || 100, lvl.notify_role || null, lvl.notify_user_id || null, lvl.set_priority || null, lvl.post_comment === false ? 0 : 1);
  });
  logAudit(req, { action: 'escalation_policy.created', entityType: 'escalation_policy', entityId: id, entityLabel: name });
  res.status(201).json({ id });
});

router.patch('/policies/:id', requirePermission('escalations.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM escalation_policies WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['name', 'ticket_type', 'priority', 'team', 'enabled'];
  const fields = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : (req.body[key] || null));
    }
  }
  if (fields.length) {
    params.push(req.params.id);
    db.prepare(`UPDATE escalation_policies SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  }
  // Levels are replaced wholesale on edit -- simpler and safer than diffing,
  // and ticket_escalations rows key off level_id, not level content, so
  // existing fired-history for the OLD level ids is orphaned (harmless --
  // it's just historical record of what already happened) rather than
  // corrupted.
  if (Array.isArray(req.body.levels)) {
    db.prepare('DELETE FROM escalation_levels WHERE policy_id = ?').run(req.params.id);
    req.body.levels.forEach((lvl, i) => {
      db.prepare(
        'INSERT INTO escalation_levels (id, policy_id, level_order, threshold_pct, notify_role, notify_user_id, set_priority, post_comment) VALUES (?,?,?,?,?,?,?,?)'
      ).run(uid('esl'), req.params.id, i + 1, Number(lvl.threshold_pct) || 100, lvl.notify_role || null, lvl.notify_user_id || null, lvl.set_priority || null, lvl.post_comment === false ? 0 : 1);
    });
  }
  logAudit(req, { action: 'escalation_policy.updated', entityType: 'escalation_policy', entityId: req.params.id, entityLabel: row.name, details: req.body });
  res.json({ ok: true });
});

router.delete('/policies/:id', requirePermission('escalations.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM escalation_policies WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM escalation_policies WHERE id = ?').run(req.params.id);
  logAudit(req, { action: 'escalation_policy.deleted', entityType: 'escalation_policy', entityId: req.params.id, entityLabel: row.name });
  res.json({ ok: true });
});

export default router;
