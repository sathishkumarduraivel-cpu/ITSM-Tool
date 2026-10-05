// Risk scoring for a change.
//
// Risk decides which approval route a change takes, so it is deterministic:
// weighted rules over named signals, summed, then mapped to a band. Sona is
// wired in separately (assessPlanQuality below) and only ever produces
// *advisory* findings shown to approvers -- it cannot move the number. Same
// discipline as assignmentEngine.js, and for the same reason: an
// audit-relevant field must not depend on a non-deterministic service that
// may not even be configured.
//
// Two of the signals are not in the flow diagram and are the most valuable
// ones here, because this app can already answer them from its CMDB:
//   * blast_radius       -- how many CIs depend on what this change touches
//   * open_incidents_on_ci -- whether it is already broken
// A change to one server that forty things depend on is not low risk, and a
// priority/impact-only model cannot see that.
import { db, uid } from '../db.js';
import { computeBlastRadius } from './blastRadius.js';
import { getProvider, chatComplete } from './aiClient.js';

export const SIGNALS = [
  { key: 'change_type', label: 'Change type', kind: 'string' },
  { key: 'priority', label: 'Priority', kind: 'string' },
  { key: 'impact', label: 'Impact', kind: 'string' },
  { key: 'category', label: 'Category', kind: 'string' },
  { key: 'affected_ci_count', label: 'Affected CI count', kind: 'number' },
  { key: 'blast_radius', label: 'Downstream CIs affected (CMDB)', kind: 'number' },
  { key: 'open_incidents_on_ci', label: 'Open incidents on affected CIs', kind: 'number' },
  { key: 'window_duration_hours', label: 'Planned window length (hours)', kind: 'number' },
  { key: 'lead_time_hours', label: 'Notice before the window (hours)', kind: 'number' },
  { key: 'has_backout_plan', label: 'Backout plan present', kind: 'bool' },
  { key: 'has_test_plan', label: 'Test plan present', kind: 'bool' },
  { key: 'in_freeze_window', label: 'Falls inside a change freeze', kind: 'bool' },
];

export const OPERATORS = ['equals', 'not_equals', 'gte', 'lte', 'contains', 'is_empty', 'is_not_empty'];
export const BANDS = ['low', 'medium', 'high', 'critical'];

const DEFAULT_RULES = [
  { name: 'Emergency change', signal: 'change_type', operator: 'equals', value: 'emergency', points: 30 },
  { name: 'Expedited change', signal: 'change_type', operator: 'equals', value: 'expedite', points: 15 },
  { name: 'Standard change', signal: 'change_type', operator: 'equals', value: 'standard', points: -10 },
  { name: 'Critical priority', signal: 'priority', operator: 'equals', value: 'critical', points: 25 },
  { name: 'High priority', signal: 'priority', operator: 'equals', value: 'high', points: 15 },
  { name: 'High impact', signal: 'impact', operator: 'equals', value: 'high', points: 20 },
  { name: 'Touches several CIs', signal: 'affected_ci_count', operator: 'gte', value: '3', points: 10 },
  { name: 'Wide blast radius', signal: 'blast_radius', operator: 'gte', value: '10', points: 25 },
  { name: 'Very wide blast radius', signal: 'blast_radius', operator: 'gte', value: '25', points: 20 },
  { name: 'CI already has open incidents', signal: 'open_incidents_on_ci', operator: 'gte', value: '1', points: 20 },
  { name: 'No backout plan', signal: 'has_backout_plan', operator: 'equals', value: 'false', points: 25 },
  { name: 'No test plan', signal: 'has_test_plan', operator: 'equals', value: 'false', points: 10 },
  { name: 'Long implementation window', signal: 'window_duration_hours', operator: 'gte', value: '4', points: 10 },
  { name: 'Short notice', signal: 'lead_time_hours', operator: 'lte', value: '24', points: 10 },
  { name: 'Inside a change freeze', signal: 'in_freeze_window', operator: 'equals', value: 'true', points: 30 },
];

const DEFAULT_BANDS = [
  { band: 'low', min_score: 0, color: 'emerald' },
  { band: 'medium', min_score: 25, color: 'amber' },
  { band: 'high', min_score: 50, color: 'orange' },
  { band: 'critical', min_score: 80, color: 'red' },
];

// Seeds both rules and bands, but keys the decision on the *bands* only.
//
// An empty rule set is a legitimate configuration -- it means "score
// everything zero" -- so "no rules" cannot be the signal for "never seeded",
// or an admin who deliberately deletes every rule would silently get the
// whole default set back on the next read. Bands are different: scoring
// cannot resolve a level without at least one, so their absence is a
// reliable marker that this workspace has never been initialized.
export function ensureDefaultRiskConfig(workspaceId) {
  const bands = db.prepare('SELECT COUNT(*) c FROM change_risk_bands WHERE workspace_id = ?').get(workspaceId).c;
  if (bands > 0) return;

  DEFAULT_BANDS.forEach((b, i) => {
    db.prepare('INSERT INTO change_risk_bands (id, workspace_id, band, min_score, color, sort_order) VALUES (?,?,?,?,?,?)')
      .run(uid('crb'), workspaceId, b.band, b.min_score, b.color, i);
  });
  DEFAULT_RULES.forEach((r, i) => {
    db.prepare(
      'INSERT INTO change_risk_rules (id, workspace_id, name, signal, operator, value, points, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).run(uid('crr'), workspaceId, r.name, r.signal, r.operator, r.value, r.points, i);
  });
}

export function listRiskRules(workspaceId, { includeDisabled = false } = {}) {
  ensureDefaultRiskConfig(workspaceId);
  return db.prepare(
    `SELECT * FROM change_risk_rules WHERE workspace_id = ?${includeDisabled ? '' : ' AND enabled = 1'}
     ORDER BY sort_order ASC, created_at ASC`
  ).all(workspaceId);
}

export function listRiskBands(workspaceId) {
  ensureDefaultRiskConfig(workspaceId);
  return db.prepare('SELECT * FROM change_risk_bands WHERE workspace_id = ? ORDER BY min_score ASC').all(workspaceId);
}

function affectedAssetIds(ticketId) {
  return db.prepare('SELECT asset_id FROM ticket_assets WHERE ticket_id = ?').all(ticketId).map((r) => r.asset_id);
}

function hoursBetween(a, b) {
  const start = a ? new Date(a).getTime() : NaN;
  const end = b ? new Date(b).getTime() : NaN;
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  return (end - start) / 3600000;
}

// Resolves every signal for one change. Exported so the admin UI can show an
// admin what the live values are while they tune the rules -- a rule set you
// cannot see the inputs to is impossible to reason about.
export function resolveSignals(workspaceId, ticket, { inFreezeWindow = null } = {}) {
  const assetIds = ticket.id ? affectedAssetIds(ticket.id) : [];

  let blastRadius = 0;
  if (assetIds.length) {
    try {
      // affectedCount, not affected.length -- computeBlastRadius truncates
      // the `affected` list to 25 for display, so counting it would silently
      // cap this signal at 25 and make the "very wide blast radius" rule
      // unreachable.
      blastRadius = computeBlastRadius(assetIds, workspaceId)?.affectedCount || 0;
    } catch {
      blastRadius = 0; // a CMDB read failure must not block scoring
    }
  }

  let openIncidents = 0;
  if (assetIds.length) {
    const placeholders = assetIds.map(() => '?').join(',');
    openIncidents = db.prepare(
      `SELECT COUNT(DISTINCT t.id) c FROM tickets t
       JOIN ticket_assets ta ON ta.ticket_id = t.id
       WHERE t.workspace_id = ? AND t.type = 'incident'
         AND t.status NOT IN ('resolved','closed') AND COALESCE(t.is_spam,0) = 0
         AND ta.asset_id IN (${placeholders})`
    ).get(workspaceId, ...assetIds).c;
  }

  const start = ticket.scheduled_start || ticket.planned_start;
  const end = ticket.scheduled_end || ticket.planned_end;

  return {
    change_type: ticket.change_type || 'normal',
    priority: ticket.priority || 'medium',
    impact: ticket.impact || 'medium',
    category: ticket.category || '',
    affected_ci_count: assetIds.length,
    blast_radius: blastRadius,
    open_incidents_on_ci: openIncidents,
    window_duration_hours: hoursBetween(start, end) ?? 0,
    lead_time_hours: start ? Math.max(0, (new Date(start).getTime() - Date.now()) / 3600000) : 0,
    has_backout_plan: !!String(ticket.rollback_plan || '').trim(),
    has_test_plan: !!String(ticket.test_plan || '').trim(),
    in_freeze_window: !!inFreezeWindow,
  };
}

function matches(rule, signalValue) {
  const raw = rule.value;
  switch (rule.operator) {
    case 'equals':
      if (typeof signalValue === 'boolean') return String(signalValue) === String(raw).toLowerCase();
      return String(signalValue).toLowerCase() === String(raw ?? '').toLowerCase();
    case 'not_equals':
      if (typeof signalValue === 'boolean') return String(signalValue) !== String(raw).toLowerCase();
      return String(signalValue).toLowerCase() !== String(raw ?? '').toLowerCase();
    case 'gte':
      return Number(signalValue) >= Number(raw);
    case 'lte':
      return Number(signalValue) <= Number(raw);
    case 'contains':
      return String(signalValue).toLowerCase().includes(String(raw ?? '').toLowerCase());
    case 'is_empty':
      return signalValue === '' || signalValue === null || signalValue === undefined || signalValue === 0 || signalValue === false;
    case 'is_not_empty':
      return !(signalValue === '' || signalValue === null || signalValue === undefined || signalValue === 0 || signalValue === false);
    default:
      return false;
  }
}

export function bandForScore(workspaceId, score) {
  const bands = listRiskBands(workspaceId);
  let chosen = bands[0]?.band || 'low';
  for (const b of bands) {
    if (score >= b.min_score) chosen = b.band;
  }
  return chosen;
}

// The scoring entry point. Returns the score, its band, and every rule that
// contributed -- the contributions list is what the CAB actually reads, so a
// change's risk is never just an unexplained number.
export function scoreChange(workspaceId, ticket, opts = {}) {
  const signals = resolveSignals(workspaceId, ticket, opts);
  const rules = listRiskRules(workspaceId);

  const contributions = [];
  let score = 0;
  for (const rule of rules) {
    const signalValue = signals[rule.signal];
    if (signalValue === undefined) continue;
    if (!matches(rule, signalValue)) continue;
    score += rule.points;
    contributions.push({
      rule: rule.name,
      signal: rule.signal,
      signal_value: signalValue,
      points: rule.points,
    });
  }
  // Never negative: a Standard change with a -10 rule should read as 0, not
  // as something safer than nothing.
  score = Math.max(0, score);

  return { score, band: bandForScore(workspaceId, score), contributions, signals };
}

// Sona's plan review. Advisory only: findings are stored and shown to
// approvers, and are deliberately NOT an input to scoreChange above.
// Returns [] on any doubt -- no provider, transport failure, or output that
// is not the expected shape.
export async function assessPlanQuality(workspaceId, ticket) {
  const provider = getProvider(workspaceId);
  if (!provider) return { findings: [], aiUsed: false };

  try {
    const text = await chatComplete(provider, [
      {
        role: 'system',
        content: 'You review IT change records for planning gaps before a change advisory board sees them. You do not assign risk levels or approve anything. Return strict JSON only.',
      },
      {
        role: 'user',
        content: `Review this change for planning gaps.\n\n`
          + `Title: ${ticket.title || ''}\n`
          + `Type: ${ticket.change_type || 'normal'}\n`
          + `Implementation plan: ${String(ticket.implementation_plan || '(empty)').slice(0, 1500)}\n`
          + `Backout plan: ${String(ticket.rollback_plan || '(empty)').slice(0, 1000)}\n`
          + `Test plan: ${String(ticket.test_plan || '(empty)').slice(0, 1000)}\n`
          + `Planned window: ${ticket.planned_start || '(unset)'} to ${ticket.planned_end || '(unset)'}\n\n`
          + `Return exactly: {"findings":[{"severity":"info"|"warning"|"blocker","area":"implementation"|"backout"|"testing"|"scheduling","message":"<one sentence, max 160 chars>"}]}\n`
          + `Return at most 5 findings. If the plans are adequate, return an empty findings array.`,
      },
    ], { json: true, temperature: 0.1, max_tokens: 500 });

    const cleaned = String(text || '').trim()
      .replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed || !Array.isArray(parsed.findings)) return { findings: [], aiUsed: false };

    const severities = ['info', 'warning', 'blocker'];
    const areas = ['implementation', 'backout', 'testing', 'scheduling'];
    const findings = parsed.findings
      .filter((f) => f && typeof f.message === 'string')
      .slice(0, 5)
      .map((f) => ({
        severity: severities.includes(f.severity) ? f.severity : 'info',
        area: areas.includes(f.area) ? f.area : 'implementation',
        message: f.message.slice(0, 160),
      }));
    return { findings, aiUsed: true };
  } catch (e) {
    console.error('[change-risk] Sona plan review unavailable:', e.message);
    return { findings: [], aiUsed: false };
  }
}

// Persists an assessment and stamps the denormalized score/band onto the
// ticket, which is what approval routing and the pipeline board read.
export function saveAssessment(workspaceId, ticketId, assessment, advisory = { findings: [], aiUsed: false }) {
  const existing = db.prepare('SELECT id FROM change_risk_assessments WHERE ticket_id = ?').get(ticketId);
  const payload = [
    assessment.score, assessment.band,
    JSON.stringify(assessment.contributions || []),
    JSON.stringify(advisory.findings || []),
    advisory.aiUsed ? 1 : 0,
  ];
  if (existing) {
    db.prepare(
      "UPDATE change_risk_assessments SET score = ?, band = ?, contributions = ?, advisory = ?, ai_used = ?, assessed_at = datetime('now') WHERE id = ?"
    ).run(...payload, existing.id);
  } else {
    db.prepare(
      'INSERT INTO change_risk_assessments (id, workspace_id, ticket_id, score, band, contributions, advisory, ai_used) VALUES (?,?,?,?,?,?,?,?)'
    ).run(uid('cra'), workspaceId, ticketId, ...payload);
  }
  // The legacy `risk` column is kept in step with the computed band rather
  // than being a second, hand-set value competing with it. Two risk fields
  // on one change is confusing for an agent and ambiguous for SLA matching,
  // which reads `risk` -- so the assessment is the single source of truth
  // and `risk` simply mirrors it. 'critical' has no legacy equivalent (that
  // vocabulary is low/medium/high), so it maps to 'high'.
  const legacyRisk = assessment.band === 'critical' ? 'high' : assessment.band;
  db.prepare("UPDATE tickets SET risk_score = ?, risk_band = ?, risk = ?, updated_at = datetime('now') WHERE id = ?")
    .run(assessment.score, assessment.band, legacyRisk, ticketId);
  return getAssessment(ticketId);
}

export function getAssessment(ticketId) {
  const row = db.prepare('SELECT * FROM change_risk_assessments WHERE ticket_id = ?').get(ticketId);
  if (!row) return null;
  const parse = (v, fb) => { try { return v ? JSON.parse(v) : fb; } catch { return fb; } };
  return {
    ...row,
    contributions: parse(row.contributions, []),
    advisory: parse(row.advisory, []),
    ai_used: !!row.ai_used,
  };
}
