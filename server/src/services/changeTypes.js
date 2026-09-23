// The four change types from the flow diagram, as configuration.
//
// Everything that differs between a Standard and an Emergency change is a
// column here rather than a branch in code: which approval route applies,
// how long approvers have, which plans are mandatory, whether a freeze can
// be pierced, and which risk bands force a PIR. The flow diagram's developer
// notes ask for exactly this ("use configurable rules, no hardcoding").
import { db, uid } from '../db.js';

export const CHANGE_TYPE_KEYS = ['standard', 'normal', 'emergency', 'expedite'];
export const APPROVAL_MODES = ['auto_template', 'cab', 'ecab', 'expedite'];

// Defaults chosen to match the diagram's own annotations -- Emergency within
// 1 hour, Expedite within 4 -- and ITIL convention for the rest.
const DEFAULTS = [
  {
    key: 'standard',
    label: 'Standard',
    description: 'Pre-approved, low-risk and repeatable. Auto-approves when it matches a standard change template; anything that does not match is routed as Normal.',
    approval_mode: 'auto_template',
    approval_sla_hours: null,
    requires_backout: 0,
    requires_test_plan: 0,
    requires_implementation_plan: 1,
    pir_required_bands: [],
    mandatory_fields: ['title', 'category', 'implementation_plan'],
    allow_freeze_override: 0,
    lead_time_hours: 0,
  },
  {
    key: 'normal',
    label: 'Normal',
    description: 'The default path. Reviewed and approved by the CAB at a scheduled sitting, or asynchronously when it cannot wait for the next one.',
    approval_mode: 'cab',
    approval_sla_hours: 72,
    requires_backout: 1,
    requires_test_plan: 1,
    requires_implementation_plan: 1,
    pir_required_bands: ['high', 'critical'],
    mandatory_fields: ['title', 'description', 'category', 'implementation_plan', 'rollback_plan', 'planned_start', 'planned_end'],
    allow_freeze_override: 0,
    lead_time_hours: 48,
  },
  {
    key: 'emergency',
    label: 'Emergency',
    description: 'Restores service or averts imminent harm. Goes straight to the ECAB for an immediate decision, and may pierce a change freeze with a recorded reason.',
    approval_mode: 'ecab',
    approval_sla_hours: 1,
    requires_backout: 1,
    requires_test_plan: 0,
    requires_implementation_plan: 1,
    pir_required_bands: ['low', 'medium', 'high', 'critical'],
    mandatory_fields: ['title', 'description', 'implementation_plan', 'rollback_plan'],
    allow_freeze_override: 1,
    lead_time_hours: 0,
  },
  {
    key: 'expedite',
    label: 'Expedite',
    description: 'Genuinely urgent but not an outage. Skips the CAB queue for a named set of expedited approvers, against a short SLA.',
    approval_mode: 'expedite',
    approval_sla_hours: 4,
    requires_backout: 1,
    requires_test_plan: 0,
    requires_implementation_plan: 1,
    pir_required_bands: ['high', 'critical'],
    mandatory_fields: ['title', 'description', 'implementation_plan', 'rollback_plan', 'justification'],
    allow_freeze_override: 0,
    lead_time_hours: 4,
  },
];

// Lazy per-workspace seed, the same approach emailService.js's
// ensureDefaultTemplates uses -- a workspace created before this shipped
// gets the full set on first read, with no migration script.
export function ensureDefaultChangeTypes(workspaceId) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM change_types WHERE workspace_id = ?').get(workspaceId);
  if (c > 0) return;
  DEFAULTS.forEach((t, i) => {
    db.prepare(
      `INSERT INTO change_types (id, workspace_id, key, label, description, approval_mode, approval_sla_hours,
         requires_backout, requires_test_plan, requires_implementation_plan, pir_required_bands, mandatory_fields,
         allow_freeze_override, lead_time_hours, sort_order)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      uid('chtype'), workspaceId, t.key, t.label, t.description, t.approval_mode, t.approval_sla_hours,
      t.requires_backout, t.requires_test_plan, t.requires_implementation_plan,
      JSON.stringify(t.pir_required_bands), JSON.stringify(t.mandatory_fields),
      t.allow_freeze_override, t.lead_time_hours, i
    );
  });
}

function parseJsonArray(value, fallback = []) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function hydrate(row) {
  if (!row) return null;
  return {
    ...row,
    pir_required_bands: parseJsonArray(row.pir_required_bands),
    mandatory_fields: parseJsonArray(row.mandatory_fields),
    requires_backout: !!row.requires_backout,
    requires_test_plan: !!row.requires_test_plan,
    requires_implementation_plan: !!row.requires_implementation_plan,
    allow_freeze_override: !!row.allow_freeze_override,
  };
}

export function listChangeTypes(workspaceId, { includeDisabled = false } = {}) {
  ensureDefaultChangeTypes(workspaceId);
  return db.prepare(
    `SELECT * FROM change_types WHERE workspace_id = ?${includeDisabled ? '' : ' AND enabled = 1'}
     ORDER BY sort_order ASC, label ASC`
  ).all(workspaceId).map(hydrate);
}

export function getChangeType(workspaceId, key) {
  ensureDefaultChangeTypes(workspaceId);
  return hydrate(db.prepare('SELECT * FROM change_types WHERE workspace_id = ? AND key = ?').get(workspaceId, key));
}

// Falls back to 'normal' for a change with no type set yet (or an unknown
// one) rather than returning null: every downstream guard needs *some*
// policy, and Normal is the safe default -- it demands the most.
export function effectiveChangeType(workspaceId, key) {
  return getChangeType(workspaceId, key) || getChangeType(workspaceId, 'normal');
}

export function mandatoryFieldsFor(workspaceId, key) {
  return effectiveChangeType(workspaceId, key)?.mandatory_fields || [];
}

export function requiresBackout(workspaceId, key) {
  return !!effectiveChangeType(workspaceId, key)?.requires_backout;
}

export function pirRequiredFor(workspaceId, key, riskBand) {
  const type = effectiveChangeType(workspaceId, key);
  if (!type) return false;
  return type.pir_required_bands.includes(riskBand);
}

export function slaHoursFor(workspaceId, key) {
  const hours = effectiveChangeType(workspaceId, key)?.approval_sla_hours;
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

export function allowsFreezeOverride(workspaceId, key) {
  return !!effectiveChangeType(workspaceId, key)?.allow_freeze_override;
}
