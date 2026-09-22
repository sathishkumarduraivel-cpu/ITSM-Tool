// Alert ingestion: turn a monitoring tool's payload into a normalized alert,
// deduplicating repeats so a flapping check produces one alert with a rising
// occurrence count rather than four hundred incidents overnight.
//
// Deliberately vendor-agnostic. Rather than a module per monitoring tool,
// each alert_source carries a `field_map` of our canonical field names to
// dotted paths in that vendor's own payload shape, so absorbing a new tool
// is a configuration change, not a code change. The presets below are
// convenience defaults for the common tools -- an admin can override any of
// them, and 'generic' plus an explicit map handles anything else.
import { createHash } from 'node:crypto';
import { db, uid } from '../db.js';

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

// Canonical field -> dotted path in the vendor's payload.
export const SOURCE_PRESETS = {
  generic: { title: 'title', description: 'description', severity: 'severity', entity: 'entity', dedupe_key: 'dedupe_key', status: 'status' },
  datadog: { title: 'title', description: 'body', severity: 'alert_type', entity: 'host', dedupe_key: 'aggreg_key', status: 'alert_transition' },
  prometheus: { title: 'labels.alertname', description: 'annotations.description', severity: 'labels.severity', entity: 'labels.instance', dedupe_key: 'fingerprint', status: 'status' },
  grafana: { title: 'title', description: 'message', severity: 'state', entity: 'ruleName', dedupe_key: 'ruleId', status: 'state' },
  nagios: { title: 'servicedesc', description: 'output', severity: 'servicestate', entity: 'hostname', dedupe_key: null, status: 'servicestate' },
  zabbix: { title: 'name', description: 'message', severity: 'severity', entity: 'host', dedupe_key: 'eventid', status: 'status' },
};

// Vendor severity vocabularies mapped onto ours. Anything unrecognized falls
// through to the source's default_severity rather than being guessed at.
const SEVERITY_ALIASES = {
  critical: 'critical', crit: 'critical', fatal: 'critical', disaster: 'critical', error: 'high',
  high: 'high', major: 'high', warning: 'medium', warn: 'medium', average: 'medium',
  medium: 'medium', minor: 'low', low: 'low', information: 'info', informational: 'info',
  info: 'info', ok: 'info', success: 'info', alerting: 'high', normal: 'info',
};

// Vendor "this has recovered" vocabularies. A recovery payload resolves the
// matching open alert instead of opening another one -- without this, every
// self-healing check leaves a permanently open alert behind.
const RESOLVED_TOKENS = new Set(['ok', 'resolved', 'recovery', 'success', 'up', 'normal', 'cleared', 'no data', 'nodata']);

function readPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return '';
}

export function resolveFieldMap(source) {
  const preset = SOURCE_PRESETS[source?.source_type] || SOURCE_PRESETS.generic;
  let custom = {};
  try {
    if (source?.field_map) custom = JSON.parse(source.field_map) || {};
  } catch {
    custom = {}; // a malformed map must fall back to the preset, not break ingestion
  }
  return { ...preset, ...custom };
}

export function normalizeSeverity(raw, fallback = 'medium') {
  const key = String(raw ?? '').trim().toLowerCase();
  if (SEVERITIES.includes(key)) return key;
  if (SEVERITY_ALIASES[key]) return SEVERITY_ALIASES[key];
  return SEVERITIES.includes(fallback) ? fallback : 'medium';
}

export function isResolutionSignal(raw) {
  const key = String(raw ?? '').trim().toLowerCase();
  if (!key) return false;
  return RESOLVED_TOKENS.has(key);
}

// The dedupe key decides what counts as "the same alert happening again".
// An explicit key from the payload is always preferred -- monitoring tools
// know better than we do which of their notifications refer to one incident.
// Failing that we hash source + entity + title, which groups repeats of the
// same check on the same host while keeping two different hosts distinct.
export function computeDedupeKey(source, payload, map, normalized) {
  const explicit = firstString(readPath(payload, map.dedupe_key));
  if (explicit) return `k:${explicit}`;
  const basis = `${source.id}|${normalized.entity || ''}|${normalized.title || ''}`;
  return `h:${createHash('sha256').update(basis).digest('hex').slice(0, 32)}`;
}

export function normalizePayload(source, payload) {
  const map = resolveFieldMap(source);
  const title = firstString(
    readPath(payload, map.title),
    payload?.title, payload?.name, payload?.summary, payload?.alertname
  ) || 'Untitled alert';
  const normalized = {
    title: title.slice(0, 300),
    description: firstString(readPath(payload, map.description), payload?.description, payload?.message).slice(0, 4000),
    entity: firstString(readPath(payload, map.entity), payload?.host, payload?.instance).slice(0, 200) || null,
    severity: normalizeSeverity(readPath(payload, map.severity), source.default_severity),
    statusToken: firstString(readPath(payload, map.status)),
  };
  normalized.dedupeKey = computeDedupeKey(source, payload, map, normalized);
  return normalized;
}

function logEvent(alertId, event, detail, actorId = null) {
  db.prepare('INSERT INTO alert_events (id, alert_id, event, detail, actor_id) VALUES (?,?,?,?,?)').run(
    uid('ale'), alertId, event, detail || null, actorId
  );
}

// Per-source flood cap. Protects against a misconfigured monitor hammering
// the endpoint -- counted over the last 60 seconds of received alerts for
// this source, including deduped ones, since the cost being guarded against
// is the write traffic itself.
//
// The window is compared entirely in SQL. Every timestamp in these tables is
// written by SQLite's datetime('now') ("YYYY-MM-DD HH:MM:SS"), which does NOT
// string-compare correctly against a JavaScript ISO string -- the space
// separator sorts below 'T', so `col >= isoString` is false for every row.
// Wrapping both sides in datetime() normalizes the two formats instead of
// silently matching nothing.
function isFlooding(source) {
  const cap = Number(source.max_per_minute) || 0;
  if (cap <= 0) return false;
  const row = db.prepare(
    `SELECT COUNT(*) c FROM alert_events ae JOIN alerts a ON a.id = ae.alert_id
     WHERE a.source_id = ? AND datetime(ae.created_at) >= datetime('now', '-60 seconds')
       AND ae.event IN ('received','deduped')`
  ).get(source.id);
  return row.c >= cap;
}

// The main entry point for both the webhook receiver and internal monitors.
// Returns a description of what happened rather than throwing, because the
// caller is usually an HTTP handler that should answer 200 with detail --
// a monitoring tool retrying forever because we returned 500 for a payload
// we simply chose to suppress is its own kind of outage.
export function ingestAlert(source, payload, { monitorId = null } = {}) {
  if (!source?.enabled) return { accepted: false, reason: 'Source is disabled' };

  const normalized = normalizePayload(source, payload);

  db.prepare("UPDATE alert_sources SET last_received_at = datetime('now') WHERE id = ?").run(source.id);

  // An existing OPEN or ACKNOWLEDGED alert with the same key inside the
  // window is the same ongoing problem. A resolved one is deliberately not
  // matched -- if the problem comes back after being resolved, that is a new
  // alert, not a resurrection of the old one, and the history should show
  // both.
  // Window compared in SQL for the format reason explained on isFlooding
  // above. A zero window is short-circuited rather than passed through as
  // '-0 minutes': SQLite's datetime has one-second resolution, so a row
  // written in the current second compares equal to datetime('now') and
  // would dedupe against itself -- the exact opposite of what a zero window
  // is configured to mean.
  const windowMinutes = Math.max(0, Number(source.dedupe_window_minutes) || 0);
  const existing = windowMinutes === 0 ? null : db.prepare(
    `SELECT * FROM alerts
     WHERE workspace_id = ? AND dedupe_key = ? AND status IN ('open','acknowledged','suppressed')
       AND datetime(last_seen_at) >= datetime('now', ?)
     ORDER BY datetime(last_seen_at) DESC LIMIT 1`
  ).get(source.workspace_id, normalized.dedupeKey, `-${windowMinutes} minutes`);

  // A recovery notification closes the open alert rather than opening one.
  if (isResolutionSignal(normalized.statusToken)) {
    if (!existing) return { accepted: true, action: 'ignored_recovery', reason: 'Recovery for an alert we have no open record of' };
    db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = datetime('now'), last_seen_at = datetime('now') WHERE id = ?").run(existing.id);
    logEvent(existing.id, 'resolved', 'Source reported recovery');
    return { accepted: true, action: 'resolved', alertId: existing.id };
  }

  if (existing) {
    db.prepare(
      "UPDATE alerts SET occurrence_count = occurrence_count + 1, last_seen_at = datetime('now'), severity = ? WHERE id = ?"
    ).run(normalized.severity, existing.id);
    logEvent(existing.id, 'deduped', `Repeat occurrence #${existing.occurrence_count + 1} within the ${windowMinutes}m dedupe window`);
    return {
      accepted: true, action: 'deduped', alertId: existing.id,
      occurrenceCount: existing.occurrence_count + 1,
    };
  }

  if (isFlooding(source)) {
    return { accepted: true, action: 'rate_limited', reason: `Source exceeded ${source.max_per_minute} alerts/minute` };
  }

  const id = uid('alr');
  // first/last_seen_at written by SQLite, not a JS ISO string, so they stay
  // in the same format as every later datetime('now') update to them.
  db.prepare(
    `INSERT INTO alerts (id, workspace_id, source_id, dedupe_key, title, description, severity, status, entity, monitor_id, raw_payload, first_seen_at, last_seen_at)
     VALUES (?,?,?,?,?,?,?,'open',?,?,?,datetime('now'),datetime('now'))`
  ).run(
    id, source.workspace_id, source.id, normalized.dedupeKey,
    normalized.title, normalized.description || null, normalized.severity,
    normalized.entity, monitorId,
    JSON.stringify(payload ?? null).slice(0, 20000)
  );
  logEvent(id, 'received', `New alert from ${source.name} (severity ${normalized.severity})`);

  return { accepted: true, action: 'created', alertId: id, severity: normalized.severity };
}

export function getAlert(alertId, workspaceId) {
  return db.prepare('SELECT * FROM alerts WHERE id = ? AND workspace_id = ?').get(alertId, workspaceId);
}

export function acknowledgeAlert(alertId, workspaceId, userId) {
  const alert = getAlert(alertId, workspaceId);
  if (!alert) return null;
  if (alert.status === 'resolved') return alert;
  db.prepare("UPDATE alerts SET status = 'acknowledged', acknowledged_at = datetime('now'), acknowledged_by = ? WHERE id = ?").run(userId, alertId);
  logEvent(alertId, 'acknowledged', 'Acknowledged by an operator', userId);
  return getAlert(alertId, workspaceId);
}

export function resolveAlert(alertId, workspaceId, userId) {
  const alert = getAlert(alertId, workspaceId);
  if (!alert) return null;
  db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(alertId);
  logEvent(alertId, 'resolved', 'Resolved by an operator', userId);
  return getAlert(alertId, workspaceId);
}

export function suppressAlert(alertId, workspaceId, userId) {
  const alert = getAlert(alertId, workspaceId);
  if (!alert) return null;
  db.prepare("UPDATE alerts SET status = 'suppressed' WHERE id = ?").run(alertId);
  logEvent(alertId, 'suppressed', 'Suppressed by an operator', userId);
  return getAlert(alertId, workspaceId);
}

export function alertEvents(alertId) {
  return db.prepare('SELECT * FROM alert_events WHERE alert_id = ? ORDER BY created_at DESC, id DESC').all(alertId);
}

export { logEvent as logAlertEvent };
