import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import {
  SEVERITIES, SOURCE_PRESETS, ingestAlert,
  acknowledgeAlert, resolveAlert, suppressAlert, alertEvents, getAlert,
} from '../services/alertIngest.js';
import { applyAlertRules } from '../services/alertRules.js';
import { MONITOR_TYPES, isMonitorType, evaluateMonitor, evaluateWorkspaceMonitors } from '../services/internalMonitors.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

const STATUSES = ['open', 'acknowledged', 'resolved', 'suppressed'];

// Metadata for the admin UI: the vendor presets and monitor catalog, so the
// frontend never hardcodes a copy of either.
router.get('/meta', (req, res) => {
  res.json({
    severities: SEVERITIES,
    source_types: Object.keys(SOURCE_PRESETS),
    presets: SOURCE_PRESETS,
    monitor_types: MONITOR_TYPES,
  });
});

// ---- the alert console ---------------------------------------------------
// Readable by any signed-in member: an on-call engineer needs to see and
// acknowledge alerts without holding an admin permission. Configuration
// (sources, rules, monitors) is gated on alerts.manage further down.
router.get('/', (req, res) => {
  const { status, severity, source_id } = req.query;
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));

  const clauses = ['a.workspace_id = ?'];
  const params = [req.workspaceId];
  if (status && STATUSES.includes(status)) { clauses.push('a.status = ?'); params.push(status); }
  if (severity && SEVERITIES.includes(severity)) { clauses.push('a.severity = ?'); params.push(severity); }
  if (source_id) { clauses.push('a.source_id = ?'); params.push(source_id); }

  const rows = db.prepare(
    `SELECT a.*, s.name AS source_name, t.number AS ticket_number, u.name AS acknowledged_by_name
     FROM alerts a
     LEFT JOIN alert_sources s ON s.id = a.source_id
     LEFT JOIN tickets t ON t.id = a.ticket_id
     LEFT JOIN users u ON u.id = a.acknowledged_by
     WHERE ${clauses.join(' AND ')}
     ORDER BY
       CASE a.status WHEN 'open' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END,
       CASE a.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
       datetime(a.last_seen_at) DESC
     LIMIT ?`
  ).all(...params, limit);

  const counts = db.prepare(
    `SELECT status, COUNT(*) c FROM alerts WHERE workspace_id = ? GROUP BY status`
  ).all(req.workspaceId).reduce((acc, r) => ({ ...acc, [r.status]: r.c }), {});

  res.json({ alerts: rows, counts });
});

router.get('/:id/events', (req, res) => {
  const alert = getAlert(req.params.id, req.workspaceId);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  res.json({ alert, events: alertEvents(alert.id) });
});

router.post('/:id/acknowledge', (req, res) => {
  const alert = acknowledgeAlert(req.params.id, req.workspaceId, req.user.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  res.json({ alert });
});

router.post('/:id/resolve', (req, res) => {
  const alert = resolveAlert(req.params.id, req.workspaceId, req.user.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  res.json({ alert });
});

router.post('/:id/suppress', (req, res) => {
  const alert = suppressAlert(req.params.id, req.workspaceId, req.user.id);
  if (!alert) return res.status(404).json({ error: 'Not found' });
  res.json({ alert });
});

router.use(requirePermission('alerts.manage'));

// ---- sources ------------------------------------------------------------
// webhook_secret is never returned in a list. It is shown exactly once, at
// creation or rotation, the same show-once discipline as api_keys -- a
// secret that any admin page can re-read is a secret sitting in every
// browser cache and screen share.
function publicSource(row) {
  const { webhook_secret, ...rest } = row;
  return { ...rest, has_secret: !!webhook_secret };
}

router.get('/sources', (req, res) => {
  const rows = db.prepare('SELECT * FROM alert_sources WHERE workspace_id = ? ORDER BY created_at ASC').all(req.workspaceId);
  const withCounts = rows.map((r) => {
    const open = db.prepare("SELECT COUNT(*) c FROM alerts WHERE source_id = ? AND status = 'open'").get(r.id).c;
    return { ...publicSource(r), open_alerts: open };
  });
  res.json({ sources: withCounts });
});

router.post('/sources', (req, res) => {
  const {
    name, source_type = 'generic', default_severity = 'medium',
    dedupe_window_minutes = 60, max_per_minute = 60, field_map = null,
  } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!SOURCE_PRESETS[source_type]) return res.status(400).json({ error: 'Unknown source type' });
  if (!SEVERITIES.includes(default_severity)) return res.status(400).json({ error: 'Invalid default severity' });
  if (field_map) {
    try {
      JSON.parse(typeof field_map === 'string' ? field_map : JSON.stringify(field_map));
    } catch {
      return res.status(400).json({ error: 'Field map must be valid JSON' });
    }
  }

  const id = uid('alsrc');
  const secret = randomBytes(24).toString('base64url');
  db.prepare(
    `INSERT INTO alert_sources (id, workspace_id, name, source_type, webhook_secret, field_map, default_severity, dedupe_window_minutes, max_per_minute)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id, req.workspaceId, String(name).trim(), source_type, secret,
    field_map ? (typeof field_map === 'string' ? field_map : JSON.stringify(field_map)) : null,
    default_severity,
    Math.min(1440, Math.max(0, Number(dedupe_window_minutes) || 0)),
    Math.min(10000, Math.max(0, Number(max_per_minute) || 0))
  );
  logAudit(req, { action: 'alert_source.create', entityType: 'alert_source', entityId: id, entityLabel: name });
  // The only response that ever carries the secret.
  res.status(201).json({
    source: publicSource(db.prepare('SELECT * FROM alert_sources WHERE id = ?').get(id)),
    webhook_secret: secret,
    webhook_path: `/api/webhooks/alerts/${id}`,
  });
});

router.patch('/sources/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM alert_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });

  const { name, default_severity, dedupe_window_minutes, max_per_minute, field_map, enabled } = req.body || {};
  if (default_severity !== undefined && !SEVERITIES.includes(default_severity)) return res.status(400).json({ error: 'Invalid default severity' });
  if (field_map) {
    try {
      JSON.parse(typeof field_map === 'string' ? field_map : JSON.stringify(field_map));
    } catch {
      return res.status(400).json({ error: 'Field map must be valid JSON' });
    }
  }

  db.prepare(
    `UPDATE alert_sources SET name = ?, default_severity = ?, dedupe_window_minutes = ?, max_per_minute = ?, field_map = ?, enabled = ? WHERE id = ?`
  ).run(
    name !== undefined ? String(name).trim() || existing.name : existing.name,
    default_severity !== undefined ? default_severity : existing.default_severity,
    dedupe_window_minutes !== undefined ? Math.min(1440, Math.max(0, Number(dedupe_window_minutes) || 0)) : existing.dedupe_window_minutes,
    max_per_minute !== undefined ? Math.min(10000, Math.max(0, Number(max_per_minute) || 0)) : existing.max_per_minute,
    field_map !== undefined ? (field_map ? (typeof field_map === 'string' ? field_map : JSON.stringify(field_map)) : null) : existing.field_map,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    existing.id
  );
  logAudit(req, { action: 'alert_source.update', entityType: 'alert_source', entityId: existing.id, entityLabel: name || existing.name });
  res.json({ source: publicSource(db.prepare('SELECT * FROM alert_sources WHERE id = ?').get(existing.id)) });
});

router.post('/sources/:id/rotate-secret', (req, res) => {
  const existing = db.prepare('SELECT * FROM alert_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const secret = randomBytes(24).toString('base64url');
  db.prepare('UPDATE alert_sources SET webhook_secret = ? WHERE id = ?').run(secret, existing.id);
  logAudit(req, { action: 'alert_source.rotate_secret', entityType: 'alert_source', entityId: existing.id, entityLabel: existing.name });
  res.json({ webhook_secret: secret, webhook_path: `/api/webhooks/alerts/${existing.id}` });
});

router.delete('/sources/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM alert_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM alert_sources WHERE id = ?').run(existing.id);
  logAudit(req, { action: 'alert_source.delete', entityType: 'alert_source', entityId: existing.id, entityLabel: existing.name });
  res.json({ ok: true });
});

// Fires a real alert through the real pipeline so an admin can prove a
// source's field map and rules work before pointing a monitoring tool at it.
router.post('/sources/:id/test', async (req, res) => {
  const source = db.prepare('SELECT * FROM alert_sources WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!source) return res.status(404).json({ error: 'Not found' });

  const payload = req.body?.payload || {
    title: 'Test alert from ITSM AI', description: 'Generated by the Alert Management test button.',
    entity: 'itsm-ai/self-test', severity: source.default_severity,
    dedupe_key: `selftest-${Date.now()}`,
  };
  const result = ingestAlert(source, payload);
  let ruleOutcome = null;
  if (result.alertId) ruleOutcome = await applyAlertRules(req.workspaceId, result.alertId);
  res.json({ result, rules: ruleOutcome });
});

// ---- rules --------------------------------------------------------------
router.get('/rules', (req, res) => {
  const rows = db.prepare('SELECT * FROM alert_rules WHERE workspace_id = ? ORDER BY rule_order ASC, created_at ASC').all(req.workspaceId);
  res.json({ rules: rows });
});

function readRuleBody(body, existing) {
  const pick = (k, f) => (body[k] !== undefined ? body[k] : f);
  const bool = (v) => (v ? 1 : 0);
  const severity = pick('match_severity', existing?.match_severity) || null;
  if (severity && !SEVERITIES.includes(severity)) return { error: 'Invalid match severity' };
  const priority = pick('action_incident_priority', existing?.action_incident_priority) || null;
  if (priority && !['low', 'medium', 'high', 'critical'].includes(priority)) return { error: 'Invalid incident priority' };

  return {
    values: {
      name: String(pick('name', existing?.name) || '').trim(),
      enabled: bool(pick('enabled', existing?.enabled ?? 1)),
      rule_order: Math.max(1, Number(pick('rule_order', existing?.rule_order ?? 1)) || 1),
      match_severity: severity,
      match_source_id: pick('match_source_id', existing?.match_source_id) || null,
      match_title_contains: pick('match_title_contains', existing?.match_title_contains) || null,
      match_entity_contains: pick('match_entity_contains', existing?.match_entity_contains) || null,
      action_create_incident: bool(pick('action_create_incident', existing?.action_create_incident ?? 1)),
      action_incident_priority: priority,
      action_suppress: bool(pick('action_suppress', existing?.action_suppress ?? 0)),
      action_notify_schedule_id: pick('action_notify_schedule_id', existing?.action_notify_schedule_id) || null,
      action_promote_major: bool(pick('action_promote_major', existing?.action_promote_major ?? 0)),
      action_assignment_policy_id: pick('action_assignment_policy_id', existing?.action_assignment_policy_id) || null,
      stop_processing: bool(pick('stop_processing', existing?.stop_processing ?? 1)),
    },
  };
}

router.post('/rules', (req, res) => {
  const parsed = readRuleBody(req.body || {}, null);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.values;
  if (!v.name) return res.status(400).json({ error: 'Name is required' });

  const id = uid('alrule');
  db.prepare(
    `INSERT INTO alert_rules (id, workspace_id, name, enabled, rule_order, match_severity, match_source_id, match_title_contains, match_entity_contains,
       action_create_incident, action_incident_priority, action_suppress, action_notify_schedule_id, action_promote_major, action_assignment_policy_id, stop_processing)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, v.name, v.enabled, v.rule_order, v.match_severity, v.match_source_id, v.match_title_contains, v.match_entity_contains,
    v.action_create_incident, v.action_incident_priority, v.action_suppress, v.action_notify_schedule_id, v.action_promote_major, v.action_assignment_policy_id, v.stop_processing);
  logAudit(req, { action: 'alert_rule.create', entityType: 'alert_rule', entityId: id, entityLabel: v.name });
  res.status(201).json({ rule: db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) });
});

router.patch('/rules/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM alert_rules WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const parsed = readRuleBody(req.body || {}, existing);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.values;
  if (!v.name) return res.status(400).json({ error: 'Name is required' });

  db.prepare(
    `UPDATE alert_rules SET name = ?, enabled = ?, rule_order = ?, match_severity = ?, match_source_id = ?, match_title_contains = ?, match_entity_contains = ?,
       action_create_incident = ?, action_incident_priority = ?, action_suppress = ?, action_notify_schedule_id = ?, action_promote_major = ?, action_assignment_policy_id = ?, stop_processing = ?
     WHERE id = ?`
  ).run(v.name, v.enabled, v.rule_order, v.match_severity, v.match_source_id, v.match_title_contains, v.match_entity_contains,
    v.action_create_incident, v.action_incident_priority, v.action_suppress, v.action_notify_schedule_id, v.action_promote_major, v.action_assignment_policy_id, v.stop_processing,
    existing.id);
  logAudit(req, { action: 'alert_rule.update', entityType: 'alert_rule', entityId: existing.id, entityLabel: v.name });
  res.json({ rule: db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(existing.id) });
});

router.delete('/rules/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM alert_rules WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM alert_rules WHERE id = ?').run(existing.id);
  logAudit(req, { action: 'alert_rule.delete', entityType: 'alert_rule', entityId: existing.id, entityLabel: existing.name });
  res.json({ ok: true });
});

// ---- internal monitors --------------------------------------------------
router.get('/monitors', (req, res) => {
  const rows = db.prepare('SELECT * FROM internal_alert_monitors WHERE workspace_id = ? ORDER BY created_at ASC').all(req.workspaceId);
  res.json({ monitors: rows, types: MONITOR_TYPES });
});

router.post('/monitors', (req, res) => {
  const { name, monitor_type, threshold, window_minutes = 60, severity = 'high' } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (!isMonitorType(monitor_type)) return res.status(400).json({ error: 'Unknown monitor type' });
  if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Invalid severity' });

  const id = uid('almon');
  db.prepare(
    'INSERT INTO internal_alert_monitors (id, workspace_id, name, monitor_type, threshold, window_minutes, severity) VALUES (?,?,?,?,?,?,?)'
  ).run(
    id, req.workspaceId, String(name).trim(), monitor_type,
    Math.max(0, Number(threshold) || 1),
    Math.min(10080, Math.max(1, Number(window_minutes) || 60)),
    severity
  );
  logAudit(req, { action: 'alert_monitor.create', entityType: 'internal_alert_monitor', entityId: id, entityLabel: name });
  res.status(201).json({ monitor: db.prepare('SELECT * FROM internal_alert_monitors WHERE id = ?').get(id) });
});

router.patch('/monitors/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM internal_alert_monitors WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const { name, threshold, window_minutes, severity, enabled } = req.body || {};
  if (severity !== undefined && !SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Invalid severity' });

  db.prepare(
    'UPDATE internal_alert_monitors SET name = ?, threshold = ?, window_minutes = ?, severity = ?, enabled = ? WHERE id = ?'
  ).run(
    name !== undefined ? String(name).trim() || existing.name : existing.name,
    threshold !== undefined ? Math.max(0, Number(threshold) || 1) : existing.threshold,
    window_minutes !== undefined ? Math.min(10080, Math.max(1, Number(window_minutes) || 60)) : existing.window_minutes,
    severity !== undefined ? severity : existing.severity,
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
    existing.id
  );
  res.json({ monitor: db.prepare('SELECT * FROM internal_alert_monitors WHERE id = ?').get(existing.id) });
});

router.delete('/monitors/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM internal_alert_monitors WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM internal_alert_monitors WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

// Runs the real evaluator now, rather than waiting for the scheduler tick --
// so an admin can see immediately whether a threshold is set sensibly.
router.post('/monitors/:id/run', (req, res) => {
  const existing = db.prepare('SELECT * FROM internal_alert_monitors WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  try {
    res.json({ result: evaluateMonitor(existing) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/monitors/run-all', (req, res) => {
  try {
    res.json({ results: evaluateWorkspaceMonitors(req.workspaceId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
