import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { ticketMatchesConditions, describeAction } from '../services/automationEngine.js';
import { getProvider, draftWorkflow } from '../services/aiClient.js';

const router = Router();
// Workflow automation is configuration, not day-to-day ITSM work — only
// admins build/view/edit/test it. Agents and requesters never reach this at
// all, not even read-only (there's nothing here they need).
router.use(requireAuth, requireWorkspace, requireRole('admin'));

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM automations WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
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
  const automation = db.prepare('SELECT id FROM automations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!automation) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare('SELECT * FROM automation_logs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 100').all(req.params.id);
  res.json({ logs: rows });
});

// Sona drafts a workflow from a plain-English description — grounded in the
// workspace's real groups/agents/integrations so it never invents a target
// that doesn't exist. This never saves anything; the draft is returned for
// the admin to review in the normal builder before it becomes a real workflow.
router.post('/draft', async (req, res) => {
  try {
    const { description } = req.body;
    if (!description || !description.trim()) return res.status(400).json({ error: 'description required' });
    const groups = db.prepare('SELECT id, name FROM groups WHERE workspace_id = ?').all(req.workspaceId);
    const agents = db.prepare(
      `SELECT u.id, u.name FROM workspace_members wm JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = ? AND wm.role IN ('agent','admin') AND wm.active = 1`
    ).all(req.workspaceId);
    const integrations = db.prepare('SELECT id, name, type FROM integrations WHERE workspace_id = ? AND enabled = 1').all(req.workspaceId);
    const provider = getProvider(req.workspaceId, req.body.provider_id);
    const draft = await draftWorkflow(provider, description.trim(), { groups, agents, integrations });
    res.json({ draft });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
  const row = db.prepare('SELECT * FROM automations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, description, trigger, conditions, actions, enabled, test_mode } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description); }
  if (trigger !== undefined) { fields.push('trigger = ?'); params.push(JSON.stringify(trigger)); }
  if (conditions !== undefined) { fields.push('conditions = ?'); params.push(JSON.stringify(conditions)); }
  if (actions !== undefined) { fields.push('actions = ?'); params.push(JSON.stringify(actions)); }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (test_mode !== undefined) { fields.push('test_mode = ?'); params.push(test_mode ? 1 : 0); }
  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE automations SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// Instant feedback: checks this workflow's conditions against the last 30
// days of tickets right now, without waiting for new real events to trickle
// in and without ever executing an action — pure read-only preview.
router.post('/:id/test-run', (req, res) => {
  const row = db.prepare('SELECT * FROM automations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  let conditions, actions;
  try {
    conditions = JSON.parse(row.conditions || '[]');
    actions = JSON.parse(row.actions);
  } catch {
    return res.status(400).json({ error: 'This workflow has invalid conditions/actions and cannot be tested' });
  }

  const tickets = db.prepare(
    "SELECT * FROM tickets WHERE workspace_id = ? AND created_at >= datetime('now','-30 days') ORDER BY created_at DESC LIMIT 200"
  ).all(req.workspaceId);

  const wouldDo = actions.map(describeAction);
  const results = tickets
    .map((t) => ({
      matched: ticketMatchesConditions(t, conditions),
      ticket: { id: t.id, number: t.number, title: t.title, priority: t.priority, status: t.status },
    }))
    .filter((r) => r.matched)
    .map((r) => ({ ...r, would: wouldDo }));

  res.json({ checked: tickets.length, matched: results.length, results });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM automations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM automations WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
