import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  findRoute, listRoutes, createApprovalQueue, listApprovals, currentStep,
  recordDecision, sweepApprovalSlaBreaches,
  cabGroup, ecabGroup, createMeeting, addToAgenda, decideAgendaItem,
  setMeetingStatus, listMeetings, awaitingCab, markAttendance, removeFromAgenda,
} from './changeApproval.js';
import { listChangeTypes } from './changeTypes.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  listChangeTypes(id);
  return id;
}

let seq = 0;
function newMember(workspaceId, name, role = 'agent', managerId = null) {
  const id = uid('usr');
  seq += 1;
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)').run(id, `${id}-${seq}@t.local`, name, 'x');
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, active, manager_id) VALUES (?,?,?,?,1,?)')
    .run(uid('wm'), workspaceId, id, role, managerId);
  return id;
}

function addToGroup(groupId, userId) {
  db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), groupId, userId);
}

function newChange(workspaceId, fields = {}) {
  const requester = fields.requester_id || newMember(workspaceId, 'Requester', 'requester');
  const id = uid('tkt');
  const f = { change_type: 'normal', risk_band: 'medium', change_state: 'pending_approval', ...fields };
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, status, requester_id, change_type, risk_band, change_state)
     VALUES (?,?,?,'change','Approval test','pending_approval',?,?,?,?)`
  ).run(id, workspaceId, `CHG-${id.slice(-5)}`, requester, f.change_type, f.risk_band, f.change_state);
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

// A workspace with a populated CAB and ECAB, which is the realistic case.
function seededWorkspace(cabSize = 3) {
  const ws = newWorkspace();
  const cab = cabGroup(ws);
  const ecab = ecabGroup(ws);
  const cabMembers = [];
  for (let i = 0; i < cabSize; i += 1) {
    const u = newMember(ws, `CAB member ${i + 1}`, 'admin');
    addToGroup(cab.id, u);
    cabMembers.push(u);
  }
  const ecabMember = newMember(ws, 'ECAB member', 'admin');
  addToGroup(ecab.id, ecabMember);
  return { ws, cabMembers, ecabMember };
}

describe('changeApproval: route selection', () => {
  test('default routes cover all four lanes', () => {
    const ws = newWorkspace();
    const routes = listRoutes(ws);
    assert.ok(routes.length >= 5, `got ${routes.length}`);
    assert.ok(routes.every((r) => r.steps.length >= 1), 'every route has steps');
  });

  test('the most specific route wins on type plus risk band', () => {
    const ws = newWorkspace();
    const generic = findRoute(ws, { changeType: 'normal', riskBand: 'low' });
    const specific = findRoute(ws, { changeType: 'normal', riskBand: 'critical' });
    assert.match(generic.name, /CAB/);
    assert.match(specific.name, /critical/i);
    assert.notEqual(generic.id, specific.id);
  });

  test('Emergency routes to the ECAB with a one-hour SLA', () => {
    const ws = newWorkspace();
    const route = findRoute(ws, { changeType: 'emergency', riskBand: 'high' });
    assert.equal(route.steps[0].approver_type, 'ecab_group');
    assert.equal(route.steps[0].sla_hours, 1);
  });

  test('Expedite routes with a four-hour SLA, matching the diagram', () => {
    const ws = newWorkspace();
    const route = findRoute(ws, { changeType: 'expedite', riskBand: 'medium' });
    assert.equal(route.steps[0].sla_hours, 4);
  });

  test('a disabled route is not selected', () => {
    const ws = newWorkspace();
    listRoutes(ws);
    db.prepare('UPDATE change_approval_routes SET enabled = 0 WHERE workspace_id = ?').run(ws);
    assert.equal(findRoute(ws, { changeType: 'normal', riskBand: 'low' }), null);
  });

  test('routes never cross workspaces', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    listRoutes(wsA);
    db.prepare('UPDATE change_approval_routes SET name = ? WHERE workspace_id = ?').run('A-only', wsA);
    assert.ok(!listRoutes(wsB).some((r) => r.name === 'A-only'));
  });
});

describe('changeApproval: building the queue', () => {
  test('a CAB route creates one row per board member', () => {
    const { ws, cabMembers } = seededWorkspace(3);
    const change = newChange(ws);
    const result = createApprovalQueue(ws, change);
    assert.equal(result.ok, true);

    const approvals = listApprovals(change.id);
    assert.equal(approvals.length, 3);
    assert.ok(approvals.every((a) => a.approver_type === 'cab_group'));
    assert.deepEqual(new Set(approvals.map((a) => a.approver_id)), new Set(cabMembers));
  });

  test('SLA due dates are stamped from the route step', () => {
    const { ws } = seededWorkspace();
    const change = newChange(ws, { change_type: 'emergency' });
    createApprovalQueue(ws, change);
    const [approval] = listApprovals(change.id);
    assert.ok(approval.sla_due_at, 'an Emergency approval carries a deadline');
    const hours = (new Date(approval.sla_due_at) - Date.now()) / 3600000;
    assert.ok(hours > 0.5 && hours < 1.5, `expected roughly one hour, got ${hours}`);
  });

  test('a multi-step route puts the manager first and the CAB second', () => {
    const { ws } = seededWorkspace(2);
    const manager = newMember(ws, 'Manager', 'admin');
    const requester = newMember(ws, 'Requester', 'requester', manager);
    const change = newChange(ws, { requester_id: requester, risk_band: 'high' });

    const result = createApprovalQueue(ws, change);
    assert.equal(result.ok, true);
    const approvals = listApprovals(change.id);
    assert.equal(approvals[0].step_order, 1);
    assert.equal(approvals[0].approver_id, manager);
    assert.ok(approvals.some((a) => a.step_order === 2 && a.approver_type === 'cab_group'));
    assert.equal(currentStep(change.id), 1, 'the change waits on step 1 first');
  });

  test('a step with no resolvable approver is reported rather than silently skipped', () => {
    const { ws } = seededWorkspace(2);
    // A requester with no manager set, on a high-risk route that wants one.
    const change = newChange(ws, { risk_band: 'high' });
    const result = createApprovalQueue(ws, change);
    assert.equal(result.ok, true, 'the CAB step still works');
    assert.ok(result.unsatisfiable.some((u) => u.approver_type === 'requester_manager'));
  });

  test('an empty CAB fails loudly instead of creating an unapprovable change', () => {
    const ws = newWorkspace(); // no CAB members at all
    const change = newChange(ws);
    const result = createApprovalQueue(ws, change);
    assert.equal(result.ok, false);
    assert.match(result.error, /group membership/i);
  });

  test('re-routing replaces pending rows but keeps decided history', () => {
    const { ws, cabMembers } = seededWorkspace(2);
    const change = newChange(ws);
    createApprovalQueue(ws, change);

    const first = listApprovals(change.id)[0];
    recordDecision(ws, change.id, first.id, { decision: 'approved', actor: { id: cabMembers[0], name: 'CAB 1' } });

    createApprovalQueue(ws, change);
    const after = listApprovals(change.id);
    assert.ok(after.some((a) => a.status === 'approved'), 'the decided row survives re-routing');
  });
});

describe('changeApproval: decisions and quorum', () => {
  test('a CAB step needs its quorum, not just one approval', () => {
    const { ws, cabMembers } = seededWorkspace(3);
    const change = newChange(ws); // Normal route: quorum 2
    createApprovalQueue(ws, change);
    const approvals = listApprovals(change.id);

    const first = recordDecision(ws, change.id, approvals[0].id, { decision: 'approved', actor: { id: cabMembers[0], name: 'CAB 1' } });
    assert.equal(first.ok, true);
    assert.equal(first.stepComplete, false, 'one approval does not clear a quorum of two');
    assert.equal(first.fullyApproved, false);

    const second = recordDecision(ws, change.id, approvals[1].id, { decision: 'approved', actor: { id: cabMembers[1], name: 'CAB 2' } });
    assert.equal(second.stepComplete, true);
    assert.equal(second.fullyApproved, true, 'the queue clears once quorum is met');
  });

  test('reaching quorum closes the remaining rows so nothing hangs pending', () => {
    const { ws, cabMembers } = seededWorkspace(3);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const approvals = listApprovals(change.id);
    recordDecision(ws, change.id, approvals[0].id, { decision: 'approved', actor: { id: cabMembers[0], name: 'a' } });
    recordDecision(ws, change.id, approvals[1].id, { decision: 'approved', actor: { id: cabMembers[1], name: 'b' } });

    const after = listApprovals(change.id);
    assert.equal(after.filter((a) => a.status === 'pending').length, 0);
    assert.equal(after.filter((a) => a.status === 'not_required').length, 1, 'the third member was not needed');
  });

  test('a rejection is terminal and clears the rest of the queue', () => {
    const { ws, cabMembers } = seededWorkspace(3);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const approvals = listApprovals(change.id);

    const result = recordDecision(ws, change.id, approvals[0].id, {
      decision: 'rejected', comments: 'No backout plan', actor: { id: cabMembers[0], name: 'CAB 1' },
    });
    assert.equal(result.rejected, true);

    const after = listApprovals(change.id);
    assert.equal(after.filter((a) => a.status === 'pending').length, 0, 'nothing is left hanging');
    assert.equal(after.filter((a) => a.status === 'rejected').length, 1);
    assert.equal(db.prepare('SELECT cab_status FROM tickets WHERE id = ?').get(change.id).cab_status, 'rejected');
  });

  test('approve-with-conditions approves but records the conditions', () => {
    const { ws, cabMembers } = seededWorkspace(1);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const [approval] = listApprovals(change.id);

    const result = recordDecision(ws, change.id, approval.id, {
      decision: 'approved_with_conditions', conditions: 'Only outside business hours', actor: { id: cabMembers[0], name: 'CAB' },
    });
    assert.equal(result.ok, true);
    assert.equal(result.withConditions, true);

    const stored = listApprovals(change.id)[0];
    assert.equal(stored.status, 'approved');
    assert.match(stored.conditions, /outside business hours/);
  });

  test('a deferral leaves the approval open for the next sitting', () => {
    const { ws, cabMembers } = seededWorkspace(2);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const [approval] = listApprovals(change.id);

    const result = recordDecision(ws, change.id, approval.id, { decision: 'deferred', comments: 'Need the DBA present', actor: { id: cabMembers[0], name: 'CAB' } });
    assert.equal(result.deferred, true);
    assert.equal(listApprovals(change.id)[0].status, 'pending', 'still awaiting a real decision');
  });

  test('a later step cannot be decided before an earlier one', () => {
    const { ws, cabMembers } = seededWorkspace(2);
    const manager = newMember(ws, 'Manager', 'admin');
    const requester = newMember(ws, 'Requester', 'requester', manager);
    const change = newChange(ws, { requester_id: requester, risk_band: 'high' });
    createApprovalQueue(ws, change);

    const stepTwo = listApprovals(change.id).find((a) => a.step_order === 2);
    const result = recordDecision(ws, change.id, stepTwo.id, { decision: 'approved', actor: { id: cabMembers[0], name: 'CAB' } });
    assert.equal(result.ok, false);
    assert.match(result.error, /Step 1 must be decided first/);
  });

  test('deciding the same approval twice is refused', () => {
    const { ws, cabMembers } = seededWorkspace(1);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const [approval] = listApprovals(change.id);
    recordDecision(ws, change.id, approval.id, { decision: 'approved', actor: { id: cabMembers[0], name: 'a' } });
    const again = recordDecision(ws, change.id, approval.id, { decision: 'rejected', actor: { id: cabMembers[0], name: 'a' } });
    assert.equal(again.ok, false);
    assert.match(again.error, /already been decided/);
  });

  test('an unknown decision is refused', () => {
    const { ws } = seededWorkspace(1);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const [approval] = listApprovals(change.id);
    assert.equal(recordDecision(ws, change.id, approval.id, { decision: 'maybe' }).ok, false);
  });

  test('an approval from another workspace is not reachable', () => {
    const { ws } = seededWorkspace(1);
    const other = newWorkspace();
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const [approval] = listApprovals(change.id);
    assert.equal(recordDecision(other, change.id, approval.id, { decision: 'approved' }).ok, false);
  });
});

describe('changeApproval: SLA breach sweep', () => {
  test('an overdue approval is flagged exactly once', () => {
    const { ws } = seededWorkspace(1);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    db.prepare('UPDATE approvals SET sla_due_at = ? WHERE ticket_id = ?')
      .run(new Date(Date.now() - 3600000).toISOString(), change.id);

    assert.ok(sweepApprovalSlaBreaches() >= 1);
    assert.equal(db.prepare('SELECT sla_breached FROM approvals WHERE ticket_id = ?').get(change.id).sla_breached, 1);
    // A second sweep must not re-flag or re-notify.
    const before = db.prepare("SELECT COUNT(*) c FROM ticket_history WHERE ticket_id = ? AND event = 'escalated'").get(change.id).c;
    sweepApprovalSlaBreaches();
    const after = db.prepare("SELECT COUNT(*) c FROM ticket_history WHERE ticket_id = ? AND event = 'escalated'").get(change.id).c;
    assert.equal(after, before, 'the sweep is idempotent');
  });

  test('an approval still within its SLA is untouched', () => {
    const { ws } = seededWorkspace(1);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    db.prepare('UPDATE approvals SET sla_due_at = ? WHERE ticket_id = ?')
      .run(new Date(Date.now() + 3600000).toISOString(), change.id);
    sweepApprovalSlaBreaches();
    assert.equal(db.prepare('SELECT sla_breached FROM approvals WHERE ticket_id = ?').get(change.id).sla_breached, 0);
  });

  test('a decided approval is never flagged, however old', () => {
    const { ws, cabMembers } = seededWorkspace(1);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const [approval] = listApprovals(change.id);
    recordDecision(ws, change.id, approval.id, { decision: 'approved', actor: { id: cabMembers[0], name: 'a' } });
    db.prepare('UPDATE approvals SET sla_due_at = ? WHERE id = ?').run(new Date(Date.now() - 86400000).toISOString(), approval.id);
    sweepApprovalSlaBreaches();
    assert.equal(db.prepare('SELECT sla_breached FROM approvals WHERE id = ?').get(approval.id).sla_breached, 0);
  });
});

describe('changeApproval: CAB meetings', () => {
  const window = () => ({
    start_at: new Date(Date.now() + 86400000).toISOString(),
    end_at: new Date(Date.now() + 90000000).toISOString(),
  });

  test('creating a meeting seats the board as expected attendees', () => {
    const { ws, cabMembers } = seededWorkspace(3);
    const result = createMeeting(ws, { title: 'Weekly CAB', ...window() });
    assert.equal(result.ok, true);

    const [meeting] = listMeetings(ws);
    assert.equal(meeting.attendance.length, cabMembers.length);
    assert.ok(meeting.attendance.every((a) => a.present === 0), 'nobody is present until marked');
  });

  test('an ECAB meeting seats the ECAB, not the CAB', () => {
    const { ws, ecabMember } = seededWorkspace(3);
    const { meetingId } = createMeeting(ws, { title: 'ECAB', kind: 'ecab', ...window() });
    const meeting = listMeetings(ws).find((m) => m.id === meetingId);
    assert.deepEqual(meeting.attendance.map((a) => a.user_id), [ecabMember]);
  });

  test('an inverted meeting window is refused', () => {
    const { ws } = seededWorkspace(1);
    const w = window();
    assert.equal(createMeeting(ws, { title: 'Bad', start_at: w.end_at, end_at: w.start_at }).ok, false);
  });

  test('a change can be put on the agenda once', () => {
    const { ws } = seededWorkspace(2);
    const change = newChange(ws);
    const { meetingId } = createMeeting(ws, { title: 'CAB', ...window() });

    assert.equal(addToAgenda(ws, meetingId, change.id).ok, true);
    const again = addToAgenda(ws, meetingId, change.id);
    assert.equal(again.ok, true);
    assert.equal(again.alreadyOnAgenda, true);

    const meeting = listMeetings(ws).find((m) => m.id === meetingId);
    assert.equal(meeting.agenda.length, 1);
    assert.equal(meeting.agenda[0].number, change.number);
  });

  // The whole point of modelling meetings: the board decides collectively.
  test('a board decision clears the CAB approvals on that change', () => {
    const { ws } = seededWorkspace(3);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const { meetingId } = createMeeting(ws, { title: 'CAB', ...window() });
    const { itemId } = addToAgenda(ws, meetingId, change.id);

    const result = decideAgendaItem(ws, itemId, { decision: 'approved', notes: 'Agreed', actor: { id: 'chair', name: 'Chair' } });
    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.fullyApproved, true, 'one collective decision satisfies the whole CAB step');

    assert.equal(listApprovals(change.id).filter((a) => a.status === 'pending').length, 0);
  });

  test('a board rejection is terminal for the change', () => {
    const { ws } = seededWorkspace(2);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const { meetingId } = createMeeting(ws, { title: 'CAB', ...window() });
    const { itemId } = addToAgenda(ws, meetingId, change.id);

    const result = decideAgendaItem(ws, itemId, { decision: 'rejected', notes: 'Insufficient testing' });
    assert.equal(result.rejected, true);
    assert.equal(db.prepare('SELECT cab_status FROM tickets WHERE id = ?').get(change.id).cab_status, 'rejected');
  });

  test('approve-with-conditions carries the conditions onto the approval', () => {
    const { ws } = seededWorkspace(2);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const { meetingId } = createMeeting(ws, { title: 'CAB', ...window() });
    const { itemId } = addToAgenda(ws, meetingId, change.id);

    decideAgendaItem(ws, itemId, { decision: 'approved_with_conditions', conditions: 'DBA must be on the call' });
    const approved = listApprovals(change.id).find((a) => a.status === 'approved');
    assert.match(approved.conditions, /DBA must be on the call/);
  });

  test('a deferral records the discussion without approving anything', () => {
    const { ws } = seededWorkspace(2);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const { meetingId } = createMeeting(ws, { title: 'CAB', ...window() });
    const { itemId } = addToAgenda(ws, meetingId, change.id);

    assert.equal(decideAgendaItem(ws, itemId, { decision: 'deferred', notes: 'Next week' }).deferred, true);
    assert.ok(listApprovals(change.id).some((a) => a.status === 'pending'), 'the change still awaits approval');
  });

  test('a meeting cannot close with undecided business', () => {
    const { ws } = seededWorkspace(2);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const { meetingId } = createMeeting(ws, { title: 'CAB', ...window() });
    const { itemId } = addToAgenda(ws, meetingId, change.id);

    const blocked = setMeetingStatus(ws, meetingId, 'closed');
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /no decision/);

    decideAgendaItem(ws, itemId, { decision: 'approved' });
    assert.equal(setMeetingStatus(ws, meetingId, 'closed', { minutes: 'All approved' }).ok, true);
  });

  test('a decided agenda item cannot be removed from the record', () => {
    const { ws } = seededWorkspace(2);
    const change = newChange(ws);
    createApprovalQueue(ws, change);
    const { meetingId } = createMeeting(ws, { title: 'CAB', ...window() });
    const { itemId } = addToAgenda(ws, meetingId, change.id);

    assert.equal(removeFromAgenda(ws, itemId).ok, true, 'an undecided item can be dropped');

    const second = addToAgenda(ws, meetingId, change.id);
    decideAgendaItem(ws, second.itemId, { decision: 'approved' });
    const blocked = removeFromAgenda(ws, second.itemId);
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /meeting record/);
  });

  test('attendance can be marked', () => {
    const { ws, cabMembers } = seededWorkspace(2);
    const { meetingId } = createMeeting(ws, { title: 'CAB', ...window() });
    assert.equal(markAttendance(ws, meetingId, cabMembers[0], true).ok, true);
    const meeting = listMeetings(ws).find((m) => m.id === meetingId);
    assert.equal(meeting.attendance.find((a) => a.user_id === cabMembers[0]).present, 1);
  });

  test('awaitingCab lists the backlog, highest risk first, excluding scheduled items', () => {
    const { ws } = seededWorkspace(2);
    const low = newChange(ws, { risk_band: 'low' });
    const critical = newChange(ws, { risk_band: 'critical' });
    createApprovalQueue(ws, low);
    createApprovalQueue(ws, critical);

    let backlog = awaitingCab(ws);
    assert.equal(backlog.length, 2);
    assert.equal(backlog[0].risk_band, 'critical', 'the riskiest change is triaged first');

    // Once on an open agenda it leaves the backlog.
    const { meetingId } = createMeeting(ws, { title: 'CAB', ...window() });
    addToAgenda(ws, meetingId, critical.id);
    backlog = awaitingCab(ws);
    assert.deepEqual(backlog.map((b) => b.id), [low.id]);
  });
});
