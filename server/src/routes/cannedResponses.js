import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireWorkspace, requireRole('agent', 'admin'));

function getOwned(id, workspaceId) {
  return db.prepare('SELECT * FROM canned_responses WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
}

// `team` filters to responses visible from that team's ticket queue: global
// ones (team IS NULL) plus that team's own -- mirrors how a team-scoped
// agent would want the picker to behave in TicketDetail, without hiding
// anything from an admin who omits the filter.
router.get('/', (req, res) => {
  const { team, q } = req.query;
  let sql = 'SELECT * FROM canned_responses WHERE workspace_id = ?';
  const params = [req.workspaceId];
  if (team) { sql += ' AND (team IS NULL OR team = ?)'; params.push(team); }
  if (q) { sql += ' AND (title LIKE ? OR body_html LIKE ? OR shortcut LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY usage_count DESC, title ASC';
  res.json({ responses: db.prepare(sql).all(...params) });
});

router.post('/', (req, res) => {
  const { title, shortcut, category, team, body_html } = req.body;
  if (!title || !body_html) return res.status(400).json({ error: 'title and body_html required' });
  const id = uid('cnd');
  db.prepare(
    'INSERT INTO canned_responses (id, workspace_id, title, shortcut, category, team, body_html, created_by) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, req.workspaceId, title, shortcut || null, category || null, team || null, body_html, req.user.id);
  res.status(201).json({ response: getOwned(id, req.workspaceId) });
});

router.patch('/:id', (req, res) => {
  const row = getOwned(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const allowed = ['title', 'shortcut', 'category', 'team', 'body_html'];
  const fields = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });
  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE canned_responses SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ response: getOwned(req.params.id, req.workspaceId) });
});

router.delete('/:id', (req, res) => {
  const row = getOwned(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM canned_responses WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Fired when an agent actually inserts one into a reply -- powers the
// "most used first" ordering in GET / above, purely a usage signal rather
// than an audited action.
router.post('/:id/use', (req, res) => {
  const row = getOwned(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE canned_responses SET usage_count = usage_count + 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
