// Ticket Lifecycle engine: an admin-defined state machine per ticket_type,
// opt-in and additive (see db.js for the schema rationale). A ticket type
// with no enabled lifecycle behaves exactly as before -- callers must check
// getLifecycle() returns non-null before treating a type as lifecycle-governed.
import { db, uid } from '../db.js';

const ROLE_RANK = { requester: 0, agent: 1, admin: 2 };
// `userPermissions`/`ticketType` are optional so every other caller (nothing
// else in this app checks a lifecycle gate outside tickets) keeps working
// unchanged. When given, a transition gated to e.g. requires_role: 'admin'
// is ALSO satisfied by holding `${ticketType}.manage` (incident_manager /
// problem_manager / change_manager, seeded as custom_roles permission
// bundles) even at base role 'agent' -- this is what gives a Change Manager
// persona authority over CAB-gated transitions without needing full admin,
// purely additive: it only ever grants access a rank check alone would have
// refused, never revokes anything the rank check already allowed.
export function roleSatisfies(userRole, requiredRole, userPermissions, ticketType) {
  if (!requiredRole) return true;
  if (ticketType && userPermissions?.includes(`${ticketType}.manage`)) return true;
  return (ROLE_RANK[userRole] ?? -1) >= (ROLE_RANK[requiredRole] ?? 99);
}

function matchCondition(actual, operator, expected) {
  const a = actual === undefined || actual === null ? '' : actual;
  switch (operator) {
    case 'equals': return String(a) === String(expected ?? '');
    case 'not_equals': return String(a) !== String(expected ?? '');
    case 'is_empty': return String(a).trim() === '';
    case 'is_not_empty': return String(a).trim() !== '';
    default: return true;
  }
}

function gateDescription(transition) {
  const opLabel = { equals: 'is', not_equals: 'is not', is_empty: 'is empty', is_not_empty: 'is set' }[transition.condition_operator] || transition.condition_operator;
  const needsValue = transition.condition_operator === 'equals' || transition.condition_operator === 'not_equals';
  return `requires ${transition.condition_field} ${opLabel}${needsValue ? ` "${transition.condition_value}"` : ''}`;
}

// ---- Reads ----

export function getLifecycle(workspaceId, ticketType) {
  const lifecycle = db.prepare(
    'SELECT * FROM ticket_lifecycles WHERE workspace_id = ? AND ticket_type = ? AND enabled = 1'
  ).get(workspaceId, ticketType);
  if (!lifecycle) return null;
  const stages = db.prepare('SELECT * FROM lifecycle_stages WHERE lifecycle_id = ? ORDER BY sort_order ASC').all(lifecycle.id);
  const transitions = db.prepare('SELECT * FROM lifecycle_transitions WHERE lifecycle_id = ?').all(lifecycle.id);
  return { ...lifecycle, stages, transitions };
}

// Includes disabled lifecycles too -- used by the admin designer, which needs
// to show/edit a lifecycle even while it's toggled off.
export function getLifecycleForAdmin(workspaceId, ticketType) {
  const lifecycle = db.prepare('SELECT * FROM ticket_lifecycles WHERE workspace_id = ? AND ticket_type = ?').get(workspaceId, ticketType);
  if (!lifecycle) return null;
  const stages = db.prepare('SELECT * FROM lifecycle_stages WHERE lifecycle_id = ? ORDER BY sort_order ASC').all(lifecycle.id);
  const transitions = db.prepare('SELECT * FROM lifecycle_transitions WHERE lifecycle_id = ?').all(lifecycle.id);
  return { ...lifecycle, stages, transitions };
}

export function listLifecycleSummaries(workspaceId) {
  const rows = db.prepare('SELECT * FROM ticket_lifecycles WHERE workspace_id = ?').all(workspaceId);
  return rows.map((lc) => {
    const stageCount = db.prepare('SELECT COUNT(*) c FROM lifecycle_stages WHERE lifecycle_id = ?').get(lc.id).c;
    return { ...lc, stageCount };
  });
}

// The stage a ticket is effectively in right now. Falls back to matching the
// ticket's current status bucket for legacy tickets (created before this
// type had a lifecycle, or before this ticket was last touched) so nothing
// gets stranded when an admin turns a lifecycle on after the fact.
function effectiveStage(lifecycle, ticket) {
  const byKey = lifecycle.stages.find((s) => s.key === ticket.lifecycle_stage);
  if (byKey) return byKey;
  const byBucket = lifecycle.stages.find((s) => s.bucket === ticket.status);
  if (byBucket) return byBucket;
  return lifecycle.stages[0] || null;
}

// What TicketDetail needs to render: the full stage list, which one the
// ticket is in, and every transition out of it annotated with whether the
// viewing user could actually perform it right now (and why not, if not).
export function describeAvailableTransitions(workspaceId, ticket, user) {
  const lifecycle = getLifecycle(workspaceId, ticket.type);
  if (!lifecycle) return null;
  const current = effectiveStage(lifecycle, ticket);
  const options = current
    ? lifecycle.transitions
        .filter((t) => t.from_stage_id === current.id)
        .map((t) => {
          const stage = lifecycle.stages.find((s) => s.id === t.to_stage_id);
          if (!roleSatisfies(user.role, t.requires_role, user.permissions, ticket.type)) {
            return { stage, allowed: false, reason: `requires ${t.requires_role} role` };
          }
          if (t.condition_field && !matchCondition(ticket[t.condition_field], t.condition_operator, t.condition_value)) {
            return { stage, allowed: false, reason: gateDescription(t) };
          }
          return { stage, allowed: true, reason: null };
        })
    : [];
  return {
    stages: lifecycle.stages,
    currentStage: current?.key || null,
    isTerminal: !!current?.is_terminal,
    availableTransitions: options,
  };
}

// The stage a brand-new ticket of this type should start in, or null if the
// type has no enabled lifecycle (caller keeps today's default status).
export function initialStageFor(workspaceId, ticketType) {
  const lifecycle = getLifecycle(workspaceId, ticketType);
  if (!lifecycle || !lifecycle.stages.length) return null;
  return lifecycle.stages[0];
}

// Finds the first configured stage matching a given status bucket, for
// system-initiated moves that aren't a normal user-driven transition click
// (approvals clearing, a requester's self-service reopen) -- these don't go
// through transitionTicket's role/condition gate since nothing about them is
// user-choosable, but they still need to keep lifecycle_stage in sync with
// status so effectiveStage() doesn't keep resolving a stale stage afterward.
// Returns null if the type has no active lifecycle (caller then just sets
// status as it always did, unaffected).
export function stageForBucket(workspaceId, ticketType, bucket) {
  const lifecycle = getLifecycle(workspaceId, ticketType);
  if (!lifecycle) return null;
  return lifecycle.stages.find((s) => s.bucket === bucket) || null;
}

// ---- The actual transition, enforced server-side ----

export function transitionTicket(workspaceId, ticket, toStageKey, user) {
  const lifecycle = getLifecycle(workspaceId, ticket.type);
  if (!lifecycle) throw new Error('This ticket type has no active lifecycle configured.');
  const from = effectiveStage(lifecycle, ticket);
  if (!from) throw new Error('This lifecycle has no stages configured yet.');
  const to = lifecycle.stages.find((s) => s.key === toStageKey);
  if (!to) throw new Error('Unknown target stage.');
  if (from.id === to.id) throw new Error(`Already in "${from.label}".`);

  const transition = lifecycle.transitions.find((t) => t.from_stage_id === from.id && t.to_stage_id === to.id);
  if (!transition) throw new Error(`"${from.label}" cannot move directly to "${to.label}".`);
  if (!roleSatisfies(user.role, transition.requires_role, user.permissions, ticket.type)) {
    throw new Error(`Only ${transition.requires_role}s can move a ticket from "${from.label}" to "${to.label}".`);
  }
  if (transition.condition_field && !matchCondition(ticket[transition.condition_field], transition.condition_operator, transition.condition_value)) {
    throw new Error(`Cannot move to "${to.label}" yet — ${gateDescription(transition)}.`);
  }

  const extraStamps = [];
  if (to.bucket === 'resolved') extraStamps.push("resolved_at = COALESCE(resolved_at, datetime('now'))");
  if (to.bucket === 'closed') extraStamps.push("closed_at = COALESCE(closed_at, datetime('now'))");
  db.prepare(
    `UPDATE tickets SET lifecycle_stage = ?, status = ?, updated_at = datetime('now')${extraStamps.length ? ', ' + extraStamps.join(', ') : ''} WHERE id = ?`
  ).run(to.key, to.bucket, ticket.id);

  return { fromStage: from, toStage: to };
}

// ---- Admin configuration (create/edit lifecycle, stages, transitions) ----

// Templates a workspace can seed from when first enabling a type's lifecycle.
// Change's is the "expert" one from the roadmap: full stage model, a CAB
// gate that can't be bypassed, and an admin-only approval step. The other
// three are simpler defaults that mirror today's plain status list (or, for
// Problem, the KEDB-oriented lifecycle already scoped for that phase) so
// turning a lifecycle on doesn't feel like a regression for common cases.
export const LIFECYCLE_TEMPLATES = {
  incident: {
    stages: [
      { key: 'open', label: 'Open', bucket: 'open' },
      { key: 'in_progress', label: 'In Progress', bucket: 'in_progress' },
      { key: 'on_hold', label: 'On Hold', bucket: 'on_hold' },
      { key: 'resolved', label: 'Resolved', bucket: 'resolved' },
      { key: 'closed', label: 'Closed', bucket: 'closed', is_terminal: true },
    ],
    transitions: [
      ['open', 'in_progress'], ['in_progress', 'on_hold'], ['on_hold', 'in_progress'],
      ['in_progress', 'resolved'], ['on_hold', 'resolved'], ['resolved', 'in_progress'],
      ['resolved', 'closed'],
    ],
  },
  request: {
    // 'open' stays stages[0] -- initialStageFor() always starts a brand-new
    // ticket there, and a plain (non-catalog) request has no approval step.
    // 'pending_approval' is never reached via that default -- only a catalog
    // submission with approval_required stamps a ticket into it directly
    // (routes/catalog.js), and resolveTicketAfterApprovalChange
    // (services/approvalEngine.js) moves it back to 'open' once every
    // approval on the ticket clears -- both system-driven, not a normal
    // transition click, so there's no requires_role on this edge.
    stages: [
      { key: 'open', label: 'Open', bucket: 'open' },
      { key: 'pending_approval', label: 'Pending Approval', bucket: 'on_hold' },
      { key: 'in_progress', label: 'In Progress', bucket: 'in_progress' },
      { key: 'on_hold', label: 'On Hold', bucket: 'on_hold' },
      { key: 'resolved', label: 'Fulfilled', bucket: 'resolved' },
      { key: 'closed', label: 'Closed', bucket: 'closed', is_terminal: true },
    ],
    transitions: [
      ['pending_approval', 'open'],
      ['open', 'in_progress'], ['in_progress', 'on_hold'], ['on_hold', 'in_progress'],
      ['in_progress', 'resolved'], ['resolved', 'closed'],
    ],
  },
  problem: {
    // Mirrors the Problem Lifecycle phase of the roadmap: Detected -> ... -> Closed.
    stages: [
      { key: 'detected', label: 'Detected', bucket: 'open' },
      { key: 'investigating', label: 'Investigating', bucket: 'open' },
      { key: 'known_error', label: 'Known Error', bucket: 'open' },
      { key: 'fix_scheduled', label: 'Fix Scheduled', bucket: 'in_progress' },
      { key: 'resolved', label: 'Resolved', bucket: 'resolved' },
      { key: 'closed', label: 'Closed', bucket: 'closed', is_terminal: true },
    ],
    transitions: [
      ['detected', 'investigating'],
      ['investigating', 'known_error'],
      ['investigating', 'resolved'],
      ['known_error', 'fix_scheduled'],
      ['fix_scheduled', 'resolved'],
      ['resolved', 'investigating'],
      ['resolved', 'closed'],
    ],
  },
  // Expert-level Change lifecycle: full CAB-gated stage model. The gate on
  // cab_review -> scheduled reuses the existing cab_status field/approval
  // flow (server/src/routes/approvals.js) rather than introducing a second
  // approval mechanism -- CAB still approves the same way it does today,
  // this just refuses to let the ticket move on until that happens.
  change: {
    stages: [
      { key: 'draft', label: 'Draft', bucket: 'open' },
      { key: 'risk_assessment', label: 'Risk Assessment', bucket: 'open' },
      { key: 'cab_review', label: 'CAB Review', bucket: 'open' },
      { key: 'scheduled', label: 'Scheduled', bucket: 'open' },
      { key: 'implementation', label: 'Implementation', bucket: 'in_progress' },
      { key: 'post_implementation_review', label: 'Post-Implementation Review', bucket: 'in_progress' },
      { key: 'closed', label: 'Closed', bucket: 'closed', is_terminal: true },
    ],
    transitions: [
      ['draft', 'risk_assessment', { requires_role: 'agent' }],
      ['risk_assessment', 'cab_review', { requires_role: 'agent' }],
      ['cab_review', 'draft', { requires_role: 'admin' }], // sent back for rework
      ['cab_review', 'scheduled', { requires_role: 'admin', condition_field: 'cab_status', condition_operator: 'equals', condition_value: 'approved' }],
      ['scheduled', 'implementation', { requires_role: 'agent' }],
      ['implementation', 'post_implementation_review', { requires_role: 'agent' }],
      ['post_implementation_review', 'closed', { requires_role: 'agent' }],
    ],
  },
};

export function createLifecycle(workspaceId, ticketType, useTemplate) {
  const existing = db.prepare('SELECT id FROM ticket_lifecycles WHERE workspace_id = ? AND ticket_type = ?').get(workspaceId, ticketType);
  if (existing) throw new Error('A lifecycle already exists for this ticket type — edit or delete it first.');
  const id = uid('lc');
  db.prepare('INSERT INTO ticket_lifecycles (id, workspace_id, ticket_type) VALUES (?,?,?)').run(id, workspaceId, ticketType);
  if (useTemplate) seedTemplate(id, ticketType);
  return id;
}

export function seedTemplate(lifecycleId, ticketType) {
  const template = LIFECYCLE_TEMPLATES[ticketType];
  if (!template) return;
  db.prepare('DELETE FROM lifecycle_stages WHERE lifecycle_id = ?').run(lifecycleId); // cascades transitions too
  const stageIdByKey = {};
  template.stages.forEach((s, i) => {
    const stageId = uid('lcs');
    stageIdByKey[s.key] = stageId;
    db.prepare(
      'INSERT INTO lifecycle_stages (id, lifecycle_id, key, label, bucket, is_terminal, sort_order) VALUES (?,?,?,?,?,?,?)'
    ).run(stageId, lifecycleId, s.key, s.label, s.bucket, s.is_terminal ? 1 : 0, i);
  });
  for (const [fromKey, toKey, opts = {}] of template.transitions) {
    db.prepare(
      'INSERT INTO lifecycle_transitions (id, lifecycle_id, from_stage_id, to_stage_id, requires_role, condition_field, condition_operator, condition_value) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      uid('lct'), lifecycleId, stageIdByKey[fromKey], stageIdByKey[toKey],
      opts.requires_role || null, opts.condition_field || null, opts.condition_operator || null, opts.condition_value || null
    );
  }
  db.prepare("UPDATE ticket_lifecycles SET updated_at = datetime('now') WHERE id = ?").run(lifecycleId);
}
