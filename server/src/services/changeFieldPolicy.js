// Which fields a change can still have edited, at each point in its lifecycle.
//
// The gap this closes: a change could be approved by the CAB and its
// implementation plan then rewritten without anyone noticing, because the
// only thing the state machine guarded was which transitions were legal, not
// what could still be typed once you were there. Approval is meaningless if
// the thing approved can quietly change afterwards.
//
// Three levels, deliberately not four. `hidden` is not here: whether a field
// is VISIBLE is Business Rules' job, and having two systems that can both
// hide the same field is how you end up unable to explain why a field
// vanished. This answers a different question -- can it still be CHANGED,
// given where the change has got to.
//
// No row means editable. An empty table therefore behaves exactly as the
// product did before this existed, which is what makes it safe to ship on to
// live workspaces.
import { db, uid } from '../db.js';
import { CHANGE_STATES, STATE_KEYS } from './changeWorkflow.js';

export const ACCESS_LEVELS = ['editable', 'readonly', 'required'];

// The fields worth governing: everything the ticket PATCH route will accept
// on a change, minus `status` (the state machine owns that outright).
export const GOVERNABLE_FIELDS = [
  { key: 'title', label: 'Title', group: 'Description' },
  { key: 'description', label: 'Description', group: 'Description' },
  { key: 'category', label: 'Category', group: 'Classification' },
  { key: 'subcategory', label: 'Subcategory', group: 'Classification' },
  { key: 'priority', label: 'Priority', group: 'Classification' },
  { key: 'impact', label: 'Impact', group: 'Classification' },
  { key: 'risk', label: 'Risk', group: 'Classification' },
  { key: 'assignee_id', label: 'Assignee', group: 'Ownership' },
  { key: 'team', label: 'Group', group: 'Ownership' },
  { key: 'implementation_plan', label: 'Implementation plan', group: 'Plans' },
  { key: 'test_plan', label: 'Test plan', group: 'Plans' },
  { key: 'rollback_plan', label: 'Backout plan', group: 'Plans' },
  { key: 'planned_start', label: 'Planned start', group: 'Schedule' },
  { key: 'planned_end', label: 'Planned end', group: 'Schedule' },
];

const FIELD_KEYS = new Set(GOVERNABLE_FIELDS.map((f) => f.key));
const FIELD_LABELS = new Map(GOVERNABLE_FIELDS.map((f) => [f.key, f.label]));

// The defaults encode standard change practice: what you are describing and
// planning is open early, freezes once the CAB has signed it off, and the
// whole record goes read-only at closure. An admin can override any of it.
const DEFAULT_POLICY = {
  new: { },
  in_review: { },
  pending_approval: {
    // Editing the thing the CAB is currently reading is how approvals get
    // disputed after the fact.
    implementation_plan: 'readonly', rollback_plan: 'readonly', test_plan: 'readonly',
    category: 'readonly', subcategory: 'readonly',
  },
  approved: {
    implementation_plan: 'readonly', rollback_plan: 'readonly', test_plan: 'readonly',
    category: 'readonly', subcategory: 'readonly', impact: 'readonly', risk: 'readonly',
  },
  scheduled: {
    implementation_plan: 'readonly', rollback_plan: 'readonly', test_plan: 'readonly',
    category: 'readonly', subcategory: 'readonly', impact: 'readonly', risk: 'readonly',
    planned_start: 'readonly', planned_end: 'readonly',
  },
  in_progress: {
    title: 'readonly', description: 'readonly',
    implementation_plan: 'readonly', rollback_plan: 'readonly', test_plan: 'readonly',
    category: 'readonly', subcategory: 'readonly', impact: 'readonly', risk: 'readonly',
    planned_start: 'readonly', planned_end: 'readonly',
  },
  implemented: {
    title: 'readonly', description: 'readonly',
    implementation_plan: 'readonly', rollback_plan: 'readonly', test_plan: 'readonly',
    category: 'readonly', subcategory: 'readonly', impact: 'readonly', risk: 'readonly',
    planned_start: 'readonly', planned_end: 'readonly',
  },
  rolled_back: {
    title: 'readonly', description: 'readonly',
    implementation_plan: 'readonly', rollback_plan: 'readonly', test_plan: 'readonly',
    category: 'readonly', subcategory: 'readonly', impact: 'readonly', risk: 'readonly',
    planned_start: 'readonly', planned_end: 'readonly',
  },
  // A closed change is a record, not a working document.
  closed: Object.fromEntries(GOVERNABLE_FIELDS.map((f) => [f.key, 'readonly'])),
  reopened: { },
};

export function ensureDefaultFieldPolicy(workspaceId) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM change_state_field_rules WHERE workspace_id = ?').get(workspaceId);
  if (c > 0) return;

  db.exec('BEGIN');
  try {
    for (const stateKey of STATE_KEYS) {
      for (const [fieldKey, access] of Object.entries(DEFAULT_POLICY[stateKey] || {})) {
        if (!FIELD_KEYS.has(fieldKey)) continue;
        db.prepare(
          'INSERT INTO change_state_field_rules (id, workspace_id, state_key, field_key, access) VALUES (?,?,?,?,?)'
        ).run(uid('csf'), workspaceId, stateKey, fieldKey, access);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// state_key -> { field_key: access }, with every state present so the admin
// grid can render without the caller filling gaps itself.
export function getFieldPolicy(workspaceId) {
  ensureDefaultFieldPolicy(workspaceId);
  const rows = db.prepare('SELECT state_key, field_key, access FROM change_state_field_rules WHERE workspace_id = ?')
    .all(workspaceId);
  const policy = Object.fromEntries(STATE_KEYS.map((k) => [k, {}]));
  for (const row of rows) {
    if (!policy[row.state_key]) continue;        // a state that no longer exists
    if (!FIELD_KEYS.has(row.field_key)) continue; // a field that no longer exists
    policy[row.state_key][row.field_key] = row.access;
  }
  return policy;
}

export function accessFor(workspaceId, stateKey, fieldKey) {
  if (!stateKey) return 'editable';
  const row = db.prepare(
    'SELECT access FROM change_state_field_rules WHERE workspace_id = ? AND state_key = ? AND field_key = ?'
  ).get(workspaceId, stateKey, fieldKey);
  return row?.access || 'editable';
}

// The whole policy for one change, ready for the UI to disable inputs with.
export function policyForState(workspaceId, stateKey) {
  const policy = getFieldPolicy(workspaceId);
  const forState = policy[stateKey] || {};
  return {
    state: stateKey,
    state_label: CHANGE_STATES[stateKey]?.label || stateKey,
    readonly: Object.keys(forState).filter((k) => forState[k] === 'readonly'),
    required: Object.keys(forState).filter((k) => forState[k] === 'required'),
    fields: GOVERNABLE_FIELDS.map((f) => ({ ...f, access: forState[f.key] || 'editable' })),
  };
}

/**
 * Refuse an edit that the change's current state does not permit.
 *
 * Only fields actually present in the patch are considered, and a patch that
 * sets a field to the value it already holds is allowed through -- a form
 * that posts every field back would otherwise be unable to save anything at
 * all once one field locked.
 *
 * Returns null when the edit is fine, or { error, fields } when it is not.
 */
export function checkEdit(workspaceId, ticket, body) {
  if (!ticket || ticket.type !== 'change') return null;
  const stateKey = ticket.change_state;
  if (!stateKey) return null;

  const policy = getFieldPolicy(workspaceId)[stateKey] || {};
  const blocked = [];
  for (const [key, value] of Object.entries(body || {})) {
    if (policy[key] !== 'readonly') continue;
    const current = ticket[key];
    const unchanged = value === current
      || (value === null && current === null)
      || (String(value ?? '') === String(current ?? ''));
    if (!unchanged) blocked.push(key);
  }
  if (!blocked.length) return null;

  const labels = blocked.map((k) => FIELD_LABELS.get(k) || k);
  const stateLabel = CHANGE_STATES[stateKey]?.label || stateKey;
  return {
    error: `${labels.join(', ')} cannot be edited while this change is ${stateLabel}.`,
    fields: blocked,
    state: stateKey,
  };
}

// Required-at-this-state check, used when a change is about to move on.
export function missingRequired(workspaceId, ticket) {
  if (!ticket || ticket.type !== 'change' || !ticket.change_state) return [];
  const policy = getFieldPolicy(workspaceId)[ticket.change_state] || {};
  return Object.keys(policy)
    .filter((k) => policy[k] === 'required')
    .filter((k) => {
      const v = ticket[k];
      return v === null || v === undefined || String(v).trim() === '';
    })
    .map((k) => ({ field: k, label: FIELD_LABELS.get(k) || k }));
}

// Replaces the whole policy in one call: a grid edit is one save, and a
// partial write would leave the admin looking at a half-applied matrix.
export function saveFieldPolicy(workspaceId, incoming) {
  const cleaned = [];
  for (const [stateKey, fields] of Object.entries(incoming || {})) {
    if (!STATE_KEYS.includes(stateKey)) throw new Error(`Unknown change state: ${stateKey}`);
    for (const [fieldKey, access] of Object.entries(fields || {})) {
      if (!FIELD_KEYS.has(fieldKey)) throw new Error(`Unknown field: ${fieldKey}`);
      if (!ACCESS_LEVELS.includes(access)) throw new Error(`Unknown access level: ${access}`);
      if (access === 'editable') continue; // the default; stored as absence
      cleaned.push({ stateKey, fieldKey, access });
    }
  }

  // An admin who clears the whole grid means "everything editable". Writing
  // nothing would leave the table empty for this workspace, and the lazy
  // seeder would helpfully put the defaults straight back on the next read --
  // so one explicit editable row is kept as a marker that a decision was made.
  const rows = cleaned.length
    ? cleaned
    : [{ stateKey: STATE_KEYS[0], fieldKey: GOVERNABLE_FIELDS[0].key, access: 'editable' }];

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM change_state_field_rules WHERE workspace_id = ?').run(workspaceId);
    for (const row of rows) {
      db.prepare('INSERT INTO change_state_field_rules (id, workspace_id, state_key, field_key, access) VALUES (?,?,?,?,?)')
        .run(uid('csf'), workspaceId, row.stateKey, row.fieldKey, row.access);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getFieldPolicy(workspaceId);
}
