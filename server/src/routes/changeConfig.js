// Admin configuration for the change module: types, standard templates,
// risk rules and bands, freeze windows and approval routes.
//
// The flow diagram's developer notes ask for "an admin UI for managing
// templates, rules, approvers, SLA" and "configurable rules (no
// hardcoding)". This is the API behind that.
import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { listChangeTypes, CHANGE_TYPE_KEYS, APPROVAL_MODES } from '../services/changeTypes.js';
import { listRiskRules, listRiskBands, SIGNALS, OPERATORS, BANDS, resolveSignals } from '../services/changeRisk.js';
import { listTemplates } from '../services/changeTemplates.js';
import { listFreezeWindows } from '../services/changeCalendar.js';
import { listRoutes, APPROVER_TYPES } from '../services/changeApproval.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

// Everything here is admin configuration, so the whole router is gated.
router.use(requirePermission('change.manage'));

router.get('/', (req, res) => {
  res.json({
    change_types: listChangeTypes(req.workspaceId, { includeDisabled: true }),
    templates: listTemplates(req.workspaceId, { includeDisabled: true }),
    risk_rules: listRiskRules(req.workspaceId, { includeDisabled: true }),
    risk_bands: listRiskBands(req.workspaceId),
    freeze_windows: listFreezeWindows(req.workspaceId, { includeDisabled: true }),
    approval_routes: listRoutes(req.workspaceId, { includeDisabled: true }),
    meta: {
      change_type_keys: CHANGE_TYPE_KEYS,
      approval_modes: APPROVAL_MODES,
      signals: SIGNALS,
      operators: OPERATORS,
      bands: BANDS,
      approver_types: APPROVER_TYPES,
    },
  });
});

// ---- change types --------------------------------------------------------
// The four keys are fixed (the approval lanes are wired to them), but every
// policy attached to a type is editable.
router.patch('/types/:id', (req, res) => {
  const type = db.prepare('SELECT * FROM change_types WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!type) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  if (b.approval_mode !== undefined && !APPROVAL_MODES.includes(b.approval_mode)) {
    return res.status(400).json({ error: 'Invalid approval mode' });
  }
  const jsonArray = (v, fallback) => {
    if (v === undefined) return fallback;
    if (Array.isArray(v)) return JSON.stringify(v);
    return fallback;
  };
  const num = (v, fallback) => (v === undefined ? fallback : (v === null ? null : Number(v)));
  const bool = (v, fallback) => (v === undefined ? fallback : (v ? 1 : 0));

  db.prepare(
    `UPDATE change_types SET label = ?, description = ?, approval_mode = ?, approval_sla_hours = ?,
       requires_backout = ?, requires_test_plan = ?, requires_implementation_plan = ?,
       pir_required_bands = ?, mandatory_fields = ?, allow_freeze_override = ?, lead_time_hours = ?, enabled = ?
     WHERE id = ?`
  ).run(
    b.label !== undefined ? String(b.label).trim() || type.label : type.label,
    b.description !== undefined ? b.description : type.description,
    b.approval_mode !== undefined ? b.approval_mode : type.approval_mode,
    num(b.approval_sla_hours, type.approval_sla_hours),
    bool(b.requires_backout, type.requires_backout),
    bool(b.requires_test_plan, type.requires_test_plan),
    bool(b.requires_implementation_plan, type.requires_implementation_plan),
    jsonArray(b.pir_required_bands, type.pir_required_bands),
    jsonArray(b.mandatory_fields, type.mandatory_fields),
    bool(b.allow_freeze_override, type.allow_freeze_override),
    num(b.lead_time_hours, type.lead_time_hours),
    bool(b.enabled, type.enabled),
    type.id
  );
  logAudit(req, { action: 'change_type.update', entityType: 'change_type', entityId: type.id, entityLabel: type.key });
  res.json({ change_types: listChangeTypes(req.workspaceId, { includeDisabled: true }) });
});

// ---- standard templates --------------------------------------------------
const TEMPLATE_FIELDS = ['name', 'description', 'match_category', 'match_subcategory', 'match_asset_type',
  'match_title_contains', 'implementation_plan', 'backout_plan', 'test_plan', 'default_risk_band', 'max_duration_minutes'];

router.post('/templates', (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const id = uid('sct');
  const values = TEMPLATE_FIELDS.map((f) => (f === 'name' ? name : (req.body?.[f] ?? null)));
  db.prepare(
    `INSERT INTO standard_change_templates (id, workspace_id, ${TEMPLATE_FIELDS.join(', ')})
     VALUES (?,?,${TEMPLATE_FIELDS.map(() => '?').join(',')})`
  ).run(id, req.workspaceId, ...values);
  logAudit(req, { action: 'change_template.create', entityType: 'change_template', entityId: id, entityLabel: name });
  res.status(201).json({ templates: listTemplates(req.workspaceId, { includeDisabled: true }) });
});

router.patch('/templates/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM standard_change_templates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const sets = [];
  const params = [];
  for (const f of TEMPLATE_FIELDS) {
    if (req.body?.[f] !== undefined) { sets.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (req.body?.auto_approve !== undefined) { sets.push('auto_approve = ?'); params.push(req.body.auto_approve ? 1 : 0); }
  if (req.body?.enabled !== undefined) { sets.push('enabled = ?'); params.push(req.body.enabled ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });

  db.prepare(`UPDATE standard_change_templates SET ${sets.join(', ')} WHERE id = ?`).run(...params, existing.id);
  logAudit(req, { action: 'change_template.update', entityType: 'change_template', entityId: existing.id, entityLabel: existing.name });
  res.json({ templates: listTemplates(req.workspaceId, { includeDisabled: true }) });
});

router.delete('/templates/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM standard_change_templates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  // A template a change already used is history -- disable rather than
  // delete so that change's record still resolves its template name.
  const inUse = db.prepare('SELECT COUNT(*) c FROM tickets WHERE standard_template_id = ?').get(existing.id).c;
  if (inUse > 0) {
    db.prepare('UPDATE standard_change_templates SET enabled = 0 WHERE id = ?').run(existing.id);
    return res.json({ deactivated: true, changes: inUse, templates: listTemplates(req.workspaceId, { includeDisabled: true }) });
  }
  db.prepare('DELETE FROM standard_change_templates WHERE id = ?').run(existing.id);
  res.json({ deactivated: false, templates: listTemplates(req.workspaceId, { includeDisabled: true }) });
});

// ---- risk rules and bands ------------------------------------------------
router.post('/risk-rules', (req, res) => {
  const { name, signal, operator, value, points } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Name is required' });
  if (!SIGNALS.some((s) => s.key === signal)) return res.status(400).json({ error: `Unknown signal "${signal}"` });
  if (!OPERATORS.includes(operator)) return res.status(400).json({ error: `Unknown operator "${operator}"` });

  const nextOrder = (db.prepare('SELECT MAX(sort_order) m FROM change_risk_rules WHERE workspace_id = ?').get(req.workspaceId).m ?? -1) + 1;
  const id = uid('crr');
  db.prepare(
    'INSERT INTO change_risk_rules (id, workspace_id, name, signal, operator, value, points, sort_order) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, req.workspaceId, String(name).trim(), signal, operator, value ?? null, Number(points) || 0, nextOrder);
  logAudit(req, { action: 'change_risk_rule.create', entityType: 'change_risk_rule', entityId: id, entityLabel: name });
  res.status(201).json({ risk_rules: listRiskRules(req.workspaceId, { includeDisabled: true }) });
});

router.patch('/risk-rules/:id', (req, res) => {
  const rule = db.prepare('SELECT * FROM change_risk_rules WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.signal !== undefined && !SIGNALS.some((s) => s.key === b.signal)) return res.status(400).json({ error: 'Unknown signal' });
  if (b.operator !== undefined && !OPERATORS.includes(b.operator)) return res.status(400).json({ error: 'Unknown operator' });

  db.prepare(
    'UPDATE change_risk_rules SET name = ?, signal = ?, operator = ?, value = ?, points = ?, enabled = ? WHERE id = ?'
  ).run(
    b.name !== undefined ? String(b.name).trim() || rule.name : rule.name,
    b.signal ?? rule.signal,
    b.operator ?? rule.operator,
    b.value !== undefined ? b.value : rule.value,
    b.points !== undefined ? Number(b.points) || 0 : rule.points,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : rule.enabled,
    rule.id
  );
  res.json({ risk_rules: listRiskRules(req.workspaceId, { includeDisabled: true }) });
});

router.delete('/risk-rules/:id', (req, res) => {
  const rule = db.prepare('SELECT id FROM change_risk_rules WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!rule) return res.status(404).json({ error: 'Not found' });
  // An empty rule set is legitimate (everything scores zero) -- see the
  // seeding note in changeRisk.js, which keys off bands, not rules.
  db.prepare('DELETE FROM change_risk_rules WHERE id = ?').run(rule.id);
  res.json({ risk_rules: listRiskRules(req.workspaceId, { includeDisabled: true }) });
});

router.patch('/risk-bands/:id', (req, res) => {
  const band = db.prepare('SELECT * FROM change_risk_bands WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!band) return res.status(404).json({ error: 'Not found' });
  const min = req.body?.min_score;
  if (min === undefined || Number.isNaN(Number(min))) return res.status(400).json({ error: 'min_score is required' });
  db.prepare('UPDATE change_risk_bands SET min_score = ?, color = COALESCE(?, color) WHERE id = ?')
    .run(Math.max(0, Number(min)), req.body?.color ?? null, band.id);
  res.json({ risk_bands: listRiskBands(req.workspaceId) });
});

// Lets an admin see the live signal values for a real change while tuning
// the rules -- a rule set whose inputs you cannot inspect is guesswork.
router.get('/risk-preview/:ticketId', (req, res) => {
  const ticket = db.prepare("SELECT * FROM tickets WHERE id = ? AND workspace_id = ? AND type = 'change'").get(req.params.ticketId, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  res.json({ signals: resolveSignals(req.workspaceId, ticket), rules: listRiskRules(req.workspaceId) });
});

// ---- freeze windows ------------------------------------------------------
router.post('/freeze-windows', (req, res) => {
  const { name, start_at, end_at, scope = 'all', scope_value = null, reason = null, allow_emergency = 1 } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Name is required' });
  const start = new Date(start_at);
  const end = new Date(end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return res.status(400).json({ error: 'Valid start and end dates are required' });
  if (end <= start) return res.status(400).json({ error: 'The freeze must end after it starts' });
  if (!['all', 'category', 'asset'].includes(scope)) return res.status(400).json({ error: 'Invalid scope' });
  if (scope !== 'all' && !scope_value) return res.status(400).json({ error: `A ${scope}-scoped freeze needs a target` });

  const id = uid('cfw');
  db.prepare(
    'INSERT INTO change_freeze_windows (id, workspace_id, name, reason, start_at, end_at, scope, scope_value, allow_emergency, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(id, req.workspaceId, String(name).trim(), reason, start.toISOString(), end.toISOString(), scope, scope_value, allow_emergency ? 1 : 0, req.user.id);
  logAudit(req, { action: 'change_freeze.create', entityType: 'change_freeze_window', entityId: id, entityLabel: name });
  res.status(201).json({ freeze_windows: listFreezeWindows(req.workspaceId, { includeDisabled: true }) });
});

router.patch('/freeze-windows/:id', (req, res) => {
  const w = db.prepare('SELECT * FROM change_freeze_windows WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!w) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  db.prepare(
    'UPDATE change_freeze_windows SET name = ?, reason = ?, start_at = ?, end_at = ?, allow_emergency = ?, enabled = ? WHERE id = ?'
  ).run(
    b.name !== undefined ? String(b.name).trim() || w.name : w.name,
    b.reason !== undefined ? b.reason : w.reason,
    b.start_at !== undefined ? new Date(b.start_at).toISOString() : w.start_at,
    b.end_at !== undefined ? new Date(b.end_at).toISOString() : w.end_at,
    b.allow_emergency !== undefined ? (b.allow_emergency ? 1 : 0) : w.allow_emergency,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : w.enabled,
    w.id
  );
  logAudit(req, { action: 'change_freeze.update', entityType: 'change_freeze_window', entityId: w.id, entityLabel: w.name });
  res.json({ freeze_windows: listFreezeWindows(req.workspaceId, { includeDisabled: true }) });
});

router.delete('/freeze-windows/:id', (req, res) => {
  const w = db.prepare('SELECT id FROM change_freeze_windows WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!w) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM change_freeze_windows WHERE id = ?').run(w.id);
  res.json({ freeze_windows: listFreezeWindows(req.workspaceId, { includeDisabled: true }) });
});

// ---- approval routes -----------------------------------------------------
router.post('/routes', (req, res) => {
  const { name, match_change_type = null, match_risk_band = null, steps } = req.body || {};
  if (!String(name || '').trim()) return res.status(400).json({ error: 'Name is required' });
  if (match_change_type && !CHANGE_TYPE_KEYS.includes(match_change_type)) return res.status(400).json({ error: 'Unknown change type' });
  if (match_risk_band && !BANDS.includes(match_risk_band)) return res.status(400).json({ error: 'Unknown risk band' });
  if (!Array.isArray(steps) || !steps.length) return res.status(400).json({ error: 'At least one approval step is required' });
  for (const s of steps) {
    if (!APPROVER_TYPES.includes(s.approver_type)) return res.status(400).json({ error: `Unknown approver type "${s.approver_type}"` });
    if (['group', 'role', 'user'].includes(s.approver_type) && !s.approver_id) {
      return res.status(400).json({ error: `A ${s.approver_type} step needs a target` });
    }
  }

  const routeId = uid('car');
  db.prepare('INSERT INTO change_approval_routes (id, workspace_id, name, match_change_type, match_risk_band) VALUES (?,?,?,?,?)')
    .run(routeId, req.workspaceId, String(name).trim(), match_change_type, match_risk_band);
  steps.forEach((s, i) => {
    db.prepare(
      'INSERT INTO change_approval_route_steps (id, route_id, step_order, approver_type, approver_id, sla_hours, quorum) VALUES (?,?,?,?,?,?,?)'
    ).run(uid('cars'), routeId, i + 1, s.approver_type, s.approver_id || null,
      s.sla_hours === undefined || s.sla_hours === null ? null : Number(s.sla_hours),
      Math.max(1, Number(s.quorum) || 1));
  });
  logAudit(req, { action: 'change_route.create', entityType: 'change_approval_route', entityId: routeId, entityLabel: name });
  res.status(201).json({ approval_routes: listRoutes(req.workspaceId, { includeDisabled: true }) });
});

// Steps are replaced wholesale, for the same ordering reason as on-call
// escalation steps: order is meaning, and a partial edit would leave a
// half-valid route in between.
router.put('/routes/:id', (req, res) => {
  const route = db.prepare('SELECT * FROM change_approval_routes WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!route) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  if (b.match_change_type && !CHANGE_TYPE_KEYS.includes(b.match_change_type)) return res.status(400).json({ error: 'Unknown change type' });
  if (b.match_risk_band && !BANDS.includes(b.match_risk_band)) return res.status(400).json({ error: 'Unknown risk band' });

  db.prepare('UPDATE change_approval_routes SET name = ?, match_change_type = ?, match_risk_band = ?, enabled = ? WHERE id = ?').run(
    b.name !== undefined ? String(b.name).trim() || route.name : route.name,
    b.match_change_type !== undefined ? (b.match_change_type || null) : route.match_change_type,
    b.match_risk_band !== undefined ? (b.match_risk_band || null) : route.match_risk_band,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : route.enabled,
    route.id
  );

  if (Array.isArray(b.steps)) {
    if (!b.steps.length) return res.status(400).json({ error: 'A route needs at least one step' });
    for (const s of b.steps) {
      if (!APPROVER_TYPES.includes(s.approver_type)) return res.status(400).json({ error: `Unknown approver type "${s.approver_type}"` });
    }
    db.prepare('DELETE FROM change_approval_route_steps WHERE route_id = ?').run(route.id);
    b.steps.forEach((s, i) => {
      db.prepare(
        'INSERT INTO change_approval_route_steps (id, route_id, step_order, approver_type, approver_id, sla_hours, quorum) VALUES (?,?,?,?,?,?,?)'
      ).run(uid('cars'), route.id, i + 1, s.approver_type, s.approver_id || null,
        s.sla_hours === undefined || s.sla_hours === null ? null : Number(s.sla_hours),
        Math.max(1, Number(s.quorum) || 1));
    });
  }
  logAudit(req, { action: 'change_route.update', entityType: 'change_approval_route', entityId: route.id, entityLabel: route.name });
  res.json({ approval_routes: listRoutes(req.workspaceId, { includeDisabled: true }) });
});

router.delete('/routes/:id', (req, res) => {
  const route = db.prepare('SELECT id FROM change_approval_routes WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!route) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM change_approval_routes WHERE id = ?').run(route.id);
  res.json({ approval_routes: listRoutes(req.workspaceId, { includeDisabled: true }) });
});

export default router;
