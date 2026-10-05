import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  CHANGE_STATES, currentState, canTransition, availableTransitions,
  transition, transitionHistory,
} from './changeWorkflow.js';
import { listChangeTypes } from './changeTypes.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  listChangeTypes(id); // materialize the default change types
  return id;
}

let seq = 0;
function newUser(workspaceId, name, role = 'agent') {
  const id = uid('usr');
  seq += 1;
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)').run(id, `${id}-${seq}@t.local`, name, 'x');
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, active) VALUES (?,?,?,?,1)').run(uid('wm'), workspaceId, id, role);
  return id;
}

// A change with everything the Normal type demands, so individual tests can
// remove exactly the one thing they are proving is required.
function newChange(workspaceId, fields = {}) {
  const requester = fields.requester_id || newUser(workspaceId, 'Requester', 'requester');
  const id = uid('tkt');
  const defaults = {
    change_type: 'normal',
    change_state: 'new',
    title: 'Patch the database cluster',
    description: 'Apply vendor security patches',
    category: 'Software',
    priority: 'medium',
    impact: 'medium',
    risk_band: 'medium',
    risk_score: 30,
    implementation_plan: '1. Drain node. 2. Patch. 3. Rejoin.',
    rollback_plan: '1. Restore snapshot. 2. Rejoin.',
    test_plan: 'Smoke test the read replica.',
    planned_start: '2026-12-01T22:00:00.000Z',
    planned_end: '2026-12-01T23:00:00.000Z',
    scheduled_start: null,
    scheduled_end: null,
    pir_required: 0,
  };
  const f = { ...defaults, ...fields };
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, category, priority, impact, status,
       requester_id, change_type, change_state, risk_band, risk_score, implementation_plan, rollback_plan, test_plan,
       planned_start, planned_end, scheduled_start, scheduled_end, pir_required)
     VALUES (?,?,?,'change',?,?,?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, workspaceId, `CHG-${id.slice(-6)}`, f.title, f.description, f.category, f.priority, f.impact,
    requester, f.change_type, f.change_state, f.risk_band, f.risk_score,
    f.implementation_plan, f.rollback_plan, f.test_plan,
    f.planned_start, f.planned_end, f.scheduled_start, f.scheduled_end, f.pir_required
  );
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

const reload = (id) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);

function approve(ticketId, { rejected = false } = {}) {
  db.prepare('INSERT INTO approvals (id, ticket_id, approver_role, step_order, status) VALUES (?,?,?,?,?)').run(
    uid('apr'), ticketId, 'admin', 1, rejected ? 'rejected' : 'approved'
  );
}

function reserveSlot(workspaceId, ticketId) {
  db.prepare('INSERT INTO change_calendar_slots (id, workspace_id, ticket_id, start_at, end_at) VALUES (?,?,?,?,?)').run(
    uid('ccs'), workspaceId, ticketId, '2026-12-01T22:00:00.000Z', '2026-12-01T23:00:00.000Z'
  );
  db.prepare('UPDATE tickets SET scheduled_start = ?, scheduled_end = ? WHERE id = ?').run(
    '2026-12-01T22:00:00.000Z', '2026-12-01T23:00:00.000Z', ticketId
  );
}

describe('changeWorkflow: state map', () => {
  test('all ten states from the flow diagram exist', () => {
    const expected = ['new', 'in_review', 'pending_approval', 'approved', 'scheduled', 'in_progress', 'implemented', 'rolled_back', 'closed', 'reopened'];
    assert.deepEqual(Object.keys(CHANGE_STATES), expected);
  });

  test('every state maps onto a real ticket status bucket', () => {
    const buckets = ['open', 'in_progress', 'on_hold', 'pending_approval', 'resolved', 'closed'];
    for (const [key, meta] of Object.entries(CHANGE_STATES)) {
      assert.ok(buckets.includes(meta.bucket), `${key} has bucket "${meta.bucket}"`);
    }
  });

  test('a change with no state reads as New rather than undefined', () => {
    assert.equal(currentState({ change_state: null }), 'new');
    assert.equal(currentState({}), 'new');
    assert.equal(currentState({ change_state: 'nonsense' }), 'new');
  });
});

describe('changeWorkflow: guards refuse', () => {
  test('New cannot move to In Review while a mandatory field is missing', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { rollback_plan: '' }); // Normal requires a backout plan
    const check = canTransition(ws, change, 'in_review');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /rollback_plan/);
  });

  test('In Review cannot move to Pending Approval before risk is assessed', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'in_review', risk_band: null });
    const check = canTransition(ws, change, 'pending_approval');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /[Rr]isk/);
  });

  test('Pending Approval cannot reach Approved with an approval still pending', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'pending_approval' });
    db.prepare("INSERT INTO approvals (id, ticket_id, approver_role, step_order, status) VALUES (?,?,?,?,'pending')").run(
      uid('apr'), change.id, 'admin', 1
    );
    const check = canTransition(ws, change, 'approved');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /pending/);
  });

  test('a rejected approval blocks Approved even once nothing is pending', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'pending_approval' });
    approve(change.id, { rejected: true });
    const check = canTransition(ws, change, 'approved');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /rejected/);
  });

  test('a change with no approvals at all cannot be Approved', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'pending_approval' });
    const check = canTransition(ws, change, 'approved');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /No approval/);
  });

  test('Approved cannot reach Scheduled without a reserved calendar slot', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'approved' });
    approve(change.id);
    const check = canTransition(ws, change, 'scheduled');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /schedul/i);
  });

  test('a scheduled window with no reservation row is still refused', () => {
    const ws = newWorkspace();
    const change = newChange(ws, {
      change_state: 'approved',
      scheduled_start: '2026-12-01T22:00:00.000Z',
      scheduled_end: '2026-12-01T23:00:00.000Z',
    });
    approve(change.id);
    const check = canTransition(ws, change, 'scheduled');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /calendar slot/);
  });

  // Business rule 7 from the diagram, the most important guard in the module.
  test('implementation cannot start without approval', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'scheduled' });
    reserveSlot(ws, change.id); // scheduled, but never approved
    const check = canTransition(ws, reload(change.id), 'in_progress');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /No approval/);
  });

  test('implementation cannot start without a schedule', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'scheduled' });
    approve(change.id); // approved, but never scheduled
    const check = canTransition(ws, change, 'in_progress');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /schedul/i);
  });

  // Business rule 8: mandatory backout plan for Normal / Emergency / Expedite.
  test('implementation cannot start without a backout plan on a Normal change', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'scheduled', rollback_plan: '' });
    approve(change.id);
    reserveSlot(ws, change.id);
    const check = canTransition(ws, reload(change.id), 'in_progress');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /backout plan/);
  });

  test('a Standard change needs no backout plan to start', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_type: 'standard', change_state: 'scheduled', rollback_plan: '' });
    approve(change.id);
    reserveSlot(ws, change.id);
    const check = canTransition(ws, reload(change.id), 'in_progress');
    assert.equal(check.allowed, true, JSON.stringify(check.blockers));
  });

  test('In Progress cannot reach Implemented with open implementation tasks', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'in_progress' });
    db.prepare('INSERT INTO ticket_tasks (id, ticket_id, workspace_id, title, status) VALUES (?,?,?,?,?)').run(
      uid('tsk'), change.id, ws, 'Drain the node', 'open'
    );
    const check = canTransition(ws, change, 'implemented');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /task/);
  });

  test('completed tasks do not block Implemented', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'in_progress' });
    db.prepare('INSERT INTO ticket_tasks (id, ticket_id, workspace_id, title, status) VALUES (?,?,?,?,?)').run(
      uid('tsk'), change.id, ws, 'Drain the node', 'done'
    );
    assert.equal(canTransition(ws, change, 'implemented').allowed, true);
  });

  // Business rule 9: PIR required for high / critical.
  test('a high-risk change cannot be Closed without a completed PIR', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'implemented', risk_band: 'high', closure_approved_by: null });
    db.prepare('UPDATE tickets SET closure_approved_by = ? WHERE id = ?').run(newUser(ws, 'Manager', 'admin'), change.id);
    const check = canTransition(ws, reload(change.id), 'closed');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /post-implementation review/i);
  });

  test('an started-but-unfinished PIR still blocks closure', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'implemented', risk_band: 'critical' });
    db.prepare('UPDATE tickets SET closure_approved_by = ? WHERE id = ?').run(newUser(ws, 'Manager', 'admin'), change.id);
    db.prepare('INSERT INTO change_pir (id, workspace_id, ticket_id, outcome) VALUES (?,?,?,?)').run(
      uid('pir'), ws, change.id, 'successful'
    );
    const check = canTransition(ws, reload(change.id), 'closed');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /not been completed/);
  });

  test('a low-risk Normal change needs no PIR, only closure approval', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'implemented', risk_band: 'low' });
    // Closure approval still missing at this point.
    let check = canTransition(ws, change, 'closed');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /[Cc]losure/);

    db.prepare('UPDATE tickets SET closure_approved_by = ? WHERE id = ?').run(newUser(ws, 'Manager', 'admin'), change.id);
    check = canTransition(ws, reload(change.id), 'closed');
    assert.equal(check.allowed, true, JSON.stringify(check.blockers));
  });

  test('an Emergency change always needs a PIR, even at low risk', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_type: 'emergency', change_state: 'implemented', risk_band: 'low' });
    db.prepare('UPDATE tickets SET closure_approved_by = ? WHERE id = ?').run(newUser(ws, 'Manager', 'admin'), change.id);
    const check = canTransition(ws, reload(change.id), 'closed');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /post-implementation review/i);
  });
});

describe('changeWorkflow: illegal edges', () => {
  test('a change cannot skip from New straight to In Progress', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    const check = canTransition(ws, change, 'in_progress');
    assert.equal(check.allowed, false);
    assert.match(check.blockers[0], /cannot move from New/);
  });

  test('a Closed change is terminal', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'closed' });
    assert.deepEqual(availableTransitions(ws, change), []);
    assert.equal(canTransition(ws, change, 'in_progress').allowed, false);
  });

  test('availableTransitions reports each option with its blockers', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'scheduled' });
    const options = availableTransitions(ws, change);
    const start = options.find((o) => o.to === 'in_progress');
    assert.ok(start, 'starting implementation should be offered');
    assert.equal(start.allowed, false);
    assert.ok(start.blockers.length > 0, 'and should explain why it is blocked');
    // Releasing the slot has no guards, so it is always legal from here.
    assert.equal(options.find((o) => o.to === 'approved').allowed, true);
  });
});

describe('changeWorkflow: transition side effects', () => {
  test('a transition syncs ticket.status to the state bucket', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    const result = transition(ws, change.id, 'in_review');
    assert.equal(result.ok, true);

    const after = reload(change.id);
    assert.equal(after.change_state, 'in_review');
    assert.equal(after.status, CHANGE_STATES.in_review.bucket);
  });

  test('status follows the bucket through the whole happy path', () => {
    const ws = newWorkspace();
    const actor = { id: newUser(ws, 'Change Manager', 'admin'), name: 'Change Manager' };
    const change = newChange(ws);

    assert.equal(transition(ws, change.id, 'in_review', { actor }).ok, true);
    assert.equal(transition(ws, change.id, 'pending_approval', { actor }).ok, true);
    assert.equal(reload(change.id).status, 'pending_approval');

    approve(change.id);
    assert.equal(transition(ws, change.id, 'approved', { actor }).ok, true);

    reserveSlot(ws, change.id);
    assert.equal(transition(ws, change.id, 'scheduled', { actor }).ok, true);
    assert.equal(transition(ws, change.id, 'in_progress', { actor }).ok, true);

    let after = reload(change.id);
    assert.equal(after.status, 'in_progress');
    assert.ok(after.actual_start, 'starting implementation stamps actual_start');

    assert.equal(transition(ws, change.id, 'implemented', { actor }).ok, true);
    after = reload(change.id);
    assert.ok(after.actual_end, 'completing stamps actual_end');

    db.prepare('UPDATE tickets SET closure_approved_by = ? WHERE id = ?').run(actor.id, change.id);
    assert.equal(transition(ws, change.id, 'closed', { actor }).ok, true);
    after = reload(change.id);
    assert.equal(after.status, 'closed');
    assert.ok(after.closed_at);
  });

  test('every transition writes exactly one audit row', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    transition(ws, change.id, 'in_review');
    transition(ws, change.id, 'pending_approval');

    const history = transitionHistory(change.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].to_state, 'pending_approval');
    assert.equal(history[0].from_state, 'in_review');
    assert.equal(history[1].from_state, 'new');
  });

  test('the audit row records the actor and reason', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    transition(ws, change.id, 'in_review', { actor: { id: 'usr_x', name: 'Ada' }, reason: 'Plans complete' });
    const [row] = transitionHistory(change.id);
    assert.equal(row.actor_name, 'Ada');
    assert.equal(row.reason, 'Plans complete');
  });

  test('a blocked transition changes nothing and writes no audit row', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'scheduled' });
    const result = transition(ws, change.id, 'in_progress');
    assert.equal(result.ok, false);
    assert.ok(result.blockers.length > 0);

    assert.equal(reload(change.id).change_state, 'scheduled');
    assert.equal(transitionHistory(change.id).length, 0);
  });

  test('force overrides a guard but records what it overrode', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'scheduled' });
    const result = transition(ws, change.id, 'in_progress', { force: true, actor: { id: 'u', name: 'Admin' }, reason: 'Stuck record' });
    assert.equal(result.ok, true);
    assert.equal(result.forced, true);

    const [row] = transitionHistory(change.id);
    assert.equal(row.guards.forced, true);
    assert.ok(row.guards.overridden_blockers.length > 0, 'the overridden blockers are preserved');
  });

  test('transitioning to the same state is a no-op, not an error', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'in_review' });
    const result = transition(ws, change.id, 'in_review');
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(transitionHistory(change.id).length, 0);
  });

  test('an unknown state is rejected', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    const result = transition(ws, change.id, 'teleported');
    assert.equal(result.ok, false);
    assert.match(result.error, /Unknown change state/);
  });

  test('a non-change ticket cannot be driven through this machine', () => {
    const ws = newWorkspace();
    const requester = newUser(ws, 'R', 'requester');
    const id = uid('tkt');
    db.prepare(
      `INSERT INTO tickets (id, workspace_id, number, type, title, status, requester_id) VALUES (?,?,?,'incident',?,'open',?)`
    ).run(id, ws, 'INC-1', 'Not a change', requester);
    const result = transition(ws, id, 'in_review');
    assert.equal(result.ok, false);
    assert.match(result.error, /not a change/);
  });

  test('a change in another workspace is not reachable', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    const change = newChange(wsA);
    const result = transition(wsB, change.id, 'in_review');
    assert.equal(result.ok, false);
    assert.match(result.error, /not found/i);
  });

  test('the rollback and reopen paths are available where the diagram says', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'in_progress' });
    assert.equal(transition(ws, change.id, 'rolled_back', { reason: 'Patch failed' }).ok, true);
    assert.equal(reload(change.id).change_state, 'rolled_back');
    assert.equal(transition(ws, change.id, 'reopened').ok, true);
    assert.equal(reload(change.id).change_state, 'reopened');
    // Reopened can be re-scheduled or resumed.
    const options = availableTransitions(ws, reload(change.id)).map((o) => o.to);
    assert.ok(options.includes('scheduled') && options.includes('in_progress'));
  });

  test('legacy cab_status is kept meaningful for anything still reading it', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { change_state: 'in_review' });
    transition(ws, change.id, 'pending_approval');
    assert.equal(reload(change.id).cab_status, 'pending');
    approve(change.id);
    transition(ws, change.id, 'approved');
    assert.equal(reload(change.id).cab_status, 'approved');
  });
});
