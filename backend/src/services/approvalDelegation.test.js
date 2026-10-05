import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  DelegationError, createDelegation, revokeDelegation, listDelegations,
  delegatorsFor, delegatesOf, canDecideApproval, visibleApprovalClause,
} from './approvalDelegation.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'T ' + id, id);
  return id;
}
function newUser(ws, name = 'Person', role = 'agent', { active = 1 } = {}) {
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(id, name, `${id}@x.local`, 'x', role);
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, active) VALUES (?,?,?,?,?)')
    .run(uid('wm'), ws, id, role, active);
  return { id, name, role };
}
let seq = 0;
function newTicket(ws, over = {}) {
  const id = uid('tkt');
  seq += 1;
  const cols = { type: 'request', title: 'Need a laptop', status: 'pending_approval', priority: 'medium', ...over };
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, ${keys.join(', ')}) VALUES (?,?,?,${keys.map(() => '?').join(',')})`
  ).run(id, ws, `REQ-${7000 + seq}`, ...keys.map((k) => cols[k]));
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}
function newApproval(ticketId, over = {}) {
  const id = uid('apr');
  const cols = { approver_id: null, approver_role: null, step_order: 1, status: 'pending', ...over };
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO approvals (id, ticket_id, ${keys.join(', ')}) VALUES (?,?,${keys.map(() => '?').join(',')})`
  ).run(id, ticketId, ...keys.map((k) => cols[k]));
  return db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
}
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

describe('approval delegation: arranging cover', () => {
  test('an approver can hand their approvals to somebody else', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const row = createDelegation(ws, dev, { to_user_id: priya.id, reason: 'Annual leave' });
    assert.equal(row.from_user_id, dev.id);
    assert.equal(row.to_user_id, priya.id);
    assert.equal(row.in_force, true, 'with no dates the cover starts immediately');
  });

  test('an open-ended delegation runs until it is revoked', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    createDelegation(ws, dev, { to_user_id: priya.id });
    assert.equal(delegatorsFor(ws, priya.id).length, 1);
  });

  test('a future window is recorded but not yet in force', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const row = createDelegation(ws, dev, { to_user_id: priya.id, starts_at: day(5), ends_at: day(10) });
    assert.equal(row.in_force, false);
    assert.equal(delegatorsFor(ws, priya.id).length, 0, 'cover that has not started grants nothing');
    assert.equal(delegatorsFor(ws, priya.id, day(7)).length, 1, 'but it does once the window opens');
    assert.equal(delegatorsFor(ws, priya.id, day(20)).length, 0, 'and stops again afterwards');
  });

  test('both ends of the window are inclusive', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    createDelegation(ws, dev, { to_user_id: priya.id, starts_at: day(2), ends_at: day(4) });
    assert.equal(delegatorsFor(ws, priya.id, day(2)).length, 1, 'the first day counts');
    assert.equal(delegatorsFor(ws, priya.id, day(4)).length, 1, 'the last day counts');
    assert.equal(delegatorsFor(ws, priya.id, day(1)).length, 0);
    assert.equal(delegatorsFor(ws, priya.id, day(5)).length, 0);
  });

  test('nobody can cover their own approvals', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    assert.throws(() => createDelegation(ws, dev, { to_user_id: dev.id }), DelegationError);
  });

  test('cover cannot be handed to somebody outside the workspace', () => {
    const ws = newWorkspace();
    const other = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const stranger = newUser(other, 'Stranger');
    assert.throws(() => createDelegation(ws, dev, { to_user_id: stranger.id }), DelegationError);
  });

  test('cover cannot be handed to a deactivated member', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const gone = newUser(ws, 'Gone', 'agent', { active: 0 });
    assert.throws(() => createDelegation(ws, dev, { to_user_id: gone.id }), DelegationError);
  });

  test('an end date before the start is refused', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    assert.throws(() => createDelegation(ws, dev, { to_user_id: priya.id, starts_at: day(5), ends_at: day(2) }), DelegationError);
  });

  test('a window that has already closed is refused rather than stored as dead cover', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    assert.throws(() => createDelegation(ws, dev, { to_user_id: priya.id, ends_at: day(-1) }), DelegationError);
  });

  test('a malformed date is refused', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    assert.throws(() => createDelegation(ws, dev, { to_user_id: priya.id, starts_at: 'next monday' }), DelegationError);
  });

  test('a second overlapping delegation to the same person is refused', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    createDelegation(ws, dev, { to_user_id: priya.id });
    assert.throws(() => createDelegation(ws, dev, { to_user_id: priya.id }), DelegationError);
  });

  test('two different people can cover the same approver at once', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const sam = newUser(ws, 'Sam');
    createDelegation(ws, dev, { to_user_id: priya.id });
    createDelegation(ws, dev, { to_user_id: sam.id });
    assert.equal(delegatesOf(ws, dev.id).length, 2);
  });

  test('only an admin can arrange cover for somebody else', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const meddler = newUser(ws, 'Meddler');
    assert.throws(() => createDelegation(ws, meddler, { from_user_id: dev.id, to_user_id: priya.id }), DelegationError);

    const admin = newUser(ws, 'Admin', 'admin');
    const row = createDelegation(ws, admin, { from_user_id: dev.id, to_user_id: priya.id });
    assert.equal(row.from_user_id, dev.id, 'an admin can set up cover for the person who is already away');
  });
});

describe('approval delegation: revoking', () => {
  test('the approver can end it', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const row = createDelegation(ws, dev, { to_user_id: priya.id });
    revokeDelegation(ws, dev, row.id);
    assert.equal(delegatorsFor(ws, priya.id).length, 0);
  });

  test('the person covering can decline it', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const row = createDelegation(ws, dev, { to_user_id: priya.id });
    revokeDelegation(ws, priya, row.id);
    assert.equal(delegatorsFor(ws, priya.id).length, 0);
  });

  test('an unrelated person cannot end it', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const nosy = newUser(ws, 'Nosy');
    const row = createDelegation(ws, dev, { to_user_id: priya.id });
    assert.throws(() => revokeDelegation(ws, nosy, row.id), DelegationError);
  });

  test('revoking twice is refused', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const row = createDelegation(ws, dev, { to_user_id: priya.id });
    revokeDelegation(ws, dev, row.id);
    assert.throws(() => revokeDelegation(ws, dev, row.id), DelegationError);
  });

  test('a revoked delegation stays on the record', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const row = createDelegation(ws, dev, { to_user_id: priya.id });
    revokeDelegation(ws, dev, row.id);
    const history = listDelegations(ws, { fromUserId: dev.id, includeExpired: true });
    assert.equal(history.length, 1);
    assert.ok(history[0].revoked_at, 'when it ended is kept');
    assert.equal(history[0].revoked_by, dev.id, 'and who ended it');
  });

  test('delegation does not leak across workspaces', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    const dev = newUser(wsA, 'Dev');
    const priya = newUser(wsA, 'Priya');
    createDelegation(wsA, dev, { to_user_id: priya.id });
    assert.equal(delegatorsFor(wsB, priya.id).length, 0);
  });
});

describe('who may decide an approval', () => {
  test('the named approver may', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const sam = newUser(ws, 'Sam', 'requester');
    const ticket = newTicket(ws, { requester_id: sam.id });
    const approval = newApproval(ticket.id, { approver_id: dev.id });
    const v = canDecideApproval(ws, approval, dev, ticket);
    assert.equal(v.allowed, true);
    assert.equal(v.on_behalf_of, null, 'deciding in their own right');
  });

  test('somebody else may not', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const nosy = newUser(ws, 'Nosy');
    const sam = newUser(ws, 'Sam', 'requester');
    const ticket = newTicket(ws, { requester_id: sam.id });
    const approval = newApproval(ticket.id, { approver_id: dev.id });
    const v = canDecideApproval(ws, approval, nosy, ticket);
    assert.equal(v.allowed, false);
    assert.equal(v.status, 403);
  });

  test('a delegate may, and it records who they acted for', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const sam = newUser(ws, 'Sam', 'requester');
    createDelegation(ws, dev, { to_user_id: priya.id });
    const ticket = newTicket(ws, { requester_id: sam.id });
    const approval = newApproval(ticket.id, { approver_id: dev.id });
    const v = canDecideApproval(ws, approval, priya, ticket);
    assert.equal(v.allowed, true);
    assert.equal(v.on_behalf_of, dev.id);
  });

  test('a delegate loses it once the cover is revoked', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    const sam = newUser(ws, 'Sam', 'requester');
    const row = createDelegation(ws, dev, { to_user_id: priya.id });
    const ticket = newTicket(ws, { requester_id: sam.id });
    const approval = newApproval(ticket.id, { approver_id: dev.id });
    assert.equal(canDecideApproval(ws, approval, priya, ticket).allowed, true);
    revokeDelegation(ws, dev, row.id);
    assert.equal(canDecideApproval(ws, approval, priya, ticket).allowed, false);
  });

  test('delegation is NOT transitive', () => {
    const ws = newWorkspace();
    const a = newUser(ws, 'A');
    const b = newUser(ws, 'B');
    const c = newUser(ws, 'C');
    const sam = newUser(ws, 'Sam', 'requester');
    createDelegation(ws, a, { to_user_id: b.id });
    createDelegation(ws, b, { to_user_id: c.id });
    const ticket = newTicket(ws, { requester_id: sam.id });
    const approval = newApproval(ticket.id, { approver_id: a.id });
    assert.equal(canDecideApproval(ws, approval, b, ticket).allowed, true, 'one hop works');
    assert.equal(canDecideApproval(ws, approval, c, ticket).allowed, false,
      'C covers B, not A -- chained cover would put the decision three people away');
  });

  test('a role approval with nobody named can be taken by anyone holding that role', () => {
    const ws = newWorkspace();
    const agent = newUser(ws, 'Agent', 'agent');
    const sam = newUser(ws, 'Sam', 'requester');
    const ticket = newTicket(ws, { requester_id: sam.id });
    const approval = newApproval(ticket.id, { approver_role: 'agent' });
    assert.equal(canDecideApproval(ws, approval, agent, ticket).allowed, true);
  });

  test('a requester cannot take a role approval that is not theirs', () => {
    const ws = newWorkspace();
    const sam = newUser(ws, 'Sam', 'requester');
    const jamie = newUser(ws, 'Jamie', 'requester');
    const ticket = newTicket(ws, { requester_id: jamie.id });
    const approval = newApproval(ticket.id, { approver_role: 'admin' });
    const v = canDecideApproval(ws, approval, sam, ticket);
    assert.equal(v.allowed, false, 'this is the hole that let any member approve anything');
  });

  test('nobody approves their own request, not even an admin', () => {
    const ws = newWorkspace();
    const admin = newUser(ws, 'Admin', 'admin');
    const ticket = newTicket(ws, { requester_id: admin.id });
    const approval = newApproval(ticket.id, { approver_role: 'admin' });
    const v = canDecideApproval(ws, approval, admin, ticket);
    assert.equal(v.allowed, false);
    assert.match(v.reason, /cannot approve a request that is yours/i);
  });

  test('nor the person it was raised for', () => {
    const ws = newWorkspace();
    const admin = newUser(ws, 'Admin', 'admin');
    const sam = newUser(ws, 'Sam', 'requester');
    // Raised BY sam, FOR the admin -- the admin is still the beneficiary.
    const ticket = newTicket(ws, { requester_id: sam.id, requested_for_id: admin.id });
    const approval = newApproval(ticket.id, { approver_role: 'admin' });
    assert.equal(canDecideApproval(ws, approval, admin, ticket).allowed, false);
  });

  test('an already-decided approval cannot be decided again', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const sam = newUser(ws, 'Sam', 'requester');
    const ticket = newTicket(ws, { requester_id: sam.id });
    const approval = newApproval(ticket.id, { approver_id: dev.id, status: 'approved' });
    const v = canDecideApproval(ws, approval, dev, ticket);
    assert.equal(v.allowed, false);
    assert.equal(v.status, 409);
  });

  test('an admin can unblock a stuck approval, as themselves', () => {
    const ws = newWorkspace();
    const admin = newUser(ws, 'Admin', 'admin');
    const dev = newUser(ws, 'Dev');
    const sam = newUser(ws, 'Sam', 'requester');
    const ticket = newTicket(ws, { requester_id: sam.id });
    const approval = newApproval(ticket.id, { approver_id: dev.id });
    const v = canDecideApproval(ws, approval, admin, ticket);
    assert.equal(v.allowed, true);
    assert.equal(v.on_behalf_of, null, 'recorded as the admin, not silently as the named approver');
  });
});

describe('the approval queue reflects delegation', () => {
  test('it covers the user plus everyone they are covering for', () => {
    const ws = newWorkspace();
    const dev = newUser(ws, 'Dev');
    const priya = newUser(ws, 'Priya');
    createDelegation(ws, dev, { to_user_id: priya.id });
    const clause = visibleApprovalClause(ws, priya);
    assert.deepEqual(clause.delegators, [dev.id]);
    assert.ok(clause.params.includes(priya.id));
    assert.ok(clause.params.includes(dev.id));
  });

  test('with no delegation it is just the user and their role', () => {
    const ws = newWorkspace();
    const priya = newUser(ws, 'Priya');
    const clause = visibleApprovalClause(ws, priya);
    assert.deepEqual(clause.delegators, []);
    assert.deepEqual(clause.params, [priya.id, 'agent']);
  });
});
