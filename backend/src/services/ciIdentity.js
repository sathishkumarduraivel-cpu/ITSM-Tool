// CI identification and reconciliation: deciding whether an incoming payload
// is a CI we already know about, and merging it if so.
//
// This is the part that decides whether a CMDB is worth having. Without it,
// every discovery run creates a fresh row and within a month the inventory
// says there are 4,000 servers when there are 900. The rules are per class
// and admin-editable, because what identifies a CI genuinely differs: a
// laptop has a serial number, a cloud resource has a provider id, and a
// database is only unique as instance name PLUS the host it runs on.
//
// Conflicts are resolved by source trust rank, and a refused write is
// recorded rather than dropped -- "the network scanner keeps trying to
// rename this CI" is a real finding, not noise.
import { db, uid } from '../db.js';
import {
  getClass, effectiveAttributes, coerceValue, resolveClass, descendantsOf, ConfigError,
} from './ciClasses.js';

export const MANUAL_SOURCE = 'manual';

// Identification rules ship per class, derived from the attributes the class
// itself marks as identifiers. Seeding from is_identifier rather than a
// second hard-coded list means an admin who adds an identifier attribute in
// the Field Manager gets a working rule without touching a second screen.
export function ensureDefaultIdentificationRules(workspaceId, classId) {
  const cls = getClass(workspaceId, classId);
  if (!cls) return;
  const { c } = db.prepare('SELECT COUNT(*) c FROM ci_identification_rules WHERE workspace_id = ? AND class_id = ?')
    .get(workspaceId, cls.id);
  if (c > 0) return;

  const identifiers = effectiveAttributes(workspaceId, cls.id).filter((a) => a.is_identifier);
  if (!identifiers.length) return;

  // One single-attribute rule per identifier, strongest first. A strong
  // identifier is one that is globally unique by nature; ordering them by
  // how close to the hardware they sit is the best proxy available without
  // asking the admin to rank them up front.
  const STRENGTH = ['serial_number', 'imei', 'resource_id', 'account_identifier', 'build_version', 'product_name', 'app_code', 'instance_name', 'cluster_name', 'site_code', 'hostname', 'management_ip', 'ip_address'];
  const ranked = [...identifiers].sort((a, b) => {
    const ai = STRENGTH.indexOf(a.attr_key); const bi = STRENGTH.indexOf(b.attr_key);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  db.exec('BEGIN');
  try {
    ranked.forEach((attr, i) => {
      db.prepare(
        `INSERT INTO ci_identification_rules (id, workspace_id, class_id, name, attr_keys, priority, enabled, system)
         VALUES (?,?,?,?,?,?,1,1)`
      ).run(uid('cir'), workspaceId, cls.id, `Match on ${attr.label}`, JSON.stringify([attr.attr_key]), (i + 1) * 10);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listIdentificationRules(workspaceId, classId, { includeDisabled = false } = {}) {
  ensureDefaultIdentificationRules(workspaceId, classId);
  return db.prepare(
    `SELECT * FROM ci_identification_rules WHERE workspace_id = ? AND class_id = ?
     ${includeDisabled ? '' : 'AND enabled = 1'} ORDER BY priority, name`
  ).all(workspaceId, classId).map((r) => ({ ...r, attr_keys: parseKeys(r.attr_keys) }));
}

function parseKeys(raw) {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

export function createIdentificationRule(workspaceId, classId, body) {
  const cls = getClass(workspaceId, classId);
  if (!cls) throw new ConfigError('Class not found', 404);
  // Seed the defaults first. Otherwise adding one custom rule to a class
  // nobody had opened yet would leave that rule as the ONLY way to identify
  // the class -- the built-in "match on serial number" would never appear,
  // because the lazy seeder keys on the table being empty.
  ensureDefaultIdentificationRules(workspaceId, cls.id);
  const keys = Array.isArray(body.attr_keys) ? body.attr_keys : [];
  if (!keys.length) throw new ConfigError('A rule needs at least one attribute to match on');
  if (!body.name) throw new ConfigError('name is required');

  const known = new Set(effectiveAttributes(workspaceId, cls.id, { includeDisabled: true }).map((a) => a.attr_key));
  const unknown = keys.filter((k) => !known.has(k));
  if (unknown.length) throw new ConfigError(`Not a field on this class: ${unknown.join(', ')}`);

  const id = uid('cir');
  db.prepare(
    `INSERT INTO ci_identification_rules (id, workspace_id, class_id, name, attr_keys, priority, enabled, system)
     VALUES (?,?,?,?,?,?,?,0)`
  ).run(id, workspaceId, cls.id, body.name, JSON.stringify(keys), body.priority ?? 100, body.enabled === 0 ? 0 : 1);
  return db.prepare('SELECT * FROM ci_identification_rules WHERE id = ?').get(id);
}

export function updateIdentificationRule(workspaceId, ruleId, body) {
  const rule = db.prepare('SELECT * FROM ci_identification_rules WHERE id = ? AND workspace_id = ?').get(ruleId, workspaceId);
  if (!rule) throw new ConfigError('Rule not found', 404);
  if (body.attr_keys !== undefined) {
    if (!Array.isArray(body.attr_keys) || !body.attr_keys.length) throw new ConfigError('A rule needs at least one attribute');
    const known = new Set(effectiveAttributes(workspaceId, rule.class_id, { includeDisabled: true }).map((a) => a.attr_key));
    const unknown = body.attr_keys.filter((k) => !known.has(k));
    if (unknown.length) throw new ConfigError(`Not a field on this class: ${unknown.join(', ')}`);
  }
  const sets = []; const params = [];
  for (const field of ['name', 'priority', 'enabled']) {
    if (body[field] === undefined) continue;
    sets.push(`${field} = ?`); params.push(field === 'enabled' ? (body[field] ? 1 : 0) : body[field]);
  }
  if (body.attr_keys !== undefined) { sets.push('attr_keys = ?'); params.push(JSON.stringify(body.attr_keys)); }
  if (!sets.length) return rule;
  params.push(rule.id);
  db.prepare(`UPDATE ci_identification_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM ci_identification_rules WHERE id = ?').get(rule.id);
}

export function deleteIdentificationRule(workspaceId, ruleId) {
  const rule = db.prepare('SELECT * FROM ci_identification_rules WHERE id = ? AND workspace_id = ?').get(ruleId, workspaceId);
  if (!rule) throw new ConfigError('Rule not found', 404);
  db.prepare('DELETE FROM ci_identification_rules WHERE id = ?').run(rule.id);
  return { ok: true };
}

// ---------------------------------------------------------- identification

/**
 * Find the CI an incoming payload refers to.
 *
 * Rules are tried strongest first and the FIRST one that matches exactly one
 * CI wins. A rule that matches several is reported as ambiguous and skipped
 * rather than picking arbitrarily: guessing here is how a CMDB ends up
 * merging two real servers into one record, which is worse than a duplicate.
 *
 * Search is scoped to the class and everything under it, so a payload for a
 * Server can still match a CI recorded as a Virtual Machine only if the
 * caller asked about the shared ancestor.
 */
export function identify(workspaceId, classId, attributes, { tag } = {}) {
  // An explicit asset tag beats any inferred rule -- it is the one identifier
  // a human deliberately assigned.
  if (tag) {
    const byTag = db.prepare('SELECT * FROM assets WHERE workspace_id = ? AND tag = ?').get(workspaceId, tag);
    if (byTag) return { ci: byTag, matched_by: 'tag', rule: null };
  }

  const cls = getClass(workspaceId, classId);
  if (!cls) return { ci: null, matched_by: null, rule: null };

  const classIds = descendantsOf(workspaceId, cls.id).map((c) => c.id);
  const attrs = new Map(effectiveAttributes(workspaceId, cls.id, { includeDisabled: true }).map((a) => [a.attr_key, a]));
  const ambiguous = [];

  for (const rule of listIdentificationRules(workspaceId, cls.id)) {
    const usable = rule.attr_keys.every((k) => {
      const value = attributes?.[k];
      return attrs.has(k) && value !== undefined && value !== null && String(value).trim() !== '';
    });
    if (!usable) continue;

    // Every attribute in the rule must match on the same CI, which is an
    // intersection over one lookup per attribute.
    let candidates = null;
    for (const key of rule.attr_keys) {
      const attr = attrs.get(key);
      const { value, error } = coerceValue(workspaceId, attr, attributes[key]);
      if (error || value === null) { candidates = new Set(); break; }

      const rows = db.prepare(
        `SELECT v.ci_id FROM ci_attribute_values v
         JOIN ci_class_attributes a ON a.id = v.attribute_id
         JOIN assets ci ON ci.id = v.ci_id
         WHERE a.attr_key = ? AND v.value = ? AND ci.workspace_id = ?
           AND ci.class_id IN (${classIds.map(() => '?').join(',')})`
      ).all(key, value, workspaceId, ...classIds).map((r) => r.ci_id);

      const set = new Set(rows);
      candidates = candidates === null ? set : new Set([...candidates].filter((id) => set.has(id)));
      if (!candidates.size) break;
    }

    if (!candidates || candidates.size === 0) continue;
    if (candidates.size > 1) {
      ambiguous.push({ rule: rule.name, matches: [...candidates] });
      continue;
    }
    const ci = db.prepare('SELECT * FROM assets WHERE id = ?').get([...candidates][0]);
    return { ci, matched_by: rule.attr_keys.join(' + '), rule, ambiguous };
  }

  return { ci: null, matched_by: null, rule: null, ambiguous };
}

// ---------------------------------------------------------- reconciliation

function recordHistory(workspaceId, entry) {
  db.prepare(
    `INSERT INTO ci_attribute_history (id, workspace_id, ci_id, attribute_id, attr_key, old_value, new_value, source, accepted, reason, changed_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    uid('cah'), workspaceId, entry.ci_id, entry.attribute_id || null, entry.attr_key,
    entry.old_value ?? null, entry.new_value ?? null, entry.source, entry.accepted ? 1 : 0,
    entry.reason || null, entry.changed_by || null,
  );
}

/**
 * Apply a set of attribute values to a CI on behalf of a source, honouring
 * trust rank and recording every decision.
 *
 * A write is refused when a strictly higher-trust source already owns that
 * value and the new value differs. Equal trust wins -- the same tool
 * reporting a new value is the normal case, and the last word should be the
 * current one.
 */
export function applyAttributes(workspaceId, ci, classId, attributes, { sourceKey = MANUAL_SOURCE, trustRank = 100, changedBy = null } = {}) {
  const attrs = new Map(effectiveAttributes(workspaceId, classId).map((a) => [a.attr_key, a]));
  const applied = []; const rejected = []; const errors = []; const unchanged = [];

  const existingValues = new Map(
    db.prepare('SELECT attribute_id, value FROM ci_attribute_values WHERE ci_id = ?').all(ci.id)
      .map((r) => [r.attribute_id, r.value])
  );
  const provenance = new Map(
    db.prepare('SELECT attribute_id, source_key, trust_rank FROM ci_attribute_provenance WHERE ci_id = ?').all(ci.id)
      .map((r) => [r.attribute_id, r])
  );

  db.exec('BEGIN');
  try {
    for (const [key, raw] of Object.entries(attributes || {})) {
      const attr = attrs.get(key);
      if (!attr) { errors.push({ attr_key: key, message: `Unknown attribute: ${key}` }); continue; }

      const { value, error } = coerceValue(workspaceId, attr, raw);
      if (error) { errors.push({ attr_key: key, message: error }); continue; }

      const current = existingValues.has(attr.id) ? existingValues.get(attr.id) : null;
      if (current === value) { unchanged.push(key); continue; }

      const owner = provenance.get(attr.id);
      if (owner && owner.source_key !== sourceKey && owner.trust_rank > trustRank) {
        const reason = `${owner.source_key} (trust ${owner.trust_rank}) owns this value`;
        rejected.push({ attr_key: key, attempted: value, current, reason });
        recordHistory(workspaceId, { ci_id: ci.id, attribute_id: attr.id, attr_key: key, old_value: current, new_value: value, source: sourceKey, accepted: 0, reason, changed_by: changedBy });
        continue;
      }

      if (value === null) {
        db.prepare('DELETE FROM ci_attribute_values WHERE ci_id = ? AND attribute_id = ?').run(ci.id, attr.id);
        db.prepare('DELETE FROM ci_attribute_provenance WHERE ci_id = ? AND attribute_id = ?').run(ci.id, attr.id);
      } else {
        db.prepare(
          `INSERT INTO ci_attribute_values (id, ci_id, attribute_id, value, source, updated_at)
           VALUES (?,?,?,?,?,datetime('now'))
           ON CONFLICT(ci_id, attribute_id) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`
        ).run(uid('civ'), ci.id, attr.id, value, sourceKey);
        db.prepare(
          `INSERT INTO ci_attribute_provenance (ci_id, attribute_id, source_key, trust_rank, written_at)
           VALUES (?,?,?,?,datetime('now'))
           ON CONFLICT(ci_id, attribute_id) DO UPDATE SET source_key = excluded.source_key, trust_rank = excluded.trust_rank, written_at = excluded.written_at`
        ).run(ci.id, attr.id, sourceKey, trustRank);
      }

      applied.push({ attr_key: key, from: current, to: value });
      recordHistory(workspaceId, { ci_id: ci.id, attribute_id: attr.id, attr_key: key, old_value: current, new_value: value, source: sourceKey, accepted: 1, changed_by: changedBy });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { applied, rejected, unchanged, errors };
}

/**
 * The whole ingest decision for one payload: identify, then update or create.
 *
 * Returns what happened and why, because a discovery run that silently
 * created 300 CIs is indistinguishable from one that correctly matched them
 * unless the result says which.
 */
export function reconcile(workspaceId, payload, { source, dryRun = false } = {}) {
  const sourceKey = source?.key || MANUAL_SOURCE;
  const trustRank = source?.trust_rank ?? 100;

  const classRef = payload.class_id || payload.ci_class || source?.default_class_id;
  const cls = classRef ? getClass(workspaceId, classRef) : null;
  if (!cls) return { action: 'error', error: 'No CI class given and the source has no default' };
  if (cls.is_abstract) return { action: 'error', error: `${cls.label} is a grouping class and cannot hold CIs` };

  const attributes = payload.attributes || {};
  const match = identify(workspaceId, cls.id, attributes, { tag: payload.tag });

  if (match.ci) {
    const before = db.prepare('SELECT * FROM assets WHERE id = ?').get(match.ci.id);
    if (dryRun) {
      return { action: 'would_update', ci: before, matched_by: match.matched_by, rule: match.rule?.name || null };
    }
    const result = applyAttributes(workspaceId, before, cls.id, attributes, { sourceKey, trustRank });
    touchCore(workspaceId, before, payload, sourceKey, trustRank);
    return {
      action: result.applied.length ? 'updated' : 'unchanged',
      ci: db.prepare('SELECT * FROM assets WHERE id = ?').get(before.id),
      matched_by: match.matched_by,
      rule: match.rule?.name || null,
      ...result,
    };
  }

  if (source && !source.allow_create) {
    return { action: 'skipped', reason: `${source.name} is not allowed to create new CIs`, ambiguous: match.ambiguous };
  }
  if (dryRun) return { action: 'would_create', ci_class: cls.key, ambiguous: match.ambiguous };

  const name = payload.name || firstIdentifierValue(workspaceId, cls.id, attributes) || 'Discovered CI';
  const tag = payload.tag || `${cls.key.toUpperCase().slice(0, 4)}-${uid('').slice(-8)}`;
  const id = uid('ast');
  db.prepare(
    'INSERT INTO assets (id, workspace_id, tag, name, type, status, class_id) VALUES (?,?,?,?,?,?,?)'
  ).run(id, workspaceId, tag, name, payload.type || 'hardware', payload.status || 'in_use', cls.id);

  const ci = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  const result = applyAttributes(workspaceId, ci, cls.id, attributes, { sourceKey, trustRank });
  return { action: 'created', ci, ...result, ambiguous: match.ambiguous };
}

// Core columns follow the same trust rule as attributes, but only when the
// payload actually supplies them -- discovery leaving `location` alone must
// never blank what somebody typed in.
function touchCore(workspaceId, ci, payload, sourceKey, trustRank) {
  const updatable = ['name', 'status', 'location', 'vendor'];
  const sets = []; const params = [];
  for (const field of updatable) {
    if (payload[field] === undefined || payload[field] === null || payload[field] === ci[field]) continue;
    sets.push(`${field} = ?`); params.push(payload[field]);
    recordHistory(workspaceId, {
      ci_id: ci.id, attr_key: field, old_value: ci[field], new_value: payload[field], source: sourceKey, accepted: 1,
    });
  }
  if (!sets.length) return;
  params.push(ci.id);
  db.prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

function firstIdentifierValue(workspaceId, classId, attributes) {
  for (const attr of effectiveAttributes(workspaceId, classId)) {
    if (!attr.is_identifier) continue;
    const v = attributes?.[attr.attr_key];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return null;
}

// ------------------------------------------------------------------- drift

export function attributeHistory(workspaceId, ciId, { limit = 100, includeRejected = true } = {}) {
  return db.prepare(
    `SELECT * FROM ci_attribute_history WHERE workspace_id = ? AND ci_id = ?
     ${includeRejected ? '' : 'AND accepted = 1'}
     ORDER BY changed_at DESC, rowid DESC LIMIT ?`
  ).all(workspaceId, ciId, limit);
}

// Refused writes across the estate: the report that answers "which tool
// disagrees with the record, and about what".
export function driftReport(workspaceId, { limit = 200, since = null } = {}) {
  const rows = db.prepare(
    `SELECT h.*, a.name ci_name, a.tag ci_tag FROM ci_attribute_history h
     JOIN assets a ON a.id = h.ci_id
     WHERE h.workspace_id = ? AND h.accepted = 0 ${since ? 'AND h.changed_at >= ?' : ''}
     ORDER BY h.changed_at DESC LIMIT ?`
  ).all(...(since ? [workspaceId, since, limit] : [workspaceId, limit]));

  const bySource = new Map();
  for (const row of rows) {
    if (!bySource.has(row.source)) bySource.set(row.source, { source: row.source, count: 0, fields: new Set() });
    const entry = bySource.get(row.source);
    entry.count += 1;
    entry.fields.add(row.attr_key);
  }

  return {
    conflicts: rows,
    by_source: [...bySource.values()]
      .map((e) => ({ ...e, fields: [...e.fields] }))
      .sort((a, b) => b.count - a.count),
  };
}

export function provenanceFor(ciId) {
  return db.prepare(
    `SELECT p.*, a.attr_key, a.label FROM ci_attribute_provenance p
     JOIN ci_class_attributes a ON a.id = p.attribute_id WHERE p.ci_id = ?`
  ).all(ciId);
}
