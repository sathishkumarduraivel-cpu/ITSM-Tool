import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  MajorIncidentError, evaluateCriteria, commandMeta,
  propose, listProposals, getProposal, promote, reject, withdraw,
  addAction, updateAction, listActions,
  addDecision, listDecisions, addComms, listComms,
  acknowledge, assignRoles, benchmarksFor, commandSummary, MI_ROLES,
} from './majorIncidentCommand.js';
import { getMajorIncident } from './majorIncidents.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'T ' + id, id);
  return id;
}
function newUser(ws, role = 'agent') {
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(id, role + '-' + id.slice(-4), `${id}@x.local`, 'x', role);
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, active) VALUES (?,?,?,?,1)')
    .run(uid('wm'), ws, id, role);
  return { id, role, permissions: [] };
}
let seq = 0;
const COLUMNS = ['type', 'title', 'status', 'priority', 'impact', 'category', 'source', 'created_at'];
function newTicket(ws, over = {}) {
  const id = uid('tkt');
  seq += 1;
  const t = { type: 'incident', title: 'Service down', status: 'open', priority: 'high', created_at: new Date().toISOString(), ...over };
  for (const k of Object.keys(over)) if (!COLUMNS.includes(k)) throw new Error(`helper cannot set ${k}`);
  const cols = COLUMNS.filter((c) => t[c] !== undefined);
  db.prepare(`INSERT INTO tickets (id, workspace_id, number, ${cols.join(', ')}) VALUES (?,?,?,${cols.map(() => '?').join(',')})`)
    .run(id, ws, `INC-${5000 + seq}`, ...cols.map((c) => t[c]));
  return id;
}
// Proposes and promotes in one go, for the tests that are about what happens
// afterwards rather than about the gate itself.
function liveMi(ws, user, over = {}) {
  const ticket = newTicket(ws);
  const p = propose(ws, user, { ticket_id: ticket, reason: 'Everything is down' });
  const { majorIncidentId } = promote(ws, p.id, user, over);
  return { ticket, miId: majorIncidentId };
}

describe('the automated criteria check', () => {
  test('it reports what it found, as evidence rather than a verdict', () => {
    const ws = newWorkspace();
    const id = newTicket(ws, { priority: 'critical', impact: 'high' });
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    const signals = evaluateCriteria(ws, ticket);
    const keys = signals.map((s) => s.key);
    assert.ok(keys.includes('critical_priority'));
    assert.ok(keys.includes('high_impact'));
    for (const s of signals) assert.ok(s.detail, 'every signal explains itself');
  });

  test('several open incidents in one category is a signal', () => {
    const ws = newWorkspace();
    for (let i = 0; i < 4; i++) newTicket(ws, { category: 'Network' });
    const id = newTicket(ws, { category: 'Network' });
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    const signals = evaluateCriteria(ws, ticket);
    const related = signals.find((s) => s.key === 'multiple_related');
    assert.ok(related, JSON.stringify(signals));
    assert.match(related.detail, /Network/);
  });

  test('a quiet category raises nothing', () => {
    const ws = newWorkspace();
    const id = newTicket(ws, { category: 'Printing', priority: 'medium' });
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    assert.deepEqual(evaluateCriteria(ws, ticket).map((s) => s.key), []);
  });

  test('an incident raised by monitoring is flagged', () => {
    const ws = newWorkspace();
    const id = newTicket(ws, { source: 'alert', priority: 'medium' });
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    assert.ok(evaluateCriteria(ws, ticket).some((s) => s.key === 'monitoring_raised'));
  });

  test('another workspace incidents never count towards the signal', () => {
    const a = newWorkspace(); const b = newWorkspace();
    for (let i = 0; i < 5; i++) newTicket(b, { category: 'Network' });
    const id = newTicket(a, { category: 'Network', priority: 'medium' });
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
    assert.ok(!evaluateCriteria(a, ticket).some((s) => s.key === 'multiple_related'));
  });
});

describe('the proposal gate', () => {
  test('proposing leaves the original incident untouched', () => {
    // The specification is explicit that promotion preserves the source
    // incident; proposing must not pre-empt that by changing it either.
    const ws = newWorkspace(); const user = newUser(ws);
    const ticket = newTicket(ws, { priority: 'medium' });
    const before = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket);
    propose(ws, user, { ticket_id: ticket, reason: 'Payroll is down for everyone' });
    const after = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket);
    assert.equal(after.priority, before.priority, 'proposing must not raise the priority');
    assert.equal(after.status, before.status);
  });

  test('a proposal needs a reason', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    assert.throws(() => propose(ws, user, { ticket_id: newTicket(ws), reason: '  ' }), (e) => {
      assert.equal(e.field_errors[0].field, 'reason');
      return true;
    });
  });

  test('it captures the criteria as evidence at the time', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const ticket = newTicket(ws, { priority: 'critical' });
    const p = propose(ws, user, { ticket_id: ticket, reason: 'Outage' });
    assert.ok(p.criteria.some((c) => c.key === 'critical_priority'));

    // Changing the incident afterwards must not rewrite the evidence the
    // decision was taken on.
    db.prepare("UPDATE tickets SET priority = 'low' WHERE id = ?").run(ticket);
    assert.ok(getProposal(ws, p.id).criteria.some((c) => c.key === 'critical_priority'));
  });

  test('only an incident can be proposed', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const change = newTicket(ws, { type: 'change' });
    assert.throws(() => propose(ws, user, { ticket_id: change, reason: 'x' }), /Only an incident/);
  });

  test('the same incident cannot be proposed twice while one is pending', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const ticket = newTicket(ws);
    propose(ws, user, { ticket_id: ticket, reason: 'first' });
    assert.throws(() => propose(ws, user, { ticket_id: ticket, reason: 'second' }), (e) => e.status === 409);
  });

  test('rejecting requires a reason, and says so on the incident', () => {
    const ws = newWorkspace(); const user = newUser(ws); const manager = newUser(ws, 'admin');
    const ticket = newTicket(ws);
    const p = propose(ws, user, { ticket_id: ticket, reason: 'Looks big' });
    assert.throws(() => reject(ws, p.id, manager, '   '), (e) => {
      assert.equal(e.field_errors[0].field, 'comment');
      return true;
    });
    const rejected = reject(ws, p.id, manager, 'Only one team affected, handled as a P2');
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.decided_by, manager.id);
    const history = db.prepare("SELECT detail FROM ticket_history WHERE ticket_id = ? AND event = 'major_incident_rejected'").get(ticket);
    assert.match(history.detail, /Only one team affected/);
  });

  test('a decided proposal cannot be decided again', () => {
    const ws = newWorkspace(); const user = newUser(ws); const manager = newUser(ws, 'admin');
    const p = propose(ws, user, { ticket_id: newTicket(ws), reason: 'x' });
    reject(ws, p.id, manager, 'no');
    assert.throws(() => promote(ws, p.id, manager, {}), (e) => e.status === 409);
    assert.throws(() => reject(ws, p.id, manager, 'again'), (e) => e.status === 409);
  });

  test('the proposer can withdraw their own, others cannot', () => {
    const ws = newWorkspace(); const user = newUser(ws); const other = newUser(ws);
    const p = propose(ws, user, { ticket_id: newTicket(ws), reason: 'x' });
    assert.throws(() => withdraw(ws, p.id, other), (e) => e.status === 403);
    assert.equal(withdraw(ws, p.id, user).status, 'withdrawn');
  });

  test('promotion preserves the incident and links the two', () => {
    const ws = newWorkspace(); const user = newUser(ws); const manager = newUser(ws, 'admin');
    const ticket = newTicket(ws, { priority: 'medium' });
    const p = propose(ws, user, { ticket_id: ticket, reason: 'Site-wide outage' });
    const { majorIncidentId } = promote(ws, p.id, manager, { severity: 'sev1' });

    const incident = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket);
    assert.ok(incident, 'the incident still exists in its own right');
    assert.equal(incident.priority, 'critical', 'and is raised to critical');

    const mi = getMajorIncident(majorIncidentId, ws);
    assert.equal(mi.ticket_id, ticket, 'the relationship is traceable');
    assert.equal(mi.severity, 'sev1');
    assert.ok(mi.promoted_at);
    assert.equal(getProposal(ws, p.id).major_incident_id, majorIncidentId, 'and traceable back from the proposal');
  });

  test('promotion never lowers a priority already set higher', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const ticket = newTicket(ws, { priority: 'critical' });
    const p = propose(ws, user, { ticket_id: ticket, reason: 'x' });
    promote(ws, p.id, user, { severity: 'sev3' });
    assert.equal(db.prepare('SELECT priority FROM tickets WHERE id = ?').get(ticket).priority, 'critical');
  });

  test('an invented severity is refused', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = propose(ws, user, { ticket_id: newTicket(ws), reason: 'x' });
    assert.throws(() => promote(ws, p.id, user, { severity: 'sev9' }), /Severity must be one of/);
  });

  test('a promoted proposal leaves the pending queue', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = propose(ws, user, { ticket_id: newTicket(ws), reason: 'x' });
    assert.equal(listProposals(ws).length, 1);
    promote(ws, p.id, user, {});
    assert.equal(listProposals(ws).length, 0);
    assert.equal(listProposals(ws, { status: 'all' }).length, 1);
  });

  test('one workspace cannot see or decide another proposal', () => {
    const a = newWorkspace(); const b = newWorkspace();
    const user = newUser(a);
    const p = propose(a, user, { ticket_id: newTicket(a), reason: 'x' });
    assert.throws(() => getProposal(b, p.id), (e) => e.status === 404);
    assert.equal(listProposals(b).length, 0);
  });
});

describe('the command logs', () => {
  test('actions carry an owner, an ETA and an outcome', () => {
    const ws = newWorkspace(); const user = newUser(ws); const owner = newUser(ws);
    const { miId } = liveMi(ws, user);
    addAction(ws, miId, user, { action: 'Fail over to the standby database', owner_id: owner.id, eta: '2026-01-01T10:00:00Z' });
    const [a] = listActions(ws, miId);
    assert.equal(a.status, 'open');
    assert.equal(a.owner_id, owner.id);
    assert.ok(a.started_at, 'an action starts when it is raised');

    updateAction(ws, a.id, user, { status: 'done', outcome: 'Failover completed, service restored' });
    const [done] = listActions(ws, miId);
    assert.equal(done.status, 'done');
    assert.ok(done.completed_at);
    assert.match(done.outcome, /service restored/);
  });

  test('reopening an action clears its completion', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    addAction(ws, miId, user, { action: 'Restart the cluster' });
    const [a] = listActions(ws, miId);
    updateAction(ws, a.id, user, { status: 'done' });
    updateAction(ws, a.id, user, { status: 'in_progress' });
    assert.equal(listActions(ws, miId)[0].completed_at, null);
  });

  test('a decision records what else was considered and why', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    addDecision(ws, miId, user, {
      decision: 'Fail over rather than repair in place',
      options_considered: 'Repair in place; fail over; wait for the vendor',
      rationale: 'Repair was unbounded; failover is rehearsed and takes ten minutes',
    });
    const [d] = listDecisions(ws, miId);
    assert.match(d.options_considered, /wait for the vendor/);
    assert.match(d.rationale, /rehearsed/);
    assert.equal(d.decided_by, user.id);
  });

  test('a communication records who it went to and how', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    addComms(ws, miId, user, { audience: 'executives', channel: 'email', message: 'Service is degraded; failover under way.' });
    const [c] = listComms(ws, miId);
    assert.equal(c.audience, 'executives');
    assert.equal(c.channel, 'email');
    assert.ok(getMajorIncident(miId, ws).first_comms_at, 'the first update starts its benchmark clock');
  });

  test('an unknown audience or channel is refused', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    assert.throws(() => addComms(ws, miId, user, { audience: 'everyone', channel: 'email', message: 'x' }), /Audience must be/);
    assert.throws(() => addComms(ws, miId, user, { audience: 'executives', channel: 'carrier pigeon', message: 'x' }), /Channel must be/);
  });

  test('an empty action, decision or message is refused', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    assert.throws(() => addAction(ws, miId, user, { action: ' ' }), /Say what needs doing/);
    assert.throws(() => addDecision(ws, miId, user, { decision: '' }), /Record what was decided/);
    assert.throws(() => addComms(ws, miId, user, { audience: 'executives', channel: 'email', message: '  ' }), /Write the update/);
  });

  test('logs belong to their own major incident only', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const one = liveMi(ws, user);
    const two = liveMi(ws, user);
    addAction(ws, one.miId, user, { action: 'Only on the first' });
    assert.equal(listActions(ws, one.miId).length, 1);
    assert.equal(listActions(ws, two.miId).length, 0);
  });
});

describe('roles and benchmarks', () => {
  test('the four roles are distinct and assignable', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    const lead = newUser(ws); const tech = newUser(ws); const comms = newUser(ws);
    const mi = assignRoles(ws, miId, user, { incident_lead_id: lead.id, technical_lead_id: tech.id, comms_lead_id: comms.id });
    assert.equal(mi.incident_lead_id, lead.id);
    assert.equal(mi.technical_lead_id, tech.id);
    assert.equal(mi.comms_lead_id, comms.id);
    assert.equal(MI_ROLES.length, 4);
  });

  test('an unknown user cannot be given a role', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    assert.throws(() => assignRoles(ws, miId, user, { incident_lead_id: 'usr_nope' }), /No such user/);
  });

  test('acknowledging is stamped once and measured from promotion', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    const first = acknowledge(ws, miId, user);
    assert.ok(first.acknowledged_at);
    const again = acknowledge(ws, miId, user);
    assert.equal(again.acknowledged_at, first.acknowledged_at, 'acknowledging twice does not reset the clock');

    const marks = benchmarksFor(again);
    assert.equal(marks.acknowledged.target_minutes, 5);
    assert.equal(marks.acknowledged.met, true, 'acknowledged immediately, so within target');
  });

  test('an unmet benchmark reports the time elapsed so far, not merely "pending"', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    // Promoted an hour ago, still not acknowledged.
    db.prepare("UPDATE major_incidents SET promoted_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 3600000).toISOString(), miId);
    const marks = benchmarksFor(getMajorIncident(miId, ws));
    assert.equal(marks.acknowledged.met, null, 'not met and not missed — it has simply not happened');
    assert.ok(marks.acknowledged.elapsed_minutes >= 59, `${marks.acknowledged.elapsed_minutes} minutes elapsed`);
    assert.ok(marks.acknowledged.elapsed_minutes > marks.acknowledged.target_minutes, 'so it reads as overdue');
  });

  test('assigning the lead starts its clock once', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    const lead = newUser(ws); const other = newUser(ws);
    const first = assignRoles(ws, miId, user, { incident_lead_id: lead.id });
    assert.ok(first.lead_assigned_at);
    const second = assignRoles(ws, miId, user, { incident_lead_id: other.id });
    assert.equal(second.lead_assigned_at, first.lead_assigned_at, 'changing the lead later does not restart the benchmark');
  });

  test('the command summary gathers everything the console needs', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    addAction(ws, miId, user, { action: 'Do the thing' });
    addDecision(ws, miId, user, { decision: 'Decided a thing' });
    addComms(ws, miId, user, { audience: 'all_staff', channel: 'chat', message: 'Update' });
    const s = commandSummary(ws, miId);
    assert.equal(s.actions.length, 1);
    assert.equal(s.open_actions, 1);
    assert.equal(s.decisions.length, 1);
    assert.equal(s.comms.length, 1);
    assert.equal(s.roles.length, 4);
    assert.ok(s.benchmarks.acknowledged);
  });

  test('the metadata matches what the service accepts', () => {
    const m = commandMeta();
    const ws = newWorkspace(); const user = newUser(ws);
    const { miId } = liveMi(ws, user);
    for (const a of m.audiences) {
      assert.doesNotThrow(() => addComms(ws, miId, user, { audience: a, channel: m.channels[0], message: 'x' }),
        `audience ${a} is offered but rejected`);
    }
    for (const c of m.channels) {
      assert.doesNotThrow(() => addComms(ws, miId, user, { audience: m.audiences[0], channel: c, message: 'x' }),
        `channel ${c} is offered but rejected`);
    }
  });
});
