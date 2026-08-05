import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

router.get('/', (req, res) => {
  const { ticket_type, category } = req.query;
  let sql = 'SELECT * FROM ticket_field_rules WHERE workspace_id = ?';
  const params = [req.workspaceId];
  if (ticket_type) { sql += ' AND ticket_type = ?'; params.push(ticket_type); }
  if (category) { sql += ' AND (category IS NULL OR category = ?)'; params.push(category); }
  sql += ' ORDER BY ticket_type, sort_order, field_name';
  res.json({ rules: db.prepare(sql).all(...params) });
});

router.post('/', requireRole('admin'), (req, res) => {
  const { ticket_type, category, field_name, visible = true, required = false, sort_order = 0 } = req.body;
  if (!ticket_type || !field_name) return res.status(400).json({ error: 'ticket_type and field_name required' });
  const id = uid('fr');
  db.prepare(
    'INSERT INTO ticket_field_rules (id, workspace_id, ticket_type, category, field_name, visible, required, sort_order) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, req.workspaceId, ticket_type, category || null, field_name, visible ? 1 : 0, required ? 1 : 0, sort_order);
  res.status(201).json({ id });
});

router.patch('/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM ticket_field_rules WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['category', 'visible', 'required', 'sort_order'];
  const fields = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = ?`);
      params.push(typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : req.body[key]);
    }
  }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE ticket_field_rules SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM ticket_field_rules WHERE id = ? AND workspace_id = ?').run(req.params.id, req.workspaceId);
  res.json({ ok: true });
});

export default router;
