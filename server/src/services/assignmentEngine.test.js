import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { findAssignmentPolicy, scoreCandidates, decideAssignment, autoAssign, parseSonaVerdict } from './assignmentEngine.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

let seq = 0;
function newAgent(workspaceId, name, { role = 'agent', active = 1, team = null } = {}) {
  const id = uid('usr');
  seq += 1;
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)').run(
    id, `${id}-${seq}@test.local`, name, 'x'
  );
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, active, team) VALUES (?,?,?,?,?,?)').run(
    uid('wm'), workspaceId, id, role, active, team
  );
  return id;
}

function newPolicy(workspaceId, opts = {}) {
  const {
    name = 'Policy', strategy = 'least_loaded', candidate_source = 'group',
    candidate_group_id = null, candidate_schedule_id = null,
    respect_presence = 0, respect_oncall = 0, respect_status = 1, respect_capacity = 1,
    ai_enabled = 0, fallback_strategy = 'least_loaded',
    match_type = null, match_priority = null, match_team = null, match_category = null,
    enabled = 1,
  } = opts;
  const id = uid('asp');
  db.prepare(
    `INSERT INTO assignment_policies (id, workspace_id, name, enabled, match_type, match_priority, match_team, match_category,
       strategy, candidate_source, candidate_group_id, candidate_schedule_id,
       respect_presence, respect_oncall, respect_status, respect_capacity, ai_enabled, fallback_strategy)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, workspaceId, name, enabled, match_type, match_priority, match_team, match_category,
    strategy, candidate_source, candidate_group_id, candidate_schedule_id,
    respect_presence, respect_oncall, respect_status, respect_capacity, ai_enabled, fallback_strategy);
  return db.prepare('SELECT * FROM assignment_policies WHERE id = ?').get(id);
}

function setAvailability(workspaceId, userId, fields = {}) {
  const { status = 'available', max_concurrent_tickets = 10, skills = null } = fields;
  db.prepare(
    'INSERT INTO agent_availability (id, workspace_id, user_id, status, max_concurrent_tickets, skills) VALUES (?,?,?,?,?,?)'
  ).run(uid('aav'), workspaceId, userId, status, max_concurrent_tickets, skills ? JSON.stringify(skills) : null);
}

function giveOpenTickets(workspaceId, userId, count) {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      `INSERT INTO tickets (id, workspace_id, number, type, title, description, priority, status, requester_id, assignee_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(uid('tkt'), workspaceId, `T-${uid('n')}`, 'incident', 'Load filler', '', 'medium', 'open', userId, userId);
  }
}

// tickets.requester_id is a real foreign key, so every test ticket needs an
// actual user behind it -- one requester per workspace is enough.
const requesterCache = new Map();
function requesterFor(workspaceId) {
  if (!requesterCache.has(workspaceId)) {
    requesterCache.set(workspaceId, newAgent(workspaceId, 'Requester', { role: 'requester' }));
  }
  return requesterCache.get(workspaceId);
}

function makeTicket(workspaceId, fields = {}) {
  const { type = 'incident', priority = 'medium', team = null, category = null, title = 'Printer offline', description = '' } = fields;
  const id = uid('tkt');
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, priority, status, team, category, requester_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, workspaceId, `T-${id}`, type, title, description, priority, 'open', team, category, requesterFor(workspaceId));
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

describe('assignmentEngine: findAssignmentPolicy', () => {
  test('the most specific matching policy wins', () => {
    const ws = newWorkspace();
    newPolicy(ws, { name: 'catch-all' });
    const specific = newPolicy(ws, { name: 'critical incidents', match_type: 'incident', match_priority: 'critical' });

    const found = findAssignmentPolicy(ws, { type: 'incident', priority: 'critical' });
    assert.equal(found.id, specific.id);
  });

  test('a policy whose match column disagrees is skipped entirely', () => {
    const ws = newWorkspace();
    const catchAll = newPolicy(ws, { name: 'catch-all' });
    newPolicy(ws, { name: 'changes only', match_type: 'change' });

    assert.equal(findAssignmentPolicy(ws, { type: 'incident' }).id, catchAll.id);
  });

  test('a disabled policy never matches', () => {
    const ws = newWorkspace();
    newPolicy(ws, { name: 'off', enabled: 0 });
    assert.equal(findAssignmentPolicy(ws, { type: 'incident' }), null);
  });

  test('policies are scoped to their own workspace', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    newPolicy(wsA, { name: 'A only' });
    assert.equal(findAssignmentPolicy(wsB, { type: 'incident' }), null);
  });
});

describe('assignmentEngine: hard availability filters', () => {
  test('do-not-disturb blocks a candidate when respect_status is on', () => {
    const ws = newWorkspace();
    const busy = newAgent(ws, 'Dnd');
    setAvailability(ws, busy, { status: 'dnd' });
    const policy = newPolicy(ws, { respect_status: 1 });

    const [c] = scoreCandidates(policy, ws);
    assert.equal(c.eligible, false);
    assert.deepEqual(c.blocked, ['Do not disturb']);
  });

  test('do-not-disturb is ignored when respect_status is off', () => {
    const ws = newWorkspace();
    const busy = newAgent(ws, 'Dnd');
    setAvailability(ws, busy, { status: 'dnd' });
    const policy = newPolicy(ws, { respect_status: 0 });

    const [c] = scoreCandidates(policy, ws);
    assert.equal(c.eligible, true);
  });

  test('active time off blocks a candidate regardless of policy flags', () => {
    const ws = newWorkspace();
    const away = newAgent(ws, 'Away');
    db.prepare('INSERT INTO agent_time_off (id, workspace_id, user_id, start_at, end_at, reason) VALUES (?,?,?,?,?,?)').run(
      uid('ato'), ws, away,
      new Date(Date.now() - 3600_000).toISOString(),
      new Date(Date.now() + 3600_000).toISOString(),
      'Annual leave'
    );
    const policy = newPolicy(ws, { respect_status: 0, respect_capacity: 0 });

    const [c] = scoreCandidates(policy, ws);
    assert.equal(c.eligible, false);
    assert.deepEqual(c.blocked, ['On time off']);
  });

  test('time off that has already ended does not block', () => {
    const ws = newWorkspace();
    const back = newAgent(ws, 'Back');
    db.prepare('INSERT INTO agent_time_off (id, workspace_id, user_id, start_at, end_at) VALUES (?,?,?,?,?)').run(
      uid('ato'), ws, back,
      new Date(Date.now() - 7200_000).toISOString(),
      new Date(Date.now() - 3600_000).toISOString()
    );
    const policy = newPolicy(ws);
    const [c] = scoreCandidates(policy, ws);
    assert.equal(c.eligible, true);
  });

  test('an agent at capacity is blocked, and one below it is not', () => {
    const ws = newWorkspace();
    const full = newAgent(ws, 'Full');
    const spare = newAgent(ws, 'Spare');
    setAvailability(ws, full, { max_concurrent_tickets: 2 });
    setAvailability(ws, spare, { max_concurrent_tickets: 5 });
    giveOpenTickets(ws, full, 2);
    giveOpenTickets(ws, spare, 1);

    const policy = newPolicy(ws, { respect_capacity: 1 });
    const byId = Object.fromEntries(scoreCandidates(policy, ws).map((c) => [c.user_id, c]));
    assert.equal(byId[full].eligible, false);
    assert.match(byId[full].blocked[0], /At capacity \(2\/2\)/);
    assert.equal(byId[spare].eligible, true);
  });

  test('resolved and closed tickets do not count against capacity', () => {
    const ws = newWorkspace();
    const agent = newAgent(ws, 'Agent');
    setAvailability(ws, agent, { max_concurrent_tickets: 1 });
    db.prepare(
      `INSERT INTO tickets (id, workspace_id, number, type, title, description, priority, status, requester_id, assignee_id)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(uid('tkt'), ws, 'T-done', 'incident', 'Done', '', 'low', 'closed', agent, agent);

    const [c] = scoreCandidates(newPolicy(ws), ws);
    assert.equal(c.open_tickets, 0);
    assert.equal(c.eligible, true);
  });

  test('requesters and deactivated members are never candidates', () => {
    const ws = newWorkspace();
    newAgent(ws, 'Requester', { role: 'requester' });
    newAgent(ws, 'Deactivated', { active: 0 });
    const real = newAgent(ws, 'Real');

    const candidates = scoreCandidates(newPolicy(ws), ws);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].user_id, real);
  });

  test('respect_oncall blocks everyone not currently holding a rotation', () => {
    const ws = newWorkspace();
    const onCall = newAgent(ws, 'OnCall');
    const offCall = newAgent(ws, 'OffCall');

    const sched = uid('ocs');
    db.prepare('INSERT INTO oncall_schedules (id, workspace_id, name, timezone) VALUES (?,?,?,?)').run(sched, ws, 'Primary', 'UTC');
    const layer = uid('ocl');
    // Started well in the past with a single member, so that member is
    // unambiguously on call right now regardless of when this test runs.
    db.prepare(
      `INSERT INTO oncall_layers (id, schedule_id, layer_order, name, rotation_type, rotation_length_days, handoff_time, start_date)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(layer, sched, 1, 'Primary', 'weekly', 7, '00:00', '2020-01-06');
    db.prepare('INSERT INTO oncall_layer_members (id, layer_id, user_id, member_order) VALUES (?,?,?,?)').run(
      uid('oclm'), layer, onCall, 1
    );

    const policy = newPolicy(ws, { respect_oncall: 1 });
    const byId = Object.fromEntries(scoreCandidates(policy, ws).map((c) => [c.user_id, c]));
    assert.equal(byId[onCall].eligible, true);
    assert.equal(byId[onCall].on_call, true);
    assert.equal(byId[offCall].eligible, false);
    assert.deepEqual(byId[offCall].blocked, ['Not on call']);
  });
});

describe('assignmentEngine: strategies', () => {
  test('least_loaded picks the agent with the fewest open tickets', async () => {
    const ws = newWorkspace();
    const heavy = newAgent(ws, 'Heavy');
    const light = newAgent(ws, 'Light');
    giveOpenTickets(ws, heavy, 4);
    giveOpenTickets(ws, light, 1);
    newPolicy(ws, { strategy: 'least_loaded' });

    const decision = await decideAssignment(ws, makeTicket(ws));
    assert.equal(decision.chosen.user_id, light);
    assert.equal(decision.aiUsed, false);
    assert.equal(decision.strategyUsed, 'least_loaded');
  });

  test('round_robin spreads consecutive tickets across the roster', async () => {
    const ws = newWorkspace();
    const a = newAgent(ws, 'Ana');
    const b = newAgent(ws, 'Bo');
    newPolicy(ws, { strategy: 'round_robin' });

    // Three tickets in a row must not all land on one person.
    const picked = [];
    for (let i = 0; i < 3; i += 1) {
      const ticket = makeTicket(ws);
      // eslint-disable-next-line no-await-in-loop
      const result = await autoAssign(ticket);
      picked.push(result.userId);
    }
    assert.ok(picked.includes(a) && picked.includes(b), `expected both agents to be used, got ${JSON.stringify(picked)}`);
  });

  test('oncall_first prefers the on-call agent even when they are busier', async () => {
    const ws = newWorkspace();
    const onCall = newAgent(ws, 'OnCall');
    const idle = newAgent(ws, 'Idle');
    giveOpenTickets(ws, onCall, 3);

    const sched = uid('ocs');
    db.prepare('INSERT INTO oncall_schedules (id, workspace_id, name, timezone) VALUES (?,?,?,?)').run(sched, ws, 'Primary', 'UTC');
    const layer = uid('ocl');
    db.prepare(
      `INSERT INTO oncall_layers (id, schedule_id, layer_order, name, rotation_type, rotation_length_days, handoff_time, start_date)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(layer, sched, 1, 'Primary', 'weekly', 7, '00:00', '2020-01-06');
    db.prepare('INSERT INTO oncall_layer_members (id, layer_id, user_id, member_order) VALUES (?,?,?,?)').run(
      uid('oclm'), layer, onCall, 1
    );

    newPolicy(ws, { strategy: 'oncall_first' });
    const decision = await decideAssignment(ws, makeTicket(ws));
    assert.equal(decision.chosen.user_id, onCall);
    assert.notEqual(decision.chosen.user_id, idle);
  });

  test('no matching policy assigns nobody, and says so', async () => {
    const ws = newWorkspace();
    newAgent(ws, 'Ana');
    const decision = await decideAssignment(ws, makeTicket(ws));
    assert.equal(decision.chosen, null);
    assert.match(decision.rationale, /No assignment policy/);
  });

  test('when every candidate is filtered out, nobody is assigned and the reason is recorded', async () => {
    const ws = newWorkspace();
    const blocked = newAgent(ws, 'Blocked');
    setAvailability(ws, blocked, { status: 'dnd' });
    newPolicy(ws, { respect_status: 1 });

    const ticket = makeTicket(ws);
    const decision = await decideAssignment(ws, ticket);
    assert.equal(decision.chosen, null);
    assert.match(decision.rationale, /filtered out/);

    // And the live path records the miss rather than silently doing nothing.
    const result = await autoAssign(ticket);
    assert.equal(result, null);
    const logged = db.prepare('SELECT * FROM assignment_log WHERE ticket_id = ?').get(ticket.id);
    assert.ok(logged, 'a decision that assigned nobody must still be logged');
    assert.equal(logged.assigned_user_id, null);
  });
});

describe('assignmentEngine: parseSonaVerdict (the AI allowlist boundary)', () => {
  const allowed = ['usr_a', 'usr_b'];

  test('accepts a well-formed verdict naming a shortlisted user', () => {
    const v = parseSonaVerdict('{"user_id":"usr_a","rationale":"Network specialist"}', allowed);
    assert.deepEqual(v, { user_id: 'usr_a', rationale: 'Network specialist' });
  });

  test('tolerates the markdown code fence models often wrap JSON in', () => {
    const v = parseSonaVerdict('```json\n{"user_id":"usr_b","rationale":"Least loaded"}\n```', allowed);
    assert.equal(v.user_id, 'usr_b');
  });

  test('rejects a user id that was not on the shortlist', () => {
    // The critical case: a hallucinated id, or a real user who was filtered
    // out for being on leave or at capacity, must never be assignable.
    assert.equal(parseSonaVerdict('{"user_id":"usr_zzz","rationale":"Best fit"}', allowed), null);
  });

  test('rejects an id belonging to a real but ineligible user', () => {
    assert.equal(parseSonaVerdict('{"user_id":"usr_on_leave"}', allowed), null);
  });

  test('rejects malformed JSON, prose, and empty output', () => {
    assert.equal(parseSonaVerdict('not json at all', allowed), null);
    assert.equal(parseSonaVerdict('', allowed), null);
    assert.equal(parseSonaVerdict(null, allowed), null);
    assert.equal(parseSonaVerdict('{"user_id":', allowed), null);
  });

  test('rejects structurally valid JSON of the wrong shape', () => {
    assert.equal(parseSonaVerdict('["usr_a"]', allowed), null);
    assert.equal(parseSonaVerdict('"usr_a"', allowed), null);
    assert.equal(parseSonaVerdict('{"user_id":123}', allowed), null);
    assert.equal(parseSonaVerdict('{"assignee":"usr_a"}', allowed), null);
  });

  test('an empty shortlist can never yield a verdict', () => {
    assert.equal(parseSonaVerdict('{"user_id":"usr_a"}', []), null);
  });

  test('a missing or non-string rationale degrades to empty rather than failing', () => {
    assert.equal(parseSonaVerdict('{"user_id":"usr_a"}', allowed).rationale, '');
    assert.equal(parseSonaVerdict('{"user_id":"usr_a","rationale":42}', allowed).rationale, '');
  });

  test('an overlong rationale is truncated rather than stored whole', () => {
    const v = parseSonaVerdict(JSON.stringify({ user_id: 'usr_a', rationale: 'x'.repeat(500) }), allowed);
    assert.equal(v.rationale.length, 140);
  });
});

describe('assignmentEngine: Sona judgment layer', () => {
  // No AI provider is configured in the test database, so getProvider()
  // returns null and askSona() bails -- which is exactly the production
  // "no credentials" path, and must land on the deterministic fallback
  // rather than failing to assign.
  test('falls back deterministically when no AI provider is configured', async () => {
    const ws = newWorkspace();
    const heavy = newAgent(ws, 'Heavy');
    const light = newAgent(ws, 'Light');
    giveOpenTickets(ws, heavy, 3);
    newPolicy(ws, { strategy: 'ai_sona', ai_enabled: 1, fallback_strategy: 'least_loaded' });

    const decision = await decideAssignment(ws, makeTicket(ws));
    assert.equal(decision.aiUsed, false);
    assert.equal(decision.strategyUsed, 'least_loaded');
    assert.equal(decision.chosen.user_id, light);
    assert.match(decision.rationale, /Sona unavailable/);
  });

  test('the shortlist handed to Sona only ever contains eligible candidates', () => {
    const ws = newWorkspace();
    const ok = newAgent(ws, 'Ok');
    const away = newAgent(ws, 'Away');
    setAvailability(ws, away, { status: 'dnd' });
    const policy = newPolicy(ws, { strategy: 'ai_sona', ai_enabled: 1, respect_status: 1 });

    const eligible = scoreCandidates(policy, ws).filter((c) => c.eligible);
    assert.deepEqual(eligible.map((c) => c.user_id), [ok]);
    assert.ok(!eligible.some((c) => c.user_id === away));
  });

  test('a ticket that already has an assignee is never reassigned', async () => {
    const ws = newWorkspace();
    const incumbent = newAgent(ws, 'Incumbent');
    newAgent(ws, 'Other');
    newPolicy(ws, { strategy: 'least_loaded' });

    const ticket = makeTicket(ws);
    db.prepare('UPDATE tickets SET assignee_id = ? WHERE id = ?').run(incumbent, ticket.id);
    const reloaded = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);

    assert.equal(await autoAssign(reloaded), null);
    const after = db.prepare('SELECT assignee_id FROM tickets WHERE id = ?').get(ticket.id);
    assert.equal(after.assignee_id, incumbent);
  });

  test('a resolved ticket is never auto-assigned', async () => {
    const ws = newWorkspace();
    newAgent(ws, 'Ana');
    newPolicy(ws, { strategy: 'least_loaded' });
    const ticket = makeTicket(ws);
    db.prepare("UPDATE tickets SET status = 'resolved' WHERE id = ?").run(ticket.id);
    const reloaded = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
    assert.equal(await autoAssign(reloaded), null);
  });
});

describe('assignmentEngine: autoAssign side effects', () => {
  test('a successful assignment writes the ticket, history and an audit-grade log row', async () => {
    const ws = newWorkspace();
    const agent = newAgent(ws, 'Ana');
    const policy = newPolicy(ws, { strategy: 'least_loaded' });
    const ticket = makeTicket(ws);

    const result = await autoAssign(ticket);
    assert.equal(result.userId, agent);

    const after = db.prepare('SELECT assignee_id FROM tickets WHERE id = ?').get(ticket.id);
    assert.equal(after.assignee_id, agent);

    const history = db.prepare("SELECT * FROM ticket_history WHERE ticket_id = ? AND event = 'assigned'").get(ticket.id);
    assert.ok(history, 'assignment must be visible in ticket history');
    assert.match(history.detail, /Ana/);

    const log = db.prepare('SELECT * FROM assignment_log WHERE ticket_id = ?').get(ticket.id);
    assert.equal(log.assigned_user_id, agent);
    assert.equal(log.policy_id, policy.id);
    // The scored candidate set is preserved for later explanation.
    const snapshot = JSON.parse(log.candidates);
    assert.ok(Array.isArray(snapshot) && snapshot.length >= 1);
    assert.equal(snapshot[0].user_id, agent);
  });

  test('candidates from another workspace are never considered', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    newAgent(wsB, 'Stranger');
    const mine = newAgent(wsA, 'Mine');

    const candidates = scoreCandidates(newPolicy(wsA), wsA);
    assert.deepEqual(candidates.map((c) => c.user_id), [mine]);
  });
});
