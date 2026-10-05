import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  PriorityError, PRIORITIES, ensureMatrix, getMatrix, setCell, setMatrix, resetMatrix,
  derivePriority, resolvePriority, overrideReport,
} from './priorityMatrix.js';
import { findDuplicates, titleSimilarity, tokenise, recordCandidates, listCandidates, decideCandidate } from './duplicateDetection.js';
import { listFieldOptions } from './ticketFields.js';

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
function newTicket(ws, over = {}) {
  const id = uid('tkt');
  seq += 1;
  const r = {
    type: 'incident', title: 'Something broke', status: 'open', priority: 'medium',
    impact: null, urgency: null, category: null, subcategory: null, team: null,
    requester_id: null, created_at: new Date().toISOString(), priority_overridden: 0, ...over,
  };
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, status, priority, impact, urgency,
                          category, subcategory, team, requester_id, created_at, priority_overridden)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, ws, `INC-${2000 + seq}`, r.type, r.title, r.status, r.priority, r.impact, r.urgency,
    r.category, r.subcategory, r.team, r.requester_id, r.created_at, r.priority_overridden);
  return id;
}

describe('priority matrix: the grid itself', () => {
  test('a workspace gets a complete grid on first use', () => {
    const ws = newWorkspace();
    const m = getMatrix(ws);
    assert.equal(m.impacts.length, 3);
    assert.equal(m.urgencies.length, 3);
    assert.equal(Object.keys(m.cells).length, 9, 'every combination should be filled');
    assert.deepEqual(m.missing, [], 'no combination should be left undecided');
  });

  test('the baseline follows the specification: high impact + high urgency is critical', () => {
    const ws = newWorkspace();
    assert.equal(derivePriority(ws, 'high', 'high'), 'critical');
    assert.equal(derivePriority(ws, 'medium', 'medium'), 'medium');
    assert.equal(derivePriority(ws, 'low', 'low'), 'low');
    assert.equal(derivePriority(ws, 'low', 'high'), 'medium');
  });

  test('every cell produces one of the four real priorities', () => {
    const ws = newWorkspace();
    for (const p of Object.values(getMatrix(ws).cells)) assert.ok(PRIORITIES.includes(p), `${p} is not a priority`);
  });

  test('a combination nobody configured derives nothing rather than guessing', () => {
    const ws = newWorkspace();
    assert.equal(derivePriority(ws, 'high', 'nonexistent'), null);
    assert.equal(derivePriority(ws, 'high', null), null, 'a missing half cannot derive');
    assert.equal(derivePriority(ws, null, null), null);
  });

  test('a cell can be changed, and only to a real priority', () => {
    const ws = newWorkspace();
    setCell(ws, 'low', 'low', 'high');
    assert.equal(derivePriority(ws, 'low', 'low'), 'high');
    assert.throws(() => setCell(ws, 'low', 'low', 'catastrophic'), PriorityError);
    assert.throws(() => setCell(ws, 'not_a_value', 'low', 'high'), /impact value is not configured/);
    assert.throws(() => setCell(ws, 'low', 'not_a_value', 'high'), /urgency value is not configured/);
  });

  test('a failed bulk edit leaves the grid untouched', () => {
    const ws = newWorkspace();
    const before = getMatrix(ws).cells;
    assert.throws(() => setMatrix(ws, [
      { impact: 'low', urgency: 'low', priority: 'critical' },
      { impact: 'low', urgency: 'medium', priority: 'nonsense' },
    ]));
    assert.deepEqual(getMatrix(ws).cells, before, 'the valid cell should have rolled back with the invalid one');
  });

  test('adding an impact value extends the grid without losing edits', () => {
    const ws = newWorkspace();
    setCell(ws, 'high', 'low', 'critical');
    db.prepare('INSERT INTO ticket_field_options (id, workspace_id, field_key, value, label, sort_order) VALUES (?,?,?,?,?,?)')
      .run(uid('tfo'), ws, 'impact', 'catastrophic', 'Catastrophic', 9);
    const m = getMatrix(ws);
    assert.equal(m.impacts.length, 4);
    // The new row is filled in rather than left blank: a blank cell derives
    // nothing, so priority would silently stop updating for it.
    assert.deepEqual(m.missing, [], 'the new impact should have been given a starting row');
    assert.equal(Object.keys(m.cells).length, 12);
    for (const u of ['low', 'medium', 'high']) {
      assert.ok(PRIORITIES.includes(m.cells[`catastrophic|${u}`]), 'the new row has real priorities');
    }
    assert.equal(m.cells['high|low'], 'critical', 'the earlier edit survived');
  });

  test('setting one cell first does not stop the rest of the grid being built', () => {
    // ensureMatrix used to bail out as soon as ANY row existed, so a single
    // edit on a fresh workspace left the other eight combinations deriving
    // nothing, for good.
    const ws = newWorkspace();
    setCell(ws, 'high', 'high', 'high');
    const m = getMatrix(ws);
    assert.equal(Object.keys(m.cells).length, 9, 'the whole grid should still exist');
    assert.equal(m.cells['high|high'], 'high', 'the explicit edit was not overwritten');
    assert.equal(derivePriority(ws, 'low', 'low'), 'low', 'the rest still derives');
  });

  test('a grid row whose option was deleted is reported, not hidden', () => {
    const ws = newWorkspace();
    ensureMatrix(ws);
    db.prepare("DELETE FROM ticket_field_options WHERE workspace_id = ? AND field_key = 'urgency' AND value = 'low'").run(ws);
    const m = getMatrix(ws);
    assert.ok(m.orphans.length >= 1, 'rows for the removed value should still be surfaced');
    assert.ok(m.orphans.every((o) => o.urgency === 'low'));
  });

  test('resetting restores the baseline', () => {
    const ws = newWorkspace();
    setCell(ws, 'low', 'low', 'critical');
    resetMatrix(ws);
    assert.equal(derivePriority(ws, 'low', 'low'), 'low');
  });

  test('one workspace cannot see or change another grid', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    setCell(a, 'low', 'low', 'critical');
    assert.equal(derivePriority(a, 'low', 'low'), 'critical');
    assert.equal(derivePriority(b, 'low', 'low'), 'low');
  });
});

describe('priority matrix: deciding a ticket priority', () => {
  test('impact and urgency together set the priority', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    const out = resolvePriority(ws, null, { impact: 'high', urgency: 'high' }, user);
    assert.equal(out.fields.priority, 'critical');
    assert.equal(out.change.kind, 'derived');
  });

  test('changing urgency re-grades the ticket', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    const current = { impact: 'low', urgency: 'low', priority: 'low', priority_overridden: 0 };
    const out = resolvePriority(ws, current, { urgency: 'high' }, user);
    assert.equal(out.fields.priority, 'medium');
    assert.equal(out.change.from, 'low');
  });

  test('disagreeing with the grid requires a reason', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    assert.throws(
      () => resolvePriority(ws, null, { impact: 'low', urgency: 'low', priority: 'critical' }, user),
      (e) => {
        assert.ok(e instanceof PriorityError);
        assert.match(e.message, /give low/i);
        assert.equal(e.field_errors[0].field, 'priority_override_reason');
        return true;
      }
    );
  });

  test('an override records who did it and why', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    const out = resolvePriority(ws, null, {
      impact: 'low', urgency: 'low', priority: 'critical',
      priority_override_reason: 'CEO demo in ten minutes',
    }, user);
    assert.equal(out.fields.priority, 'critical');
    assert.equal(out.fields.priority_overridden, 1);
    assert.equal(out.fields.priority_override_reason, 'CEO demo in ten minutes');
    assert.equal(out.fields.priority_override_by, user.id);
    assert.ok(out.fields.priority_override_at);
    assert.equal(out.change.kind, 'overridden');
    assert.equal(out.change.derived, 'low');
  });

  test('agreeing with the grid is not an override and needs no reason', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    const out = resolvePriority(ws, null, { impact: 'high', urgency: 'high', priority: 'critical' }, user);
    assert.equal(out.fields.priority_overridden, 0);
    assert.equal(out.fields.priority_override_reason, null);
  });

  test('a whitespace-only reason does not count as a justification', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    assert.throws(() => resolvePriority(ws, null, {
      impact: 'low', urgency: 'low', priority: 'critical', priority_override_reason: '   ',
    }, user), PriorityError);
  });

  test('an override survives a later change to impact', () => {
    // The whole point of an override is that a person overruled the grid.
    // Re-deriving behind their back would undo that decision silently.
    const ws = newWorkspace();
    const user = newUser(ws);
    const current = { impact: 'low', urgency: 'low', priority: 'critical', priority_overridden: 1 };
    const out = resolvePriority(ws, current, { impact: 'medium' }, user);
    assert.equal(out.fields.priority, undefined, 'priority must not be rewritten');
    assert.equal(out.fields.impact, 'medium', 'the impact change itself still applies');
    assert.equal(out.change.kind, 'override_held');
    assert.equal(out.change.derived, 'medium');
  });

  test('setting the priority back to what the grid says clears the override', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    const current = { impact: 'low', urgency: 'low', priority: 'critical', priority_overridden: 1 };
    const out = resolvePriority(ws, current, { priority: 'low' }, user);
    assert.equal(out.fields.priority_overridden, 0);
    assert.equal(out.fields.priority_override_reason, null);
    assert.equal(out.change.kind, 'override_cleared');
  });

  test('with nothing to derive from, a priority is simply accepted', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    const out = resolvePriority(ws, null, { priority: 'high' }, user);
    assert.equal(out.fields.priority, 'high');
    assert.equal(out.change, null);
  });

  test('an invalid priority is refused whatever else is sent', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    assert.throws(() => resolvePriority(ws, null, { priority: 'urgent-ish' }, user), /must be one of/);
  });

  test('how often the grid is overruled is measurable', () => {
    const ws = newWorkspace();
    newTicket(ws, { impact: 'low', urgency: 'low', priority: 'low' });
    newTicket(ws, { impact: 'low', urgency: 'low', priority: 'critical', priority_overridden: 1 });
    const report = overrideReport(ws, { days: 30 });
    assert.equal(report.graded, 2);
    assert.equal(report.overridden, 1);
    assert.equal(report.override_rate, 50);
    assert.equal(report.combinations[0].grid_says, 'low', 'the report says what the grid would have given');
  });
});

describe('duplicate detection', () => {
  test('common words are stripped before comparing', () => {
    assert.ok(!tokenise('I am unable to access the printer').includes('unable'));
    assert.ok(tokenise('I am unable to access the printer').includes('printer'));
  });

  test('wording that differs only in noise words does not count as a match', () => {
    // Both are "unable to access X"; only the X matters.
    const sim = titleSimilarity('Unable to access the printer', 'Unable to access the VPN');
    assert.ok(sim < 0.4, `expected a weak match, got ${sim}`);
  });

  test('the same fault described twice scores highly', () => {
    const sim = titleSimilarity('Printer on 2nd floor not printing', 'Printer not printing 2nd floor');
    assert.ok(sim > 0.7, `expected a strong match, got ${sim}`);
  });

  test('a genuine repeat is suggested', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'requester');
    newTicket(ws, { title: 'VPN disconnects every few minutes', requester_id: user.id, category: 'Network' });
    const hits = findDuplicates(ws, { title: 'VPN disconnects every few minutes', requester_id: user.id, category: 'Network', type: 'incident' });
    assert.equal(hits.length, 1);
    assert.ok(hits[0].score > 0.5);
    assert.ok(hits[0].reasons.some((r) => r.signal === 'requester'));
  });

  test('sharing only a category and a team is not enough', () => {
    const ws = newWorkspace();
    newTicket(ws, { title: 'Monitor flickering at desk 14', category: 'Hardware', team: 'Desktop' });
    const hits = findDuplicates(ws, { title: 'Laptop battery will not charge', category: 'Hardware', team: 'Desktop', type: 'incident' });
    assert.deepEqual(hits, [], 'different faults in the same category must not be called duplicates');
  });

  test('a resolved ticket is not offered as a duplicate', () => {
    const ws = newWorkspace();
    newTicket(ws, { title: 'Printer jammed on floor two', status: 'resolved' });
    const hits = findDuplicates(ws, { title: 'Printer jammed on floor two', type: 'incident' });
    assert.deepEqual(hits, [], 'only active work can be a duplicate');
  });

  test('a different ticket type is never a duplicate', () => {
    const ws = newWorkspace();
    newTicket(ws, { title: 'Laptop replacement needed urgently', type: 'request' });
    const hits = findDuplicates(ws, { title: 'Laptop replacement needed urgently', type: 'incident' });
    assert.deepEqual(hits, []);
  });

  test('a ticket is never its own duplicate', () => {
    const ws = newWorkspace();
    const id = newTicket(ws, { title: 'Email not syncing on phone' });
    const hits = findDuplicates(ws, { id, title: 'Email not syncing on phone', type: 'incident' });
    assert.deepEqual(hits, []);
  });

  test('another workspace is never searched', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    newTicket(a, { title: 'Shared drive is unreachable' });
    assert.deepEqual(findDuplicates(b, { title: 'Shared drive is unreachable', type: 'incident' }), []);
  });

  test('old tickets fall out of the window', () => {
    const ws = newWorkspace();
    const old = new Date(Date.now() - 60 * 86400000).toISOString();
    newTicket(ws, { title: 'Badge reader offline at reception', created_at: old });
    assert.deepEqual(findDuplicates(ws, { title: 'Badge reader offline at reception', type: 'incident' }, { withinDays: 14 }), []);
    assert.equal(findDuplicates(ws, { title: 'Badge reader offline at reception', type: 'incident' }, { withinDays: 90 }).length, 1);
  });

  test('suggestions are stored, shown once, and can be dismissed', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    const original = newTicket(ws, { title: 'Wifi keeps dropping in the west wing' });
    const fresh = newTicket(ws, { title: 'Wifi keeps dropping in the west wing' });
    const hits = findDuplicates(ws, { id: fresh, title: 'Wifi keeps dropping in the west wing', type: 'incident' });
    assert.equal(hits.length, 1);

    recordCandidates(ws, fresh, hits);
    // Recording the same suggestion twice must not double it up.
    recordCandidates(ws, fresh, hits);
    let open = listCandidates(ws, fresh);
    assert.equal(open.length, 1);
    assert.equal(open[0].candidate_id, original);

    decideCandidate(ws, open[0].id, user, 'dismissed');
    assert.deepEqual(listCandidates(ws, fresh), [], 'a dismissed suggestion stops coming back');
    assert.equal(listCandidates(ws, fresh, { includeDismissed: true }).length, 1, 'but it is still on the record');
  });

  test('a suggestion can only be dismissed or confirmed', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    const a = newTicket(ws, { title: 'Door access card not working at gate' });
    const b = newTicket(ws, { title: 'Door access card not working at gate' });
    const [hit] = findDuplicates(ws, { id: b, title: 'Door access card not working at gate', type: 'incident' });
    const [cand] = recordCandidates(ws, b, [hit]);
    assert.throws(() => decideCandidate(ws, cand.id, user, 'maybe'), /dismissed or confirmed/);
    assert.ok(a);
  });
});
