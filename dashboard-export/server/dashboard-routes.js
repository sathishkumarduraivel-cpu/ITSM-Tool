// The 4 endpoints Dashboard.jsx calls, extracted from server/src/routes/ai.js.
// Mount under whatever prefix you want (this project used /api/ai):
//   app.use('/api/ai', dashboardRouter)
//
// Depends on:
//   - `db`            a prepare().run/get/all-style SQLite handle (see server/src/db.js)
//   - `requireAuth`    auth middleware (see server/src/middleware/auth.js)
//   - `getProvider`, `dashboardInsights`, `askAssistant`  from ./aiClient.js (copied alongside this file)
//
// Assumes a `tickets` table with columns used below (status, priority, category,
// team, created_at, resolved_at, sla_breached, sla_due_at, assignee_id, type,
// cab_status, change_type, known_error, workaround, ai_summary,
// ai_suggested_category) plus `users`, `automations`, `major_incidents`, `assets`,
// `contracts`, `purchase_orders`, `kb_articles`, `catalog_items`,
// `problem_incident_links`, `csat_surveys`, `ai_providers`. Trim the parts of
// buildCommandCenterStats that reference tables you don't have.

import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { getProvider, dashboardInsights, askAssistant } from './aiClient.js';

const router = Router();

function buildStats() {
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM tickets GROUP BY status').all();
  const byPriority = db.prepare('SELECT priority, COUNT(*) c FROM tickets GROUP BY priority').all();
  const byCategory = db.prepare('SELECT category, COUNT(*) c FROM tickets GROUP BY category').all();
  const byTeam = db.prepare('SELECT team, COUNT(*) c FROM tickets WHERE team IS NOT NULL GROUP BY team').all();
  const slaBreached = db.prepare("SELECT COUNT(*) c FROM tickets WHERE sla_breached = 1 OR (sla_due_at < datetime('now') AND status NOT IN ('resolved','closed'))").get();
  const openCount = db.prepare("SELECT COUNT(*) c FROM tickets WHERE status NOT IN ('resolved','closed')").get();
  const totalCount = db.prepare('SELECT COUNT(*) c FROM tickets').get();
  const last7days = db.prepare("SELECT date(created_at) d, COUNT(*) c FROM tickets WHERE created_at >= datetime('now','-7 days') GROUP BY date(created_at) ORDER BY d").all();
  const topAgents = db.prepare(
    `SELECT u.name, COUNT(*) c FROM tickets t JOIN users u ON u.id = t.assignee_id WHERE t.status NOT IN ('resolved','closed') GROUP BY t.assignee_id ORDER BY c DESC LIMIT 5`
  ).all();
  return { byStatus, byPriority, byCategory, byTeam, slaBreached: slaBreached.c, openCount: openCount.c, totalCount: totalCount.c, last7days, topAgents };
}

router.get('/dashboard-stats', requireAuth, (req, res) => {
  res.json({ stats: buildStats() });
});

// ---- Command Center: one big aggregate for the executive dashboard ----
function buildCommandCenterStats(filters = {}) {
  const days = Number(filters.days) > 0 ? Number(filters.days) : 30;
  const { team, priority, status, owner, type } = filters;

  const whereClause = (opts = {}) => {
    const clauses = ["created_at >= datetime('now', ?)"];
    const params = [`-${days} days`];
    if (team) { clauses.push('team = ?'); params.push(team); }
    if (priority) { clauses.push('priority = ?'); params.push(priority); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    if (owner) { clauses.push('assignee_id = ?'); params.push(owner); }
    if (type && opts.applyType !== false) { clauses.push('type = ?'); params.push(type); }
    if (opts.extra) { clauses.push(opts.extra); }
    return { sql: clauses.join(' AND '), params };
  };

  const wAll = whereClause();
  const wTickets = whereClause({ extra: "type IN ('incident','request')" });

  const totalCount = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql}`).get(...wAll.params).c;
  const openCount = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND status NOT IN ('resolved','closed')`).get(...wAll.params).c;
  const closedCount = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND status IN ('resolved','closed')`).get(...wAll.params).c;
  const closedWithinSla = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wAll.sql} AND status IN ('resolved','closed') AND (sla_breached = 0 OR sla_breached IS NULL)`).get(...wAll.params).c;
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

  const csat = db.prepare(`SELECT AVG(rating) avg_rating, COUNT(*) responses FROM csat_surveys`).get();
  const csatScore = csat.avg_rating ? Math.round((csat.avg_rating / 5) * 100) : null;

  const autoTotal = db.prepare('SELECT COUNT(*) c FROM automations').get().c;
  const autoEnabled = db.prepare('SELECT COUNT(*) c FROM automations WHERE enabled = 1').get().c;
  const automationCoverage = autoTotal > 0 ? Math.round((autoEnabled / autoTotal) * 100) : 0;

  const wChanges = whereClause({ applyType: false, extra: "type = 'change'" });
  const changesTotal = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wChanges.sql}`).get(...wChanges.params).c;
  const changesApproved = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wChanges.sql} AND cab_status = 'approved'`).get(...wChanges.params).c;
  const changesPending = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wChanges.sql} AND cab_status = 'pending'`).get(...wChanges.params).c;
  const changesEmergency = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wChanges.sql} AND change_type = 'emergency'`).get(...wChanges.params).c;
  const changesClosed = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wChanges.sql} AND status IN ('resolved','closed')`).get(...wChanges.params).c;
  const cabApprovalRate = changesTotal > 0 ? Math.round((changesApproved / changesTotal) * 100) : 100;
  const emergencyChangeRatio = changesTotal > 0 ? Math.round((changesEmergency / changesTotal) * 100) : 0;

  const wProblems = whereClause({ applyType: false, extra: "type = 'problem'" });
  const problemsTotal = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wProblems.sql}`).get(...wProblems.params).c;
  const problemsOpen = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wProblems.sql} AND status NOT IN ('resolved','closed')`).get(...wProblems.params).c;
  const knownErrors = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wProblems.sql} AND known_error = 1`).get(...wProblems.params).c;
  const knownErrorsWithWorkaround = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wProblems.sql} AND known_error = 1 AND workaround IS NOT NULL AND workaround != ''`).get(...wProblems.params).c;
  const knownErrorReadiness = knownErrors > 0 ? Math.round((knownErrorsWithWorkaround / knownErrors) * 100) : 100;
  const linkedIncidents = db.prepare('SELECT COUNT(DISTINCT incident_id) c FROM problem_incident_links').get().c;
  const totalIncidents = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE ${wTickets.sql} AND type = 'incident'`).get(...wTickets.params).c;
  const correlationAccuracy = totalIncidents > 0 ? Math.round((linkedIncidents / totalIncidents) * 100) : 0;

  const miTotal = db.prepare('SELECT COUNT(*) c FROM major_incidents').get().c;
  const miOpen = db.prepare("SELECT COUNT(*) c FROM major_incidents WHERE status NOT IN ('closed')").get().c;
  const miClosed = db.prepare("SELECT COUNT(*) c FROM major_incidents WHERE status = 'closed'").get().c;

  const assetsTotal = db.prepare('SELECT COUNT(*) c FROM assets').get().c;
  const assetsHealthy = db.prepare("SELECT COUNT(*) c FROM assets WHERE status = 'in_use'").get().c;
  const assetHealth = assetsTotal > 0 ? Math.round((assetsHealthy / assetsTotal) * 100) : 100;

  const contractsDueForRenewal = db.prepare(
    `SELECT COUNT(*) c FROM contracts WHERE end_date IS NOT NULL AND julianday(end_date) - julianday('now') <= renewal_notice_days AND julianday(end_date) - julianday('now') >= 0`
  ).get().c;
  const posInFlight = db.prepare("SELECT COUNT(*) c FROM purchase_orders WHERE status = 'ordered'").get().c;

  const kbCategories = db.prepare('SELECT COUNT(DISTINCT category) c FROM kb_articles WHERE category IS NOT NULL').get().c;
  const ticketCategories = db.prepare(`SELECT COUNT(DISTINCT category) c FROM tickets WHERE ${wAll.sql} AND category IS NOT NULL`).get(...wAll.params).c;
  const documentationCoverage = ticketCategories > 0 ? Math.min(100, Math.round((kbCategories / ticketCategories) * 100)) : 100;

  const riskByCategory = db.prepare(
    `SELECT COALESCE(category, 'Uncategorized') category, COUNT(*) c FROM tickets
     WHERE ${wAll.sql} AND status NOT IN ('resolved','closed') AND (priority = 'critical' OR sla_breached = 1 OR sla_due_at < datetime('now'))
     GROUP BY category ORDER BY c DESC LIMIT 4`
  ).all(...wAll.params);

  const agents = db.prepare("SELECT id, name, team, avatar_color, role FROM users WHERE role IN ('admin','agent') ORDER BY name").all();
  const workloadByAgent = db.prepare(
    `SELECT u.id, u.name, COUNT(*) c FROM tickets t JOIN users u ON u.id = t.assignee_id
     WHERE ${wAll.sql.replace(/\bteam\b/, 't.team').replace(/\bpriority\b/, 't.priority').replace(/\bstatus\b/, 't.status').replace(/\bassignee_id\b/, 't.assignee_id').replace(/\btype\b/, 't.type').replace(/created_at/, 't.created_at')}
     AND t.status NOT IN ('resolved','closed') GROUP BY t.assignee_id ORDER BY c DESC`
  ).all(...wAll.params);
  const activeAgentIds = new Set(workloadByAgent.filter((a) => a.c > 0).map((a) => a.id));
  const teamRow = agents.slice(0, 7).map((a) => ({ ...a, active: activeAgentIds.has(a.id) }));
  const avgTicketsPerAgent = agents.length > 0 ? +(openCount / agents.length).toFixed(1) : 0;

  const trend = db.prepare(
    `SELECT date(created_at) d, COUNT(*) c FROM tickets WHERE ${wAll.sql} GROUP BY date(created_at) ORDER BY d`
  ).all(...wAll.params);

  const ticketMix = db.prepare(`SELECT type, COUNT(*) c FROM tickets WHERE ${wAll.sql} GROUP BY type`).all(...wAll.params);

  const debtTotal = changesTotal + problemsTotal;
  const debtResolved = changesClosed + (problemsTotal - problemsOpen);
  const debtResolvedPct = debtTotal > 0 ? Math.round((debtResolved / debtTotal) * 100) : 100;
  const topDebt = [
    { label: 'Pending CAB changes', value: changesPending },
    { label: 'Open problems', value: problemsOpen },
    { label: 'Emergency changes', value: changesEmergency },
  ].filter((d) => d.value > 0);

  const operatingHealth = openRisks === 0 ? 'Healthy' : openRisks <= 3 ? 'Stable' : 'At Risk';
  const maturityStage = automationCoverage >= 67
    ? { from: 'Standardized', to: 'Automated' }
    : automationCoverage >= 34
      ? { from: 'Ad hoc', to: 'Standardized' }
      : { from: 'Reactive', to: 'Ad hoc' };

  const risks = [];
  if (openRisks > 0) risks.push(`${openRisks} open ticket${openRisks === 1 ? '' : 's'} at critical priority or breaching SLA`);
  if (unassignedOpen > 0) risks.push(`${unassignedOpen} open ticket${unassignedOpen === 1 ? '' : 's'} unassigned`);
  if (changesPending > 0) risks.push(`${changesPending} change${changesPending === 1 ? '' : 's'} awaiting CAB approval`);
  if (problemsOpen > 0) risks.push(`${problemsOpen} problem${problemsOpen === 1 ? '' : 's'} still open, ${knownErrors} tracked as known errors`);
  if (miOpen > 0) risks.push(`${miOpen} major incident${miOpen === 1 ? '' : 's'} still active`);
  if (contractsDueForRenewal > 0) risks.push(`${contractsDueForRenewal} contract${contractsDueForRenewal === 1 ? '' : 's'} due for renewal soon`);
  if (risks.length === 0) risks.push('No elevated risks detected in the current filter window.');

  const workflowResilience = [
    {
      workflow: 'Incident Management', owner: 'Service Desk',
      health: openRisks === 0 ? 'Healthy' : openRisks <= 3 ? 'Stable' : 'At Risk',
      deps: 'CMDB, Notifications, SLA Policies',
      insight: totalIncidents > 0 ? `${totalIncidents} incidents in window, ${openRisks} at risk` : 'No incidents in window',
    },
    {
      workflow: 'Change Management', owner: 'Network',
      health: changesPending === 0 ? 'Healthy' : 'Stable',
      deps: 'CAB, Approvals',
      insight: changesPending > 0 ? `${changesPending} pending CAB review` : `${cabApprovalRate}% CAB approval rate`,
    },
    {
      workflow: 'Problem Management', owner: 'Network',
      health: problemsOpen === 0 ? 'Healthy' : 'Stable',
      deps: 'Known Error Database',
      insight: problemsOpen > 0 ? `${problemsOpen} open, ${knownErrors} known errors tracked` : 'No open problems',
    },
    {
      workflow: 'Major Incident Management', owner: 'Service Desk',
      health: miOpen === 0 ? 'Healthy' : 'At Risk',
      deps: 'Integrations, War-room bridge',
      insight: miOpen > 0 ? `${miOpen} active major incident(s)` : `${miClosed} resolved to date`,
    },
    {
      workflow: 'Service Catalog', owner: 'Service Desk',
      health: 'Healthy',
      deps: 'Approvals, SLA Policies',
      insight: `${db.prepare('SELECT COUNT(*) c FROM catalog_items WHERE enabled = 1').get().c} catalog items live`,
    },
  ];

  return {
    generatedAt: new Date().toISOString(),
    operatingHealth,
    maturityStage,
    execStatus: { reliabilityHealth, openRisks, automationCoverage, csatScore, cabApprovalRate },
    team: teamRow,
    avgTicketsPerAgent,
    orchestration: [
      {
        title: 'Service Desk Data Orchestration',
        chips: [
          { label: 'Triage Coverage', value: `${triageCoverage}%`, status: triageCoverage >= 80 ? 'Healthy' : 'Needs attention', tone: triageCoverage >= 80 ? 'green' : 'amber' },
          { label: 'Avg Resolution Time', value: avgResolutionHours ? `${Math.round(avgResolutionHours)}h` : '—', status: avgResolutionHours && avgResolutionHours <= 48 ? 'SLA met' : 'Trending up', tone: avgResolutionHours && avgResolutionHours <= 48 ? 'green' : 'amber' },
          { label: 'AI Signal Coverage', value: `${aiSignalCoverage}%`, status: aiSignalCoverage > 0 ? 'Trending up' : 'Not configured', tone: aiSignalCoverage > 0 ? 'blue' : 'amber' },
          { label: 'Problem Correlation', value: `${correlationAccuracy}%`, status: 'Stable', tone: 'blue' },
          { label: 'Known Error Ready', value: `${knownErrorReadiness}%`, status: 'Improving', tone: 'amber' },
        ],
      },
      {
        title: 'Change & Risk Governance',
        chips: [
          { label: 'CAB Approval Rate', value: `${cabApprovalRate}%`, status: cabApprovalRate >= 70 ? 'Healthy' : 'Needs review', tone: cabApprovalRate >= 70 ? 'green' : 'amber' },
          { label: 'Emergency Changes', value: `${emergencyChangeRatio}%`, status: emergencyChangeRatio <= 25 ? 'Stable' : 'Elevated', tone: emergencyChangeRatio <= 25 ? 'blue' : 'amber' },
          { label: 'Contract Renewals', value: contractsDueForRenewal, status: contractsDueForRenewal > 0 ? 'Action needed' : 'Clear', tone: contractsDueForRenewal > 0 ? 'amber' : 'green' },
          { label: 'POs In Flight', value: posInFlight, status: 'On track', tone: 'blue' },
          { label: 'Asset Health', value: `${assetHealth}%`, status: assetHealth >= 80 ? 'Healthy' : 'Needs attention', tone: assetHealth >= 80 ? 'green' : 'amber' },
        ],
      },
    ],
    kpi: {
      reliability: {
        value: reliabilityHealth,
        trend,
        contributors: [
          `${closedCount} ticket${closedCount === 1 ? '' : 's'} closed in window`,
          `${reliabilityHealth}% closed within SLA`,
          `${autoEnabled} of ${autoTotal} automations active`,
        ],
      },
      riskExposure: { total: openRisks, breakdown: riskByCategory },
      changeProblemDebt: { resolvedPct: debtResolvedPct, remainingPct: 100 - debtResolvedPct, topDebt },
      workload: { avgPerAgent: avgTicketsPerAgent, openCount, unassignedOpen, trend },
      readiness: {
        documentation: documentationCoverage,
        knownErrorReadiness,
        triageCoverage,
        automationCoverage,
      },
    },
    ticketMix,
    workflowResilience,
    risks,
    csat,
  };
}

router.get('/command-center-stats', requireAuth, (req, res) => {
  try {
    const stats = buildCommandCenterStats(req.query);
    res.json({ stats });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/dashboard-insights', requireAuth, async (req, res) => {
  try {
    const provider = getProvider(req.body.provider_id);
    const stats = buildStats();
    const insights = await dashboardInsights(provider, stats);
    res.json({ insights, stats });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/ask', requireAuth, async (req, res) => {
  try {
    const { question, provider_id } = req.body;
    if (!question) return res.status(400).json({ error: 'question required' });
    const provider = getProvider(provider_id);
    const stats = buildStats();
    const recentTickets = db.prepare('SELECT number, title, status, priority, category, team FROM tickets ORDER BY created_at DESC LIMIT 30').all();
    const answer = await askAssistant(provider, question, { stats, recentTickets });
    res.json({ answer });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
