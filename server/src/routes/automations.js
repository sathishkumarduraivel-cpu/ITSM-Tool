import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, attachWorkspace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM automations ORDER BY created_at DESC').all();
  res.json({
    automations: rows.map((r) => ({
      ...r,
      trigger: JSON.parse(r.trigger),
      conditions: JSON.parse(r.conditions || '[]'),
      actions: JSON.parse(r.actions),
    })),
  });
});

router.get('/:id/logs', (req, res) => {
  const automation = db.prepare('SELECT id FROM automations WHERE id = ?').get(req.params.id);
  if (!automation) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare('SELECT * FROM automation_logs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 100').all(req.params.id);
  res.json({ logs: rows });
});

router.post('/', (req, res) => {
  const { name, description, trigger, conditions = [], actions, enabled = true } = req.body;
  if (!name || !trigger || !actions) return res.status(400).json({ error: 'name, trigger, actions required' });
  const id = uid('wf');
  db.prepare(
    'INSERT INTO automations (id, workspace_id, name, description, enabled, trigger, conditions, actions) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, req.workspaceId, name, description || '', enabled ? 1 : 0, JSON.stringify(trigger), JSON.stringify(conditions), JSON.stringify(actions));
  res.status(201).json({ id });
});

router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, description, trigger, conditions, actions, enabled } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description); }
  if (trigger !== undefined) { fields.push('trigger = ?'); params.push(JSON.stringify(trigger)); }
  if (conditions !== undefined) { fields.push('conditions = ?'); params.push(JSON.stringify(conditions)); }
  if (actions !== undefined) { fields.push('actions = ?'); params.push(JSON.stringify(actions)); }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE automations SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM automations WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM automations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
