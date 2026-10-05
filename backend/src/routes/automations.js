import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { traverseWorkflow, describeAction, ACTION_RISK_TIERS, decidePendingAction } from '../services/automationEngine.js';
import { deriveLegacyFromGraph } from '../services/workflowGraph.js';
import { getProvider, draftWorkflow } from '../services/aiClient.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
// Workflow automation is configuration, not day-to-day ITSM work — only
// admins build/view/edit/test it. Agents and requesters never reach this at
// all, not even read-only (there's nothing here they need).
router.use(requireAuth, requireWorkspace, requirePermission('automations.manage'));

function parseAutomation(r) {
  return {
    ...r,
    trigger: JSON.parse(r.trigger),
    conditions: JSON.parse(r.conditions || '[]'),
    actions: JSON.parse(r.actions),
    nodes: JSON.parse(r.nodes || '[]'),
    edges: JSON.parse(r.edges || '[]'),
  };
}

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM automations WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({ automations: rows.map(parseAutomation) });
});

// The Safety Guardrail Matrix's tier for each action type, so the builder UI
// can show a risk badge as the admin composes a workflow.
router.get('/risk-tiers', (req, res) => {
  res.json({ tiers: ACTION_RISK_TIERS });
});

// Tier C actions (currently just auto_approve) queued for a human decision,
// across every workflow in this workspace.
router.get('/pending', (req, res) => {
  const rows = db.prepare(
    `SELECT p.*, a.name AS automation_name, t.number AS ticket_number, t.title AS ticket_title
     FROM automation_pending_actions p
     JOIN automations a ON a.id = p.automation_id
     LEFT JOIN tickets t ON t.id = p.ticket_id
     WHERE p.workspace_id = ? AND p.status = 'pending'
     ORDER BY p.created_at DESC`
  ).all(req.workspaceId);
  res.json({
    pending: rows.map((r) => {
      const action = JSON.parse(r.action);
      const description = r.kind === 'approval'
        ? `get approval: "${action.title || 'Approval required'}"`
        : describeAction(action).replace('would ', '');
      return { ...r, action, description };
    }),
  });
});

router.post('/pending/:id/approve', async (req, res) => {
  try {
    const result = await decidePendingAction(req.params.id, req.workspaceId, true, req.user.id, req.body?.note);
    if (!result) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, status: result.status });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/pending/:id/reject', async (req, res) => {
  const result = await decidePendingAction(req.params.id, req.workspaceId, false, req.user.id, req.body?.note);
  if (!result) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true, status: result.status });
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM automations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json({ automation: parseAutomation(row) });
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
  const { name, description, nodes, edges, enabled = true } = req.body;
  if (!name || !Array.isArray(nodes) || !nodes.some((n) => n.type === 'trigger')) {
    return res.status(400).json({ error: 'name and a graph with a trigger node are required' });
  }
  const id = uid('wf');
  const legacy = deriveLegacyFromGraph(nodes, edges || []);
  db.prepare(
    'INSERT INTO automations (id, workspace_id, name, description, enabled, trigger, conditions, actions, nodes, edges) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(
    id, req.workspaceId, name, description || '', enabled ? 1 : 0,
    JSON.stringify(legacy.trigger), JSON.stringify(legacy.conditions), JSON.stringify(legacy.actions),
    JSON.stringify(nodes), JSON.stringify(edges || [])
  );
  logAudit(req, { action: 'automation.created', entityType: 'automation', entityId: id, entityLabel: name });
  res.status(201).json({ id });
});

router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM automations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, description, nodes, edges, enabled, test_mode } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description); }
  if (nodes !== undefined) {
    const legacy = deriveLegacyFromGraph(nodes, edges || JSON.parse(row.edges || '[]'));
    fields.push('nodes = ?'); params.push(JSON.stringify(nodes));
    fields.push('trigger = ?'); params.push(JSON.stringify(legacy.trigger));
    fields.push('conditions = ?'); params.push(JSON.stringify(legacy.conditions));
    fields.push('actions = ?'); params.push(JSON.stringify(legacy.actions));
  }
  if (edges !== undefined) { fields.push('edges = ?'); params.push(JSON.stringify(edges)); }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (test_mode !== undefined) { fields.push('test_mode = ?'); params.push(test_mode ? 1 : 0); }
  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE automations SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'automation.updated', entityType: 'automation', entityId: req.params.id, entityLabel: row.name, details: { name, enabled, test_mode } });
  res.json({ ok: true });
});

// Instant feedback: walks this workflow's graph against the last 30 days of
// tickets right now, without waiting for new real events to trickle in and
// without ever executing an action (traverseWorkflow in 'preview' mode never
// writes to the DB or calls out) — pure read-only preview, including which
// path each ticket actually took so the builder can highlight it on the canvas.
router.post('/:id/test-run', async (req, res) => {
  const row = db.prepare('SELECT * FROM automations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  let nodes, edges;
  try {
    nodes = JSON.parse(row.nodes || '[]');
    edges = JSON.parse(row.edges || '[]');
  } catch {
    return res.status(400).json({ error: 'This workflow has an invalid graph and cannot be tested' });
  }

  const tickets = db.prepare(
    "SELECT * FROM tickets WHERE workspace_id = ? AND created_at >= datetime('now','-30 days') ORDER BY created_at DESC LIMIT 200"
  ).all(req.workspaceId);

  const results = [];
  for (const t of tickets) {
    // eslint-disable-next-line no-await-in-loop
    const walk = await traverseWorkflow({ ticket: t, nodes, edges, mode: 'preview', automationId: row.id, automationName: row.name });
    if (walk.actionResults.length === 0 && walk.gatedNodeIds.length === 0) continue;
    results.push({
      ticket: { id: t.id, number: t.number, title: t.title, priority: t.priority, status: t.status },
      would: walk.actionResults,
      visitedNodeIds: walk.visitedNodeIds,
      visitedEdgeIds: walk.visitedEdgeIds,
      gatedNodeIds: walk.gatedNodeIds,
    });
  }

  res.json({ checked: tickets.length, matched: results.length, results });
});

router.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM automations WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM automations WHERE id = ?').run(req.params.id);
  logAudit(req, { action: 'automation.deleted', entityType: 'automation', entityId: req.params.id, entityLabel: row.name });
  res.json({ ok: true });
});

export default router;
