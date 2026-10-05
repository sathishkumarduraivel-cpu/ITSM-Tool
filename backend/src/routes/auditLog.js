import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireWorkspace, requirePermission('audit_log.view'));

const PAGE_SIZE = 50;

function buildFilter(req) {
  const { action, actor_id, entity_type, from, to, q } = req.query;
  let sql = 'FROM audit_log WHERE workspace_id = ?';
  const params = [req.workspaceId];
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (actor_id) { sql += ' AND actor_id = ?'; params.push(actor_id); }
  if (entity_type) { sql += ' AND entity_type = ?'; params.push(entity_type); }
  if (from) { sql += ' AND created_at >= ?'; params.push(from); }
  if (to) { sql += ' AND created_at <= ?'; params.push(to); }
  if (q) {
    sql += ' AND (actor_name LIKE ? OR entity_label LIKE ? OR action LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  return { sql, params };
}

router.get('/', (req, res) => {
  const { sql, params } = buildFilter(req);
  const page = Math.max(1, Number(req.query.page) || 1);
  const total = db.prepare(`SELECT COUNT(*) c ${sql}`).get(...params).c;
  const rows = db.prepare(`SELECT * ${sql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  res.json({ entries: rows, total, page, pageSize: PAGE_SIZE });
});

// Distinct actions/actors seen in this workspace, to populate filter dropdowns.
router.get('/meta', (req, res) => {
  const actions = db.prepare('SELECT DISTINCT action FROM audit_log WHERE workspace_id = ? ORDER BY action').all(req.workspaceId).map((r) => r.action);
  const actors = db.prepare(
    'SELECT DISTINCT actor_id, actor_name FROM audit_log WHERE workspace_id = ? AND actor_id IS NOT NULL ORDER BY actor_name'
  ).all(req.workspaceId);
  res.json({ actions, actors });
});

// Compliance export -- same filters as the list view, capped at 5000 rows
// (a genuinely huge export should be narrowed by date range instead).
router.get('/export', (req, res) => {
  const { sql, params } = buildFilter(req);
  const rows = db.prepare(`SELECT * ${sql} ORDER BY created_at DESC LIMIT 5000`).all(...params);

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['Timestamp', 'Actor', 'Role', 'Action', 'Entity Type', 'Entity', 'Details'].join(',');
  const lines = rows.map((r) => [r.created_at, r.actor_name, r.actor_role, r.action, r.entity_type, r.entity_label, r.details]
    .map(esc).join(','));
  const csv = [header, ...lines].join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

export default router;
