// Discovery sources: the tools allowed to push CIs into the CMDB.
//
// Each one carries a trust rank, which is the whole point. Every real estate
// has several tools that think they know what a server is called -- the
// hypervisor, the agent, the network scanner, the cloud API -- and they
// disagree. Without a rank the CMDB simply reflects whichever ran last, which
// is why so many of them end up untrusted. With one, disagreements resolve
// the same way every time and the losing write is kept as evidence.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { db, uid } from '../db.js';
import { getClass, ConfigError } from './ciClasses.js';

// Matches the class/attribute slug rule in ciClasses.js, so every key in
// the CMDB follows one convention.
const SLUG = /^[a-z][a-z0-9_-]{0,48}$/;

// Ranks are advisory numbers, but naming the common tiers stops every admin
// inventing their own scale.
export const TRUST_TIERS = [
  { rank: 90, label: 'Authoritative', hint: 'The system of record for this kind of CI (a hypervisor for its own VMs, a cloud API for its own resources).' },
  { rank: 70, label: 'Agent', hint: 'Something installed on the CI itself, reporting first-hand.' },
  { rank: 50, label: 'Scanner', hint: 'Network discovery inferring from the outside.' },
  { rank: 30, label: 'Import', hint: 'Spreadsheets and one-off loads.' },
  { rank: 10, label: 'Untrusted', hint: 'Recorded, but never allowed to overwrite anything.' },
];

// Manual edits deliberately outrank every tool. A person who has just looked
// at the rack should not be overruled by a scanner ten minutes later.
export const MANUAL_TRUST_RANK = 100;

function shape(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const { ingest_secret: secret, ...rest } = row;
  return {
    ...rest,
    // The secret is write-only over the API: it is shown once at creation or
    // rotation and never read back, the same rule alert sources follow.
    has_secret: !!secret,
    ...(includeSecret ? { ingest_secret: secret } : {}),
  };
}

export function listDiscoverySources(workspaceId, { includeDisabled = true } = {}) {
  return db.prepare(
    `SELECT * FROM discovery_sources WHERE workspace_id = ?${includeDisabled ? '' : ' AND enabled = 1'} ORDER BY trust_rank DESC, name`
  ).all(workspaceId).map((r) => shape(r));
}

export function getDiscoverySource(workspaceId, idOrKey, opts = {}) {
  if (!idOrKey) return null;
  const row = db.prepare('SELECT * FROM discovery_sources WHERE workspace_id = ? AND (id = ? OR key = ?)')
    .get(workspaceId, idOrKey, idOrKey);
  return shape(row, opts);
}

// Used by the ingest route, which needs the raw secret to compare against.
export function getSourceForIngest(workspaceId, key) {
  const row = db.prepare('SELECT * FROM discovery_sources WHERE workspace_id = ? AND key = ?').get(workspaceId, key);
  return row || null;
}

export function createDiscoverySource(workspaceId, body) {
  const key = String(body.key || '').trim().toLowerCase();
  if (!SLUG.test(key)) throw new ConfigError('key must be lowercase letters, numbers, dashes and underscores');
  if (!body.name) throw new ConfigError('name is required');
  if (getDiscoverySource(workspaceId, key)) throw new ConfigError(`A source with the key ${key} already exists`, 409);

  if (body.default_class_id && !getClass(workspaceId, body.default_class_id)) {
    throw new ConfigError('Default class not found', 404);
  }

  const secret = randomBytes(24).toString('base64url');
  const id = uid('dsc');
  db.prepare(
    `INSERT INTO discovery_sources (id, workspace_id, key, name, description, ingest_secret, trust_rank, enabled, allow_create, default_class_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, workspaceId, key, body.name, body.description || null, secret,
    clampRank(body.trust_rank), body.enabled === 0 ? 0 : 1,
    body.allow_create === false || body.allow_create === 0 ? 0 : 1,
    body.default_class_id || null,
  );

  // Returned once, in the clear, because this is the only moment the admin
  // can copy it into the tool that will be posting.
  return { ...getDiscoverySource(workspaceId, id), ingest_secret: secret };
}

function clampRank(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export function updateDiscoverySource(workspaceId, id, body) {
  const source = getDiscoverySource(workspaceId, id);
  if (!source) throw new ConfigError('Source not found', 404);
  if (body.key !== undefined && body.key !== source.key) {
    // The key is in the ingest URL that has already been pasted into another
    // system; changing it silently breaks that integration.
    throw new ConfigError('The key is part of the ingest URL and cannot be changed. Create a new source instead.');
  }
  if (body.default_class_id && !getClass(workspaceId, body.default_class_id)) {
    throw new ConfigError('Default class not found', 404);
  }

  const sets = []; const params = [];
  for (const field of ['name', 'description', 'enabled', 'allow_create', 'default_class_id', 'trust_rank']) {
    if (body[field] === undefined) continue;
    let v = body[field];
    if (field === 'enabled' || field === 'allow_create') v = v ? 1 : 0;
    if (field === 'trust_rank') v = clampRank(v);
    if (field === 'default_class_id' && !v) v = null;
    sets.push(`${field} = ?`); params.push(v);
  }
  if (!sets.length) return source;
  params.push(source.id);
  db.prepare(`UPDATE discovery_sources SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getDiscoverySource(workspaceId, source.id);
}

export function rotateSecret(workspaceId, id) {
  const source = getDiscoverySource(workspaceId, id);
  if (!source) throw new ConfigError('Source not found', 404);
  const secret = randomBytes(24).toString('base64url');
  db.prepare('UPDATE discovery_sources SET ingest_secret = ? WHERE id = ?').run(secret, source.id);
  return { ...getDiscoverySource(workspaceId, source.id), ingest_secret: secret };
}

export function deleteDiscoverySource(workspaceId, id) {
  const source = getDiscoverySource(workspaceId, id);
  if (!source) throw new ConfigError('Source not found', 404);
  db.prepare('DELETE FROM discovery_sources WHERE id = ?').run(source.id);
  // Provenance rows deliberately survive: "this value came from a source that
  // has since been removed" is still the truth about where it came from.
  return { ok: true };
}

export function recordIngest(workspaceId, sourceId, count) {
  db.prepare("UPDATE discovery_sources SET last_ingest_at = datetime('now'), last_ingest_count = ? WHERE id = ? AND workspace_id = ?")
    .run(count, sourceId, workspaceId);
}

// Constant-time comparison, matching the webhook-secret handling in
// routes/alertWebhooks.js: a length-varying early return would leak the
// secret's length, and a plain === would leak its prefix through timing.
export function secretMatches(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
