// Relationship types, as configuration rather than three hard-coded strings.
//
// The two fields that matter most are inverse_label and is_dependency.
// The inverse is what lets one stored edge read correctly from both ends,
// so the CI Explorer does not have to say "hosted_on (reverse)". is_dependency
// is what lets impact analysis tell a path an outage travels down from a
// fact about the estate: a database is hosted on a server, so the server
// failing takes the database with it, but two switches being connected to
// each other does not mean one failing kills the other.
import { db, uid } from '../db.js';
import { getClass, descendantsOf, ConfigError } from './ciClasses.js';

// The first three keys are the values already stored in asset_relationships,
// so existing edges keep working and simply gain a label.
const DEFAULTS = [
  { key: 'depends_on', label: 'Depends on', inverse_label: 'Used by', is_dependency: 1, is_containment: 0, color: '#ef4444',
    description: 'A general dependency. If the target fails, the source is affected.' },
  { key: 'hosted_on', label: 'Runs on', inverse_label: 'Hosts', is_dependency: 1, is_containment: 1, color: '#0ea5e9',
    description: 'The source executes on the target: a VM on a hypervisor, an application on a server.' },
  { key: 'connected_to', label: 'Connected to', inverse_label: 'Connected to', is_dependency: 0, is_containment: 0, color: '#94a3b8',
    description: 'A peer link. Recorded because it is true, not because failure propagates along it.' },
  { key: 'installed_on', label: 'Installed on', inverse_label: 'Has installed', is_dependency: 1, is_containment: 1, color: '#f59e0b',
    description: 'Software installed on a device. Drives licence counting.' },
  { key: 'uses', label: 'Uses', inverse_label: 'Used by', is_dependency: 1, is_containment: 0, color: '#8b5cf6',
    description: 'The source calls or consumes the target: an application using a database.' },
  { key: 'member_of', label: 'Member of', inverse_label: 'Contains', is_dependency: 0, is_containment: 1, color: '#14b8a6',
    description: 'Membership of a cluster, rack or group.' },
  { key: 'supports', label: 'Supports', inverse_label: 'Supported by', is_dependency: 0, is_containment: 0, color: '#ec4899',
    description: 'The source underpins the target service. Read the other way round for a service map.' },
  { key: 'clustered_with', label: 'Clustered with', inverse_label: 'Clustered with', is_dependency: 0, is_containment: 0, color: '#22c55e',
    description: 'Peers in a highly available pair or cluster. Deliberately not a dependency -- the whole point is that one can fail.' },
  { key: 'replicates_to', label: 'Replicates to', inverse_label: 'Replicated from', is_dependency: 0, is_containment: 0, color: '#06b6d4',
    description: 'Data flows from the source to the target.' },
  { key: 'backs_up', label: 'Backs up', inverse_label: 'Backed up by', is_dependency: 0, is_containment: 0, color: '#a3a3a3',
    description: 'The source takes backups of the target.' },
  { key: 'manages', label: 'Manages', inverse_label: 'Managed by', is_dependency: 0, is_containment: 0, color: '#64748b',
    description: 'Monitoring, orchestration or management of the target.' },
];

export function ensureDefaultRelationshipTypes(workspaceId) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM ci_relationship_types WHERE workspace_id = ?').get(workspaceId);
  if (c > 0) return;
  db.exec('BEGIN');
  try {
    DEFAULTS.forEach((t, i) => {
      db.prepare(
        `INSERT INTO ci_relationship_types (id, workspace_id, key, label, inverse_label, description,
                                            is_dependency, is_containment, color, sort_order, enabled, system)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,1)`
      ).run(uid('crt'), workspaceId, t.key, t.label, t.inverse_label, t.description, t.is_dependency, t.is_containment, t.color, i * 10);
    });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listRelationshipTypes(workspaceId, { includeDisabled = false } = {}) {
  ensureDefaultRelationshipTypes(workspaceId);
  return db.prepare(
    `SELECT * FROM ci_relationship_types WHERE workspace_id = ?${includeDisabled ? '' : ' AND enabled = 1'} ORDER BY sort_order, label`
  ).all(workspaceId).map(hydrate);
}

export function getRelationshipType(workspaceId, idOrKey) {
  if (!idOrKey) return null;
  ensureDefaultRelationshipTypes(workspaceId);
  const row = db.prepare('SELECT * FROM ci_relationship_types WHERE workspace_id = ? AND (id = ? OR key = ?)')
    .get(workspaceId, idOrKey, idOrKey);
  return row ? hydrate(row) : null;
}

function hydrate(row) {
  return {
    ...row,
    allowed_source_classes: parseList(row.allowed_source_classes),
    allowed_target_classes: parseList(row.allowed_target_classes),
  };
}

function parseList(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

// A type may restrict which classes can sit at each end. An empty list means
// "any", which is what every default ships with -- the restriction exists for
// admins who want to stop "Database installed on Business Service" being
// recorded, not as something the product imposes up front.
export function checkEndpoints(workspaceId, type, sourceClass, targetClass) {
  const errors = [];
  const ok = (allowed, cls, which) => {
    if (!allowed.length) return;
    if (!cls) { errors.push(`The ${which} CI has no class, so it cannot be checked against this relationship type`); return; }
    const permitted = new Set(allowed.flatMap((id) => descendantsOf(workspaceId, id).map((c) => c.id)));
    if (!permitted.has(cls.id)) {
      const names = allowed.map((id) => getClass(workspaceId, id)?.label).filter(Boolean).join(', ');
      errors.push(`${type.label} expects the ${which} to be one of: ${names}`);
    }
  };
  ok(type.allowed_source_classes, sourceClass, 'source');
  ok(type.allowed_target_classes, targetClass, 'target');
  return errors;
}

// ------------------------------------------------------------------- CRUD

const SLUG = /^[a-z][a-z0-9_]{0,48}$/;

function validateClassList(workspaceId, list, field) {
  if (list === undefined) return undefined;
  if (list === null) return [];
  if (!Array.isArray(list)) throw new ConfigError(`${field} must be a list of class ids`);
  for (const id of list) {
    if (!getClass(workspaceId, id)) throw new ConfigError(`${field}: no such class`, 404);
  }
  return list;
}

export function createRelationshipType(workspaceId, body) {
  ensureDefaultRelationshipTypes(workspaceId);
  const key = String(body.key || '').trim().toLowerCase();
  if (!SLUG.test(key)) throw new ConfigError('key must be lowercase letters, numbers and underscores, starting with a letter');
  if (!body.label || !body.inverse_label) {
    throw new ConfigError('Both a label and an inverse label are required, so the edge reads correctly from either end');
  }
  if (getRelationshipType(workspaceId, key)) throw new ConfigError(`A relationship type with the key ${key} already exists`, 409);

  const sources = validateClassList(workspaceId, body.allowed_source_classes, 'allowed_source_classes') || [];
  const targets = validateClassList(workspaceId, body.allowed_target_classes, 'allowed_target_classes') || [];

  const { max } = db.prepare('SELECT COALESCE(MAX(sort_order), 0) max FROM ci_relationship_types WHERE workspace_id = ?').get(workspaceId);
  const id = uid('crt');
  db.prepare(
    `INSERT INTO ci_relationship_types (id, workspace_id, key, label, inverse_label, description, is_dependency,
                                        is_containment, allowed_source_classes, allowed_target_classes, color, sort_order, enabled, system)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
  ).run(
    id, workspaceId, key, body.label, body.inverse_label, body.description || null,
    body.is_dependency === undefined ? 1 : (body.is_dependency ? 1 : 0),
    body.is_containment ? 1 : 0,
    sources.length ? JSON.stringify(sources) : null,
    targets.length ? JSON.stringify(targets) : null,
    body.color || null, max + 10, body.enabled === 0 ? 0 : 1,
  );
  return getRelationshipType(workspaceId, id);
}

export function updateRelationshipType(workspaceId, id, body) {
  const type = getRelationshipType(workspaceId, id);
  if (!type) throw new ConfigError('Relationship type not found', 404);
  if (body.key !== undefined && body.key !== type.key && type.system) {
    throw new ConfigError('The key of a built-in relationship type cannot be changed');
  }
  if (body.label === '' || body.inverse_label === '') throw new ConfigError('Labels cannot be empty');

  const sources = validateClassList(workspaceId, body.allowed_source_classes, 'allowed_source_classes');
  const targets = validateClassList(workspaceId, body.allowed_target_classes, 'allowed_target_classes');

  const allowed = ['key', 'label', 'inverse_label', 'description', 'is_dependency', 'is_containment', 'color', 'sort_order', 'enabled'];
  const sets = []; const params = [];
  for (const field of allowed) {
    if (body[field] === undefined) continue;
    let v = body[field];
    if (['is_dependency', 'is_containment', 'enabled'].includes(field)) v = v ? 1 : 0;
    if (field === 'key') v = String(v).trim().toLowerCase();
    sets.push(`${field} = ?`); params.push(v);
  }
  if (sources !== undefined) { sets.push('allowed_source_classes = ?'); params.push(sources.length ? JSON.stringify(sources) : null); }
  if (targets !== undefined) { sets.push('allowed_target_classes = ?'); params.push(targets.length ? JSON.stringify(targets) : null); }
  if (!sets.length) return type;
  params.push(type.id);
  db.prepare(`UPDATE ci_relationship_types SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getRelationshipType(workspaceId, type.id);
}

export function deleteRelationshipType(workspaceId, id) {
  const type = getRelationshipType(workspaceId, id);
  if (!type) throw new ConfigError('Relationship type not found', 404);
  if (type.system) throw new ConfigError('Built-in relationship types cannot be deleted. Disable it instead.');
  const { c } = db.prepare('SELECT COUNT(*) c FROM asset_relationships WHERE type_id = ?').get(type.id);
  if (c > 0) throw new ConfigError(`${c} relationship(s) still use this type`);
  db.prepare('DELETE FROM ci_relationship_types WHERE id = ?').run(type.id);
  return { ok: true };
}
