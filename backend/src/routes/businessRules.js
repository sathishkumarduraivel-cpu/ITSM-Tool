import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { buildFieldOptionsMap } from '../services/businessRules.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
// Read is open to any workspace member (ticket forms need it to render);
// create/edit/delete is admin-only, same as the rest of config.
router.use(requireAuth, requireWorkspace);

function parseRule(row) {
  return { ...row, conditions: JSON.parse(row.conditions), actions: JSON.parse(row.actions) };
}

router.get('/', (req, res) => {
  const { ticket_type } = req.query;
  let sql = 'SELECT * FROM business_rules WHERE workspace_id = ?';
  const params = [req.workspaceId];
  if (ticket_type) { sql += ' AND ticket_type = ?'; params.push(ticket_type); }
  sql += ' ORDER BY ticket_type, priority ASC, created_at ASC';
  res.json({ rules: db.prepare(sql).all(...params).map(parseRule) });
});

// Base (unfiltered) options for every option-bearing field on a type --
// built-in enums, Field Manager dropdowns, and (Request) the live Service
// Catalog. Used by the rule builder's option pickers and by ticket forms.
router.get('/options', (req, res) => {
  const { ticket_type } = req.query;
  if (!ticket_type) return res.status(400).json({ error: 'ticket_type required' });
  res.json({ options: buildFieldOptionsMap(req.workspaceId, ticket_type) });
});

router.post('/', requirePermission('business_rules.manage'), (req, res) => {
  const { ticket_type, name, conditions, actions, priority = 100, status = 'active' } = req.body;
  if (!ticket_type || !name) return res.status(400).json({ error: 'ticket_type and name required' });
  if (!Array.isArray(actions) || !actions.length) return res.status(400).json({ error: 'At least one action is required' });
  const id = uid('brl');
  db.prepare(
    'INSERT INTO business_rules (id, workspace_id, ticket_type, name, conditions, actions, priority, status) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    id, req.workspaceId, ticket_type, name,
    JSON.stringify(conditions || { logic: 'AND', rules: [] }), JSON.stringify(actions), priority, status
  );
  logAudit(req, { action: 'business_rule.created', entityType: 'business_rule', entityId: id, entityLabel: name });
  res.status(201).json({ id });
});

router.patch('/:id', requirePermission('business_rules.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM business_rules WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, conditions, actions, priority, status } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (conditions !== undefined) { fields.push('conditions = ?'); params.push(JSON.stringify(conditions)); }
  if (actions !== undefined) { fields.push('actions = ?'); params.push(JSON.stringify(actions)); }
  if (priority !== undefined) { fields.push('priority = ?'); params.push(priority); }
  if (status !== undefined) { fields.push('status = ?'); params.push(status); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE business_rules SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'business_rule.updated', entityType: 'business_rule', entityId: req.params.id, entityLabel: row.name, details: { name, priority, status } });
  res.json({ ok: true });
});

router.delete('/:id', requirePermission('business_rules.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM business_rules WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  db.prepare('DELETE FROM business_rules WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspaceId);
  if (row) logAudit(req, { action: 'business_rule.deleted', entityType: 'business_rule', entityId: req.params.id, entityLabel: row.name });
  res.json({ ok: true });
});

export default router;
