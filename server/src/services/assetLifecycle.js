// The asset lifecycle and custody chain.
//
// Deliberately separate from assets.status. Those answer different questions:
// status is "is this thing running", lifecycle is "do we still own it and who
// has it". A laptop can be `in_use` operationally while its lifecycle says
// `assigned`, and a spare in a cupboard is lifecycle `in_stock` with no
// operational status worth reporting at all. Conflating them is why so many
// asset registers cannot answer "how many spare laptops do we have".
//
// Guarded the same way changeWorkflow.js guards a change: transitions are
// declared, illegal ones are refused with a reason a person can read, and
// every move is recorded.
import { db, uid } from '../db.js';
import { ConfigError } from './ciClasses.js';

export const LIFECYCLE_STATES = {
  ordered: { label: 'On order', description: 'Bought but not yet received.', terminal: 0 },
  in_stock: { label: 'In stock', description: 'Held, available to issue.', terminal: 0 },
  assigned: { label: 'Assigned', description: 'Issued to a person or a place.', terminal: 0 },
  in_repair: { label: 'In repair', description: 'Out of service, being fixed.', terminal: 0 },
  reserved: { label: 'Reserved', description: 'Held for a specific person or project.', terminal: 0 },
  lost: { label: 'Lost or stolen', description: 'Unaccounted for. Still on the books until written off.', terminal: 0 },
  retired: { label: 'Retired', description: 'Withdrawn from service, not yet disposed of.', terminal: 0 },
  disposed: { label: 'Disposed', description: 'Gone, with a disposal record.', terminal: 1 },
};

export const LIFECYCLE_KEYS = Object.keys(LIFECYCLE_STATES);

// Who can go where. The shape matters more than the exact edges: an asset
// cannot go straight from `ordered` to `disposed` without ever having been
// received, and `disposed` is the end -- a disposed asset coming back is a
// new record, because the old one has a disposal certificate against it.
const TRANSITIONS = {
  ordered: ['in_stock', 'lost'],
  in_stock: ['assigned', 'reserved', 'in_repair', 'retired', 'lost'],
  assigned: ['in_stock', 'in_repair', 'lost', 'retired'],
  reserved: ['assigned', 'in_stock'],
  in_repair: ['in_stock', 'assigned', 'retired'],
  lost: ['in_stock', 'retired'],
  retired: ['disposed', 'in_stock'],
  disposed: [],
};

export function allowedTransitions(state) {
  return TRANSITIONS[state] || [];
}

function currentState(asset) {
  return asset.lifecycle_state && LIFECYCLE_STATES[asset.lifecycle_state] ? asset.lifecycle_state : 'in_stock';
}

function getAsset(workspaceId, assetId) {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ? AND workspace_id = ?').get(assetId, workspaceId);
  if (!asset) throw new ConfigError('Asset not found', 404);
  return asset;
}

export function lifecycleFor(workspaceId, assetId) {
  const asset = getAsset(workspaceId, assetId);
  const state = currentState(asset);
  return {
    state,
    ...LIFECYCLE_STATES[state],
    transitions: allowedTransitions(state).map((key) => ({ key, ...LIFECYCLE_STATES[key] })),
    history: db.prepare('SELECT * FROM asset_lifecycle_events WHERE asset_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(assetId),
  };
}

export function transitionLifecycle(workspaceId, assetId, to, { reason = null, actorId = null } = {}) {
  const asset = getAsset(workspaceId, assetId);
  const from = currentState(asset);
  if (!LIFECYCLE_STATES[to]) throw new ConfigError(`Unknown lifecycle state: ${to}`);
  if (from === to) return { ok: true, unchanged: true, state: to };
  if (!allowedTransitions(from).includes(to)) {
    throw new ConfigError(`An asset cannot go from ${LIFECYCLE_STATES[from].label} to ${LIFECYCLE_STATES[to].label}.`);
  }
  // An asset still out with someone cannot be put back in stock or disposed
  // of behind their back -- the custody record has to be closed first, or the
  // register quietly loses track of a machine somebody is still using.
  if (['in_stock', 'retired', 'disposed'].includes(to) && openAssignment(assetId)) {
    throw new ConfigError('This asset is still checked out. Check it back in first.');
  }

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE assets SET lifecycle_state = ? WHERE id = ?').run(to, assetId);
    db.prepare(
      'INSERT INTO asset_lifecycle_events (id, workspace_id, asset_id, from_state, to_state, reason, actor_id) VALUES (?,?,?,?,?,?,?)'
    ).run(uid('ale'), workspaceId, assetId, from, to, reason, actorId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true, from, state: to };
}

// ----------------------------------------------------------------- custody

export function openAssignment(assetId) {
  return db.prepare('SELECT * FROM asset_assignments WHERE asset_id = ? AND returned_at IS NULL ORDER BY assigned_at DESC LIMIT 1')
    .get(assetId) || null;
}

export function assignmentHistory(workspaceId, assetId, { limit = 100 } = {}) {
  return db.prepare(
    `SELECT a.*, u.name AS user_name, u.email AS user_email
     FROM asset_assignments a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.workspace_id = ? AND a.asset_id = ? ORDER BY a.assigned_at DESC, a.rowid DESC LIMIT ?`
  ).all(workspaceId, assetId, limit);
}

/**
 * Check an asset out to somebody.
 *
 * Checking out something that is already out closes the previous holding
 * first rather than refusing: in practice a device does get handed straight
 * from one person to the next, and refusing simply produces a register that
 * disagrees with reality.
 */
export function checkOut(workspaceId, assetId, { userId = null, label = null, actorId = null, condition = null, notes = null } = {}) {
  const asset = getAsset(workspaceId, assetId);
  if (!userId && !label) throw new ConfigError('Say who or where this is being issued to');
  if (currentState(asset) === 'disposed') throw new ConfigError('This asset has been disposed of and cannot be issued.');

  if (userId) {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
    if (!user) throw new ConfigError('User not found', 404);
  }

  const existing = openAssignment(assetId);
  const id = uid('asg');

  db.exec('BEGIN');
  try {
    if (existing) {
      db.prepare("UPDATE asset_assignments SET returned_at = datetime('now'), returned_to = ?, notes = COALESCE(notes,'') || ? WHERE id = ?")
        .run(actorId, ' [closed automatically: reissued]', existing.id);
    }
    db.prepare(
      `INSERT INTO asset_assignments (id, workspace_id, asset_id, user_id, assigned_to_label, assigned_by, condition_out, notes)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, workspaceId, assetId, userId, label, actorId, condition, notes);

    // The register should reflect custody without anyone having to remember
    // to also move the lifecycle by hand.
    db.prepare('UPDATE assets SET owner_id = ?, lifecycle_state = ? WHERE id = ?').run(userId, 'assigned', assetId);
    if (currentState(asset) !== 'assigned') {
      db.prepare('INSERT INTO asset_lifecycle_events (id, workspace_id, asset_id, from_state, to_state, reason, actor_id) VALUES (?,?,?,?,?,?,?)')
        .run(uid('ale'), workspaceId, assetId, currentState(asset), 'assigned', 'Checked out', actorId);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true, assignment: db.prepare('SELECT * FROM asset_assignments WHERE id = ?').get(id), replaced: !!existing };
}

export function checkIn(workspaceId, assetId, { actorId = null, condition = null, notes = null, toState = 'in_stock' } = {}) {
  getAsset(workspaceId, assetId);
  const open = openAssignment(assetId);
  if (!open) throw new ConfigError('This asset is not currently checked out.');
  if (!LIFECYCLE_STATES[toState]) throw new ConfigError(`Unknown lifecycle state: ${toState}`);

  db.exec('BEGIN');
  try {
    db.prepare("UPDATE asset_assignments SET returned_at = datetime('now'), returned_to = ?, condition_in = ?, notes = COALESCE(?, notes) WHERE id = ?")
      .run(actorId, condition, notes, open.id);
    db.prepare('UPDATE assets SET owner_id = NULL, lifecycle_state = ? WHERE id = ?').run(toState, assetId);
    db.prepare('INSERT INTO asset_lifecycle_events (id, workspace_id, asset_id, from_state, to_state, reason, actor_id) VALUES (?,?,?,?,?,?,?)')
      .run(uid('ale'), workspaceId, assetId, 'assigned', toState, 'Checked in', actorId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { ok: true, state: toState };
}

// Everything a named person currently holds. This is the leaver question, and
// it is the one an asset register most often cannot answer.
export function heldBy(workspaceId, userId) {
  return db.prepare(
    `SELECT a.*, asg.assigned_at, asg.id AS assignment_id
     FROM asset_assignments asg JOIN assets a ON a.id = asg.asset_id
     WHERE asg.workspace_id = ? AND asg.user_id = ? AND asg.returned_at IS NULL
     ORDER BY asg.assigned_at DESC`
  ).all(workspaceId, userId);
}

// How the estate is distributed across the lifecycle, for the inventory strip.
export function lifecycleSummary(workspaceId) {
  const counts = new Map(
    db.prepare("SELECT COALESCE(lifecycle_state,'in_stock') s, COUNT(*) c FROM assets WHERE workspace_id = ? GROUP BY 1")
      .all(workspaceId).map((r) => [r.s, r.c])
  );
  return LIFECYCLE_KEYS.map((key) => ({ key, ...LIFECYCLE_STATES[key], count: counts.get(key) || 0 }));
}
