import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { getProvider, testProvider, dashboardInsights, askAssistant } from '../services/aiClient.js';
import { encrypt } from '../services/crypto.js';

const router = Router();

const aiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
router.use(aiLimiter, requireAuth, requireWorkspace);

router.get('/providers', (req, res) => {
  const rows = db.prepare('SELECT id, name, provider_type, base_url, model, is_default, created_at FROM ai_providers WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({ providers: rows });
});

router.post('/providers', requireRole('admin'), (req, res) => {
  const { name, provider_type, base_url, api_key, model, is_default = false, extra_headers = {} } = req.body;
  if (!name || !provider_type || !model) return res.status(400).json({ error: 'name, provider_type, model required' });
  const id = uid('ai');
  if (is_default) db.prepare('UPDATE ai_providers SET is_default = 0 WHERE workspace_id = ?').run(req.workspaceId);
  db.prepare(
    'INSERT INTO ai_providers (id, workspace_id, name, provider_type, base_url, api_key, model, is_default, extra_headers) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, req.workspaceId, name, provider_type, base_url || null, encrypt(api_key) || null, model, is_default ? 1 : 0, JSON.stringify(extra_headers));
  res.status(201).json({ id });
});

router.patch('/providers/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT * FROM ai_providers WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, provider_type, base_url, api_key, model, is_default, extra_headers } = req.body;
  if (is_default) db.prepare('UPDATE ai_providers SET is_default = 0 WHERE workspace_id = ?').run(req.workspaceId);
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (provider_type !== undefined) { fields.push('provider_type = ?'); params.push(provider_type); }
  if (base_url !== undefined) { fields.push('base_url = ?'); params.push(base_url); }
  if (api_key !== undefined && api_key !== '') { fields.push('api_key = ?'); params.push(encrypt(api_key)); }
  if (model !== undefined) { fields.push('model = ?'); params.push(model); }
  if (is_default !== undefined) { fields.push('is_default = ?'); params.push(is_default ? 1 : 0); }
  if (extra_headers !== undefined) { fields.push('extra_headers = ?'); params.push(JSON.stringify(extra_headers)); }
  params.push(req.params.id);
  db.prepare(`UPDATE ai_providers SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/providers/:id', requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM ai_providers WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM ai_providers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/providers/:id/test', requireRole('admin'), async (req, res) => {
  try {
    const provider = getProvider(req.workspaceId, req.params.id);
    if (!provider) return res.status(404).json({ error: 'Not found' });
    const reply = await testProvider(provider);
    res.json({ ok: true, reply });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

function buildStats(workspaceId) {
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM tickets WHERE workspace_id = ? GROUP BY status').all(workspaceId);
  const byPriority = db.prepare('SELECT priority, COUNT(*) c FROM tickets WHERE workspace_id = ? GROUP BY priority').all(workspaceId);
  const byCategory = db.prepare('SELECT category, COUNT(*) c FROM tickets WHERE workspace_id = ? GROUP BY category').all(workspaceId);
  const byTeam = db.prepare('SELECT team, COUNT(*) c FROM tickets WHERE workspace_id = ? AND team IS NOT NULL GROUP BY team').all(workspaceId);
  const slaBreached = db.prepare("SELECT COUNT(*) c FROM tickets WHERE workspace_id = ? AND (sla_breached = 1 OR (sla_due_at < datetime('now') AND status NOT IN ('resolved','closed')))").get(workspaceId);
  const openCount = db.prepare("SELECT COUNT(*) c FROM tickets WHERE workspace_id = ? AND status NOT IN ('resolved','closed')").get(workspaceId);
  const totalCount = db.prepare('SELECT COUNT(*) c FROM tickets WHERE workspace_id = ?').get(workspaceId);
  const last7days = db.prepare("SELECT date(created_at) d, COUNT(*) c FROM tickets WHERE workspace_id = ? AND created_at >= datetime('now','-7 days') GROUP BY date(created_at) ORDER BY d").all(workspaceId);
  const topAgents = db.prepare(
    `SELECT u.name, COUNT(*) c FROM tickets t JOIN users u ON u.id = t.assignee_id WHERE t.workspace_id = ? AND t.status NOT IN ('resolved','closed') GROUP BY t.assignee_id ORDER BY c DESC LIMIT 5`
  ).all(workspaceId);
  return { byStatus, byPriority, byCategory, byTeam, slaBreached: slaBreached.c, openCount: openCount.c, totalCount: totalCount.c, last7days, topAgents };
}

router.get('/dashboard-stats', (req, res) => {
  res.json({ stats: buildStats(req.workspaceId) });
});

router.post('/dashboard-insights', async (req, res) => {
  try {
    const provider = getProvider(req.workspaceId, req.body.provider_id);
    const stats = buildStats(req.workspaceId);
    const insights = await dashboardInsights(provider, stats);
    res.json({ insights, stats });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/ask', async (req, res) => {
  try {
    const { question, provider_id } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });
    const provider = getProvider(req.workspaceId, provider_id);
    const stats = buildStats(req.workspaceId);
    const recentTickets = db.prepare('SELECT number, title, status, priority, category, team FROM tickets WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 30').all(req.workspaceId);
    const answer = await askAssistant(provider, question, { stats, recentTickets });
    res.json({ answer });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
