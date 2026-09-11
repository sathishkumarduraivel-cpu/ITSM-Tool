import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import { GROUP_BY_DIMENSIONS, METRICS, runCustomReport, runPivotReport, previousPeriod, runBacklogAging } from '../services/reportBuilder.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

function filtersFromQuery(q) {
  const { type, priority, team, category, status, assignee_id, from, to } = q;
  return { type, priority, team, category, status, assignee_id, from, to };
}

router.get('/tickets-summary', (req, res) => {
  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as month, COUNT(*) c,
      SUM(CASE WHEN status IN ('resolved','closed') THEN 1 ELSE 0 END) resolved
    FROM tickets WHERE workspace_id = ? GROUP BY month ORDER BY month
  `).all(req.workspaceId);
  const byAgent = db.prepare(`
    SELECT u.name, COUNT(*) total,
      SUM(CASE WHEN t.status IN ('resolved','closed') THEN 1 ELSE 0 END) resolved,
      SUM(CASE WHEN t.sla_due_at < datetime('now') AND t.status NOT IN ('resolved','closed') THEN 1 ELSE 0 END) breached
    FROM tickets t JOIN users u ON u.id = t.assignee_id WHERE t.workspace_id = ? GROUP BY t.assignee_id ORDER BY total DESC
  `).all(req.workspaceId);
  const avgResolutionHours = db.prepare(`
    SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24) avg_hours
    FROM tickets WHERE workspace_id = ? AND resolved_at IS NOT NULL
  `).get(req.workspaceId);
  const csat = db.prepare(
    `SELECT AVG(c.rating) avg_rating, COUNT(*) responses FROM csat_surveys c JOIN tickets t ON t.id = c.ticket_id WHERE t.workspace_id = ?`
  ).get(req.workspaceId);
  res.json({ byMonth, byAgent, avgResolutionHours: avgResolutionHours.avg_hours, csat });
});

router.get('/csat', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, t.number, t.title FROM csat_surveys c JOIN tickets t ON t.id = c.ticket_id WHERE t.workspace_id = ? ORDER BY c.created_at DESC
  `).all(req.workspaceId);
  res.json({ surveys: rows });
});

router.get('/export/tickets.csv', (req, res) => {
  const rows = db.prepare('SELECT number, type, title, status, priority, category, team, created_at, resolved_at FROM tickets WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  const header = 'Number,Type,Title,Status,Priority,Category,Team,Created,Resolved';
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [r.number, r.type, r.title, r.status, r.priority, r.category, r.team, r.created_at, r.resolved_at].map(esc).join(','));
  const csv = [header, ...lines].join('\n');
  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', 'attachment; filename="tickets.csv"');
  res.send(csv);
});

router.get('/backlog-aging', (req, res) => {
  res.json({ buckets: runBacklogAging(req.workspaceId) });
});

// Real, workspace-specific values (not a hardcoded guess) so the custom
// report builder's filter dropdowns only ever offer choices that actually
// exist in this workspace's data.
router.get('/filter-options', (req, res) => {
  const teams = db.prepare("SELECT DISTINCT team FROM tickets WHERE workspace_id = ? AND team IS NOT NULL AND team != '' ORDER BY team").all(req.workspaceId).map((r) => r.team);
  const categories = db.prepare("SELECT DISTINCT category FROM tickets WHERE workspace_id = ? AND category IS NOT NULL AND category != '' ORDER BY category").all(req.workspaceId).map((r) => r.category);
  res.json({ teams, categories, types: ['incident', 'request', 'problem', 'change'], priorities: ['low', 'medium', 'high', 'critical'], statuses: ['open', 'in_progress', 'on_hold', 'pending_approval', 'resolved', 'closed'] });
});

router.get('/dimensions', (req, res) => {
  res.json({
    dimensions: Object.entries(GROUP_BY_DIMENSIONS).map(([key, d]) => ({ key, label: d.label })),
    metrics: METRICS,
  });
});

router.get('/custom', (req, res) => {
  const { group_by, compare } = req.query;
  if (!group_by) return res.status(400).json({ error: 'group_by required' });
  const filters = filtersFromQuery(req.query);
  try {
    const rows = runCustomReport(req.workspaceId, { group_by, filters });
    if (!compare) return res.json({ rows });

    // Period-over-period: same report, run again against the equivalent
    // prior window, so the frontend can show "+12% vs last period" deltas
    // per group instead of a bare number with no sense of direction.
    const { current, previous } = previousPeriod(filters);
    const previousRows = runCustomReport(req.workspaceId, { group_by, filters: { ...filters, from: previous.from, to: previous.to } });
    res.json({ rows, previousRows, currentRange: current, previousRange: previous });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/pivot', (req, res) => {
  const { row, column } = req.query;
  if (!row || !column) return res.status(400).json({ error: 'row and column required' });
  try {
    res.json(runPivotReport(req.workspaceId, { rowDim: row, colDim: column, filters: filtersFromQuery(req.query) }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/pivot/export.csv', (req, res) => {
  const { row, column } = req.query;
  if (!row || !column) return res.status(400).json({ error: 'row and column required' });
  let pivot;
  try {
    pivot = runPivotReport(req.workspaceId, { rowDim: row, colDim: column, filters: filtersFromQuery(req.query) });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = [pivot.rowLabel, ...pivot.colKeys, 'Total'].map(esc).join(',');
  const lines = pivot.rowKeys.map((r) => [r, ...pivot.colKeys.map((c) => pivot.matrix[r][c] || 0), pivot.rowTotals[r]].map(esc).join(','));
  lines.push(['Total', ...pivot.colKeys.map((c) => pivot.colTotals[c]), pivot.grandTotal].map(esc).join(','));
  const csv = [header, ...lines].join('\n');
  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', `attachment; filename="pivot-${row}-by-${column}.csv"`);
  res.send(csv);
});

router.get('/custom/export.csv', (req, res) => {
  const { group_by } = req.query;
  if (!group_by) return res.status(400).json({ error: 'group_by required' });
  let rows;
  try {
    rows = runCustomReport(req.workspaceId, { group_by, filters: filtersFromQuery(req.query) });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const dimLabel = GROUP_BY_DIMENSIONS[group_by]?.label || group_by;
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = [dimLabel, 'Count', 'Resolved', 'SLA Breached', 'Avg Resolution (hrs)', 'First Response On Time %', 'Avg CSAT'].join(',');
  const lines = rows.map((r) => [
    r.group_key, r.count, r.resolved, r.breached,
    r.avg_resolution_hours ? r.avg_resolution_hours.toFixed(1) : '',
    r.first_response_on_time_pct ?? '',
    r.avg_csat ? r.avg_csat.toFixed(1) : '',
  ].map(esc).join(','));
  const csv = [header, ...lines].join('\n');
  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', `attachment; filename="report-${group_by}.csv"`);
  res.send(csv);
});

// ---- Saved report definitions -- private (only the author sees it, e.g.
// a personal work-in-progress view) or shared (whole workspace), filed
// under an optional freeform folder for grouping in the list. ----
router.get('/saved', (req, res) => {
  const rows = db.prepare(
    `SELECT * FROM saved_reports WHERE workspace_id = ? AND (visibility != 'private' OR created_by = ?) ORDER BY folder, created_at DESC`
  ).all(req.workspaceId, req.user.id).map((r) => ({ ...r, config: JSON.parse(r.config), mine: r.created_by === req.user.id }));
  res.json({ reports: rows });
});

router.post('/saved', (req, res) => {
  const { name, group_by, filters = {}, visibility = 'shared', folder, chart_type = 'bar' } = req.body;
  if (!name || !group_by) return res.status(400).json({ error: 'name and group_by required' });
  if (!GROUP_BY_DIMENSIONS[group_by]) return res.status(400).json({ error: 'Invalid group_by' });
  if (!['private', 'shared'].includes(visibility)) return res.status(400).json({ error: 'visibility must be private or shared' });
  const id = uid('rpt');
  db.prepare('INSERT INTO saved_reports (id, workspace_id, name, config, created_by, visibility, folder, chart_type) VALUES (?,?,?,?,?,?,?,?)').run(
    id, req.workspaceId, name.trim(), JSON.stringify({ group_by, filters }), req.user.id, visibility, folder?.trim() || null, chart_type
  );
  res.status(201).json({ id });
});

router.patch('/saved/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM saved_reports WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the report\'s author (or an admin) can edit it' });
  const { name, visibility, folder, chart_type } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name.trim()); }
  if (visibility !== undefined) {
    if (!['private', 'shared'].includes(visibility)) return res.status(400).json({ error: 'visibility must be private or shared' });
    fields.push('visibility = ?'); params.push(visibility);
  }
  if (folder !== undefined) { fields.push('folder = ?'); params.push(folder?.trim() || null); }
  if (chart_type !== undefined) { fields.push('chart_type = ?'); params.push(chart_type); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(row.id);
  db.prepare(`UPDATE saved_reports SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/saved/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM saved_reports WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.created_by !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Only the report\'s author (or an admin) can delete it' });
  db.prepare('DELETE FROM saved_reports WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/saved/:id/run', (req, res) => {
  const row = db.prepare(
    `SELECT * FROM saved_reports WHERE id = ? AND workspace_id = ? AND (visibility != 'private' OR created_by = ?)`
  ).get(req.params.id, req.workspaceId, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const config = JSON.parse(row.config);
  res.json({ name: row.name, config, chart_type: row.chart_type, rows: runCustomReport(req.workspaceId, config) });
});

export default router;
