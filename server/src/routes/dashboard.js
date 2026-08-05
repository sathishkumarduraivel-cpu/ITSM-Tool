import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, attachWorkspace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

const DEFAULT_LAYOUT = [
  { id: 'stat_open', type: 'stat', metric: 'openCount', label: 'Open tickets', tone: 'brand' },
  { id: 'stat_sla', type: 'stat', metric: 'slaBreached', label: 'SLA at risk / breached', tone: 'red' },
  { id: 'stat_total', type: 'stat', metric: 'totalCount', label: 'Total tickets', tone: 'amber' },
  { id: 'stat_categories', type: 'stat', metric: 'categoryCount', label: 'Categories tracked', tone: 'green' },
  { id: 'chart_trend', type: 'line', metric: 'last7days', label: 'Ticket volume — last 7 days' },
  { id: 'chart_priority', type: 'pie', metric: 'byPriority', label: 'By priority' },
  { id: 'chart_status', type: 'bar', metric: 'byStatus', label: 'By status' },
];

// Dashboard layout is a per-user preference — stored under a fixed system key
// (not scoped by workspace, since there's one shared pool of data for everyone).
const SETTINGS_SCOPE = '_global';
function keyFor(userId) {
  return `dashboard_layout:${userId}`;
}

router.get('/layout', (req, res) => {
  const row = db.prepare('SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ?').get(SETTINGS_SCOPE, keyFor(req.user.id));
  res.json({ layout: row ? JSON.parse(row.value) : DEFAULT_LAYOUT });
});

router.put('/layout', (req, res) => {
  const { layout } = req.body;
  if (!Array.isArray(layout)) return res.status(400).json({ error: 'layout must be an array' });
  db.prepare(
    `INSERT INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?,?,?,datetime('now'))
     ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(SETTINGS_SCOPE, keyFor(req.user.id), JSON.stringify(layout));
  res.json({ ok: true });
});

router.get('/catalog', (req, res) => {
  res.json({ available: DEFAULT_LAYOUT });
});

export default router;
