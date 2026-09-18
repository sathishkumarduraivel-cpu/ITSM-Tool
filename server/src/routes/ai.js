import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { getProvider, testProvider, dashboardInsights, askAssistant, describeProblem, askAboutMyTickets } from '../services/aiClient.js';
import { encrypt } from '../services/crypto.js';
import { getOnlineUserIds } from '../services/realtime.js';

const router = Router();

// Only gates routes that actually call out to an LLM provider -- dashboard
// stats and command-center stats are plain DB reads the Dashboard polls on
// every load, filter change and refresh click, so sharing this limiter with
// them exhausted it from ordinary use and left the page stuck (see the two
// routes below that don't apply it).
const aiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
router.use(requireAuth, requireWorkspace);

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
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
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

router.post('/providers/:id/test', aiLimiter, requireRole('admin'), async (req, res) => {
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

// ---- Command Center: aggregate stats for the dashboard's executive status
// card, filter bar, team roster, and data-orchestration chip rows. Scoped to
// tables/columns this schema actually has -- no major_incidents,
// problem_incident_links, change_type, or known_error/workaround columns, so
// equivalents are built from real fields instead (e.g. risk, responded_at). ----
function buildCommandCenterStats(workspaceId, filters = {}, callerId) {
  const days = Number(filters.days) > 0 ? Number(filters.days) : 30;
  const { team, priority, status, owner, type } = filters;

  const whereClause = (opts = {}) => {
    const clauses = ['workspace_id = ?', "created_at >= datetime('now', ?)"];
    const params = [workspaceId, `-${days} days`];
    if (team) { clauses.push('team = ?'); params.push(team); }
    if (priority) { clauses.push('priority = ?'); params.push(priority); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (owner) { clauses.push('assignee_id = ?'); params.push(owner); }
    if (type && opts.applyType !== false) { clauses.push('type = ?'); params.push(type); }
    if (opts.extra) { clauses.push(opts.extra); }
    return { sql: clauses.join(' AND '), params };
  };

  const wAll = whereClause();

  const totalCount = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql}`).get(...wAll.params).c;
  const closedCount = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND status IN ('resolved','closed')`).get(...wAll.params).c;
  // Computed live rather than trusting the stored sla_breached column, which
  // is only opportunistically stamped when a ticket is fetched individually
  // (see services/sla.js's stampSlaBreach) -- a ticket counted here may never
  // have been opened, so the stored column can't be relied on.
  const closedWithinSla = db.prepare(
    `SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND status IN ('resolved','closed') AND (sla_due_at IS NULL OR COALESCE(resolved_at, closed_at) <= sla_due_at)`
  ).get(...wAll.params).c;
  const reliabilityHealth = closedCount > 0 ? Math.round((closedWithinSla / closedCount) * 100) : 100;

  const openRisks = db.prepare(
    `SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND status NOT IN ('resolved','closed') AND (priority = 'critical' OR sla_breached = 1 OR (sla_due_at < datetime('now')))`
  ).get(...wAll.params).c;

  const unassignedOpen = db.prepare(
    `SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND status NOT IN ('resolved','closed') AND assignee_id IS NULL`
  ).get(...wAll.params).c;
  const assignedOpen = db.prepare(
    `SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND status NOT IN ('resolved','closed') AND assignee_id IS NOT NULL`
  ).get(...wAll.params).c;
  const triageCoverage = (assignedOpen + unassignedOpen) > 0 ? Math.round((assignedOpen / (assignedOpen + unassignedOpen)) * 100) : 100;

  const aiSignalCoverage = (() => {
    const withAi = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND (ai_summary IS NOT NULL OR ai_suggested_category IS NOT NULL)`).get(...wAll.params).c;
    return totalCount > 0 ? Math.round((withAi / totalCount) * 100) : 0;
  })();

  const avgResolutionHours = db.prepare(
    `SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24) avg_hours FROM tickets WHERE ${wAll.sql} AND resolved_at IS NOT NULL`
  ).get(...wAll.params).avg_hours;

  const respondedTotal = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND responded_at IS NOT NULL`).get(...wAll.params).c;
  const respondedOnTime = db.prepare(
    `SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND responded_at IS NOT NULL AND (response_due_at IS NULL OR responded_at <= response_due_at)`
  ).get(...wAll.params).c;
  const responseReadiness = respondedTotal > 0 ? Math.round((respondedOnTime / respondedTotal) * 100) : 100;

  const highRiskOpen = db.prepare(
    `SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND status NOT IN ('resolved','closed') AND risk = 'high'`
  ).get(...wAll.params).c;

  const csat = db.prepare(
    `SELECT AVG(cs.rating) avg_rating FROM csat_surveys cs JOIN tickets t ON t.id = cs.ticket_id WHERE t.workspace_id = ?`
  ).get(workspaceId);
  const csatScore = csat.avg_rating ? Math.round((csat.avg_rating / 5) * 100) : null;

  const autoTotal = db.prepare('SELECT COUNT(*) c FROM automations WHERE workspace_id = ?').get(workspaceId).c;
  const autoEnabled = db.prepare('SELECT COUNT(*) c FROM automations WHERE workspace_id = ? AND enabled = 1').get(workspaceId).c;
  const automationCoverage = autoTotal > 0 ? Math.round((autoEnabled / autoTotal) * 100) : 0;

  const wChanges = whereClause({ applyType: false, extra: "type = 'change'" });
  const changesTotal = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wChanges.sql}`).get(...wChanges.params).c;
  const changesApproved = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wChanges.sql} AND cab_status = 'approved'`).get(...wChanges.params).c;
  const changesPending = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wChanges.sql} AND cab_status = 'pending'`).get(...wChanges.params).c;
  const cabApprovalRate = changesTotal > 0 ? Math.round((changesApproved / changesTotal) * 100) : 100;

  const assetsTotal = db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ?').get(workspaceId).c;
  const assetsHealthy = db.prepare("SELECT COUNT(*) c FROM assets WHERE workspace_id = ? AND status = 'in_use'").get(workspaceId).c;
  const assetHealth = assetsTotal > 0 ? Math.round((assetsHealthy / assetsTotal) * 100) : 100;

  const contractsDueForRenewal = db.prepare(
    `SELECT COUNT(*) c FROM contracts WHERE workspace_id = ? AND end_date IS NOT NULL AND julianday(end_date) - julianday('now') <= renewal_notice_days AND julianday(end_date) - julianday('now') >= 0`
  ).get(workspaceId).c;
  const posInFlight = db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE workspace_id = ? AND status = 'ordered'").get(workspaceId).c;

  // Scoped to the viewer's own team (e.g. someone on "Service Desk" sees
  // only other "Service Desk" people here) -- unless the viewer has no team
  // set, in which case there's nothing to scope by and every admin/agent is
  // shown, same as before this filter existed.
  const callerTeam = callerId ? db.prepare('SELECT team FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, callerId)?.team : null;
  const agents = db.prepare(
    `SELECT u.id, u.name, wm.team, u.avatar_color, wm.role FROM workspace_members wm JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ? AND wm.role IN ('admin','agent') AND wm.active = 1
       AND (? IS NULL OR wm.team = ?)
     ORDER BY u.name`
  ).all(workspaceId, callerTeam || null, callerTeam || null);
  // `active` here means real presence (an open SSE connection right now --
  // see services/realtime.js), not workload. It used to be keyed off having
  // any open assigned tickets, which just meant "busy," not "online," and
  // showed green for someone who hadn't touched the app in days.
  const onlineIds = getOnlineUserIds(workspaceId);
  const teamRow = agents.slice(0, 7).map((a) => ({ ...a, active: onlineIds.has(a.id) }));

  const operatingHealth = openRisks === 0 ? 'Healthy' : openRisks <= 3 ? 'Stable' : 'At Risk';
  const maturityStage = automationCoverage >= 67
    ? { from: 'Standardized', to: 'Automated' }
    : automationCoverage >= 34
      ? { from: 'Ad hoc', to: 'Standardized' }
      : { from: 'Reactive', to: 'Ad hoc' };

  return {
    generatedAt: new Date().toISOString(),
    operatingHealth,
    maturityStage,
    execStatus: { reliabilityHealth, openRisks, automationCoverage, csatScore, cabApprovalRate },
    team: teamRow,
    orchestration: [
      {
        title: 'Service Desk Data Orchestration',
        chips: [
          { label: 'Triage Coverage', value: `${triageCoverage}%`, status: triageCoverage >= 80 ? 'Healthy' : 'Needs attention', tone: triageCoverage >= 80 ? 'green' : 'amber' },
          { label: 'Avg Resolution Time', value: avgResolutionHours ? `${Math.round(avgResolutionHours)}h` : '—', status: avgResolutionHours && avgResolutionHours <= 48 ? 'SLA met' : 'Trending up', tone: avgResolutionHours && avgResolutionHours <= 48 ? 'green' : 'amber' },
          { label: 'AI Signal Coverage', value: `${aiSignalCoverage}%`, status: aiSignalCoverage > 0 ? 'Trending up' : 'Not configured', tone: aiSignalCoverage > 0 ? 'blue' : 'amber' },
          { label: 'Response SLA', value: `${responseReadiness}%`, status: responseReadiness >= 80 ? 'On track' : 'Needs attention', tone: responseReadiness >= 80 ? 'green' : 'amber' },
          { label: 'High-Risk Open', value: highRiskOpen, status: highRiskOpen > 0 ? 'Monitor' : 'Clear', tone: highRiskOpen > 0 ? 'red' : 'green' },
        ],
      },
      {
        title: 'Change & Risk Governance',
        chips: [
          { label: 'CAB Approval Rate', value: `${cabApprovalRate}%`, status: cabApprovalRate >= 70 ? 'Healthy' : 'Needs review', tone: cabApprovalRate >= 70 ? 'green' : 'amber' },
          { label: 'CAB Pending', value: changesPending, status: changesPending > 0 ? 'Action needed' : 'Clear', tone: changesPending > 0 ? 'amber' : 'green' },
          { label: 'Contract Renewals', value: contractsDueForRenewal, status: contractsDueForRenewal > 0 ? 'Action needed' : 'Clear', tone: contractsDueForRenewal > 0 ? 'amber' : 'green' },
          { label: 'POs In Flight', value: posInFlight, status: 'On track', tone: 'blue' },
          { label: 'Asset Health', value: `${assetHealth}%`, status: assetHealth >= 80 ? 'Healthy' : 'Needs attention', tone: assetHealth >= 80 ? 'green' : 'amber' },
        ],
      },
    ],
  };
}

router.get('/command-center-stats', (req, res) => {
  try {
    const stats = buildCommandCenterStats(req.workspaceId, req.query, req.user.id);
    res.json({ stats });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/dashboard-insights', aiLimiter, async (req, res) => {
  try {
    const provider = getProvider(req.workspaceId, req.body.provider_id);
    const stats = buildStats(req.workspaceId);
    const insights = await dashboardInsights(provider, stats);
    res.json({ insights, stats });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/ask', aiLimiter, async (req, res) => {
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

// ---- Sona, light actions available to every role (requester/agent/admin) ----

router.post('/describe-problem', aiLimiter, async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
    const provider = getProvider(req.workspaceId, req.body.provider_id);
    const description = await describeProblem(provider, text.trim());
    res.json({ description });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/my-tickets-ask', aiLimiter, (req, res, next) => {
  // Deliberately re-derives the ticket set from the DB scoped to the caller
  // rather than trusting anything the client sends, so this can never be
  // used to ask about someone else's tickets.
  try {
    const { question } = req.body;
    if (!question || !question.trim()) return res.status(400).json({ error: 'question required' });
    const tickets = db.prepare(
      'SELECT number, title, type, status, priority, category, created_at, updated_at FROM tickets WHERE workspace_id = ? AND requester_id = ? ORDER BY created_at DESC LIMIT 50'
    ).all(req.workspaceId, req.user.id);
    const provider = getProvider(req.workspaceId, req.body.provider_id);
    askAboutMyTickets(provider, question.trim(), tickets)
      .then((answer) => res.json({ answer }))
      .catch((e) => res.status(400).json({ error: e.message }));
  } catch (e) {
    next(e);
  }
});

export default router;
