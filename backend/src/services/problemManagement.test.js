import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  ProblemError, PROBLEM_STATES, get, setState, updateProblem, transitionGuards,
  declareKnownError, revokeKnownError, linkIncident, unlinkIncident, listIncidents,
  addRcaStep, deleteRcaStep, listRcaSteps,
  addAction, updateAction, listActions, knownErrors, meta,
} from './problemManagement.js';
import { refreshCandidates, listCandidates, dismissCandidate, problemTrends } from './problemDetection.js';

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
// Column list built from the overrides rather than hardcoded, so a field
// passed in is always actually written. Spelling out the columns meant
// root_cause_detail was silently dropped, and the guard tests then "failed"
// against a problem that genuinely had no root cause.
const TICKET_COLUMNS = [
  'type', 'title', 'status', 'priority', 'category', 'subcategory', 'created_at',
  'problem_state', 'root_cause_detail', 'root_cause_category', 'workaround',
  'is_known_error', 'residual_risk_accepted', 'residual_risk_reason', 'impact', 'urgency',
];
function newTicket(ws, over = {}) {
  const id = uid('tkt');
  seq += 1;
  const row = {
    type: 'incident', title: 'Something broke', status: 'open', priority: 'medium',
    created_at: new Date().toISOString(), ...over,
  };
  const cols = TICKET_COLUMNS.filter((c) => row[c] !== undefined);
  for (const k of Object.keys(over)) {
    if (!TICKET_COLUMNS.includes(k)) throw new Error(`test helper cannot set unknown column: ${k}`);
  }
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, ${cols.join(', ')})
     VALUES (?,?,?,${cols.map(() => '?').join(',')})`
  ).run(id, ws, `T-${3000 + seq}`, ...cols.map((c) => row[c]));
  return id;
}
const newProblem = (ws, over = {}) => newTicket(ws, { type: 'problem', title: 'Recurring fault', problem_state: 'logged', ...over });
function newAsset(ws, name = 'SRV-01') {
  const id = uid('ast');
  db.prepare('INSERT INTO assets (id, workspace_id, name, tag) VALUES (?,?,?,?)').run(id, ws, name, `TAG-${id.slice(-6)}`);
  return id;
}
const attach = (ticketId, assetId) =>
  db.prepare('INSERT INTO ticket_assets (id, ticket_id, asset_id) VALUES (?,?,?)').run(uid('ta'), ticketId, assetId);

describe('problem lifecycle', () => {
  test('the states and their exits are described for the UI', () => {
    const m = meta();
    assert.equal(m.states.length, 9);
    assert.ok(m.rca_methods.some((r) => r.key === 'five_whys'));
    assert.ok(m.root_cause_categories.length >= 10);
    // Every "next" state must itself be a real state, or the UI would offer a
    // transition that cannot be taken.
    for (const s of m.states) for (const n of s.next) assert.ok(PROBLEM_STATES[n], `${s.key} points at unknown state ${n}`);
  });

  test('a problem moves along its lifecycle', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws, { problem_state: 'identified' });
    assert.equal(setState(ws, id, user, 'logged').problem_state, 'logged');
    assert.equal(setState(ws, id, user, 'investigation').problem_state, 'investigation');
  });

  test('it cannot skip to a state that does not follow', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws, { problem_state: 'identified' });
    assert.throws(() => setState(ws, id, user, 'resolved'), (e) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /can move to/);
      return true;
    });
  });

  test('a known error must give people a workaround', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws, { problem_state: 'investigation' });
    assert.throws(() => setState(ws, id, user, 'known_error'), (e) => {
      assert.equal(e.field_errors[0].field, 'workaround');
      return true;
    });
    updateProblem(ws, id, user, { workaround: 'Restart the print spooler' });
    assert.equal(setState(ws, id, user, 'known_error').problem_state, 'known_error');
  });

  test('a fix cannot be planned before the cause is written down', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws, { problem_state: 'investigation' });
    setState(ws, id, user, 'rca');
    assert.throws(() => setState(ws, id, user, 'fix_planned'), (e) => {
      assert.equal(e.field_errors[0].field, 'root_cause_detail');
      return true;
    });
  });

  test('resolving needs either a root cause or an accepted risk', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws, { problem_state: 'investigation' });
    updateProblem(ws, id, user, { workaround: 'Use the spare printer' });
    setState(ws, id, user, 'known_error');
    assert.throws(() => setState(ws, id, user, 'resolved'), (e) => {
      assert.ok(e.field_errors.some((b) => b.field === 'root_cause_detail'), JSON.stringify(e.field_errors));
      return true;
    });

    // Accepting the risk is a legitimate ending, but it needs its own reason.
    updateProblem(ws, id, user, { residual_risk_accepted: true });
    assert.throws(() => setState(ws, id, user, 'resolved'), (e) => {
      assert.ok(e.field_errors.some((b) => b.field === 'residual_risk_reason'));
      return true;
    });
    updateProblem(ws, id, user, { residual_risk_reason: 'Hardware retires next quarter' });
    assert.equal(setState(ws, id, user, 'resolved').problem_state, 'resolved');
  });

  test('open corrective actions block resolution', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws, { problem_state: 'investigation', root_cause_detail: 'Disk filled' });
    addAction(ws, id, user, { title: 'Add disk monitoring' });
    setState(ws, id, user, 'rca');
    setState(ws, id, user, 'fix_planned');
    assert.throws(() => setState(ws, id, user, 'resolved'), (e) => {
      assert.ok(e.field_errors.some((b) => b.field === 'actions'));
      return true;
    });
    const [action] = listActions(ws, id);
    updateAction(ws, action.id, user, { status: 'done' });
    assert.equal(setState(ws, id, user, 'resolved').problem_state, 'resolved');
  });

  test('a guard can be overridden, and the override is on the record', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws, { problem_state: 'investigation' });
    setState(ws, id, user, 'known_error', { force: true });
    const events = db.prepare("SELECT detail FROM ticket_history WHERE ticket_id = ? AND event = 'problem_state'").all(id);
    assert.match(events.at(-1).detail, /forced past/i);
  });

  test('resolving and closing keep the generic status in step', () => {
    // The rest of the app queries status, not problem_state, so a resolved
    // problem has to leave the open queues on its own.
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws, { problem_state: 'fix_planned', root_cause_detail: 'Cause found' });
    setState(ws, id, user, 'resolved');
    assert.equal(db.prepare('SELECT status FROM tickets WHERE id = ?').get(id).status, 'resolved');
    setState(ws, id, user, 'closed');
    const row = db.prepare('SELECT status, closed_at FROM tickets WHERE id = ?').get(id);
    assert.equal(row.status, 'closed');
    assert.ok(row.closed_at);
  });

  test('reopening a resolved problem puts it back into the open queues', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws, { problem_state: 'fix_planned', root_cause_detail: 'Cause found' });
    setState(ws, id, user, 'resolved');
    setState(ws, id, user, 'investigation');
    const row = db.prepare('SELECT status, resolved_at FROM tickets WHERE id = ?').get(id);
    assert.equal(row.status, 'in_progress');
    assert.equal(row.resolved_at, null, 'the old resolution date must not linger');
  });

  test('another workspace cannot reach the problem', () => {
    const a = newWorkspace(); const b = newWorkspace();
    const id = newProblem(a);
    assert.throws(() => get(b, id), (e) => e.status === 404);
  });
});

describe('known errors', () => {
  test('declaring one publishes the workaround and stamps it', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws, { problem_state: 'investigation' });
    const out = declareKnownError(ws, id, user, { workaround: 'Clear the cache folder' });
    assert.equal(out.is_known_error, 1);
    assert.ok(out.known_error_at);
    assert.equal(out.problem_state, 'known_error', 'it should move the problem along too');
  });

  test('it cannot be declared with nothing for people to do', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws);
    assert.throws(() => declareKnownError(ws, id, user, { workaround: '   ' }), (e) => {
      assert.equal(e.field_errors[0].field, 'workaround');
      return true;
    });
  });

  test('the register lists every published workaround, and is searchable', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const a = newProblem(ws, { title: 'Printer spooler crashes' });
    const b = newProblem(ws, { title: 'VPN drops on wifi' });
    newProblem(ws, { title: 'Not a known error' });
    declareKnownError(ws, a, user, { workaround: 'Restart the spooler service' });
    declareKnownError(ws, b, user, { workaround: 'Switch to the wired network' });
    assert.equal(knownErrors(ws).length, 2);
    assert.equal(knownErrors(ws, { q: 'spooler' }).length, 1);
  });

  test('a known error can be withdrawn', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newProblem(ws);
    declareKnownError(ws, id, user, { workaround: 'Temporary fix' });
    assert.equal(revokeKnownError(ws, id, user).is_known_error, 0);
    assert.equal(knownErrors(ws).length, 0);
  });
});

describe('linking incidents', () => {
  test('incidents are linked and counted', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws);
    const i1 = newTicket(ws); const i2 = newTicket(ws);
    linkIncident(ws, p, user, i1);
    linkIncident(ws, p, user, i2);
    assert.equal(get(ws, p).incident_count, 2);
  });

  test('the same incident cannot be linked twice', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws); const i = newTicket(ws);
    linkIncident(ws, p, user, i);
    assert.throws(() => linkIncident(ws, p, user, i), (e) => e.status === 409);
  });

  test('a problem cannot explain itself or another problem', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws); const other = newProblem(ws);
    assert.throws(() => linkIncident(ws, p, user, p), /cannot explain itself/);
    assert.throws(() => linkIncident(ws, p, user, other), /not other problems/);
  });

  test('an incident from another workspace cannot be linked', () => {
    const a = newWorkspace(); const b = newWorkspace(); const user = newUser(a);
    const p = newProblem(a);
    assert.throws(() => linkIncident(a, p, user, newTicket(b)), (e) => e.status === 404);
  });

  test('unlinking removes it', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws); const i = newTicket(ws);
    linkIncident(ws, p, user, i);
    assert.equal(unlinkIncident(ws, p, user, i).length, 0);
  });
});

describe('root cause analysis', () => {
  test('steps are ordered and kept contiguous when one is removed', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws);
    addRcaStep(ws, p, user, { content: 'The disk filled' });
    addRcaStep(ws, p, user, { content: 'Logs were never rotated' });
    addRcaStep(ws, p, user, { content: 'The rotation job was disabled' });
    assert.deepEqual(listRcaSteps(ws, p).map((s) => s.sequence), [0, 1, 2]);

    deleteRcaStep(ws, listRcaSteps(ws, p)[1].id);
    const after = listRcaSteps(ws, p);
    assert.deepEqual(after.map((s) => s.sequence), [0, 1], 'a gap would read as a lost step');
    assert.deepEqual(after.map((s) => s.content), ['The disk filled', 'The rotation job was disabled']);
  });

  test('an empty step is refused', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    assert.throws(() => addRcaStep(ws, newProblem(ws), user, { content: '  ' }), (e) => {
      assert.equal(e.field_errors[0].field, 'content');
      return true;
    });
  });

  test('an unknown analysis method is refused', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws);
    assert.throws(() => updateProblem(ws, p, user, { rca_method: 'tea_leaves' }), /Unknown analysis method/);
    assert.doesNotThrow(() => updateProblem(ws, p, user, { rca_method: 'five_whys' }));
  });

  test('an unknown root cause category is refused', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    assert.throws(() => updateProblem(ws, newProblem(ws), user, { root_cause_category: 'gremlins' }), /Unknown root cause/);
  });
});

describe('corrective actions', () => {
  test('an action tracks its owner, date and completion', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const owner = newUser(ws);
    const p = newProblem(ws);
    addAction(ws, p, user, { title: 'Re-enable log rotation', owner_id: owner.id, due_date: '2026-12-01' });
    const [a] = listActions(ws, p);
    assert.equal(a.status, 'open');
    assert.equal(a.owner_id, owner.id);
    updateAction(ws, a.id, user, { status: 'done' });
    assert.ok(listActions(ws, p)[0].completed_at);
  });

  test('reopening an action clears its completion date', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws);
    addAction(ws, p, user, { title: 'Patch the server' });
    const [a] = listActions(ws, p);
    updateAction(ws, a.id, user, { status: 'done' });
    updateAction(ws, a.id, user, { status: 'in_progress' });
    assert.equal(listActions(ws, p)[0].completed_at, null, 'a reopened action cannot keep a completion date');
  });

  test('overdue actions are counted on the problem', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws);
    addAction(ws, p, user, { title: 'Overdue thing', due_date: '2020-01-01' });
    addAction(ws, p, user, { title: 'Future thing', due_date: '2099-01-01' });
    const out = get(ws, p);
    assert.equal(out.open_actions, 2);
    assert.equal(out.overdue_actions, 1);
  });

  test('an unknown owner is refused', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    assert.throws(() => addAction(ws, newProblem(ws), user, { title: 'x', owner_id: 'usr_nope' }), /owner does not exist/);
  });

  test('an invalid status is refused', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws);
    addAction(ws, p, user, { title: 'x' });
    const [a] = listActions(ws, p);
    assert.throws(() => updateAction(ws, a.id, user, { status: 'nearly' }), /must be one of/);
  });
});

describe('detecting problems nobody has raised', () => {
  const manyIncidents = (ws, n, over) => {
    for (let i = 0; i < n; i++) newTicket(ws, over);
  };

  test('a category seen over and over is proposed', () => {
    const ws = newWorkspace();
    manyIncidents(ws, 5, { category: 'Printing', subcategory: 'Spooler' });
    const candidates = refreshCandidates(ws);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].incident_count, 5);
    assert.match(candidates[0].label, /Printing/);
    assert.ok(candidates[0].incidents.length > 0, 'the evidence travels with the suggestion');
  });

  test('a handful of unrelated incidents is not proposed', () => {
    const ws = newWorkspace();
    manyIncidents(ws, 2, { category: 'Printing' });
    manyIncidents(ws, 2, { category: 'Network' });
    assert.deepEqual(refreshCandidates(ws), []);
  });

  test('repeat faults on one machine are proposed at a lower threshold', () => {
    // Three incidents against one server is already a pattern; three in a
    // category the size of "Network" is a Tuesday.
    const ws = newWorkspace();
    const asset = newAsset(ws, 'SRV-PAYROLL');
    for (let i = 0; i < 3; i++) attach(newTicket(ws, { category: `Cat${i}` }), asset);
    const candidates = refreshCandidates(ws);
    assert.ok(candidates.some((c) => c.basis === 'asset' && c.label === 'SRV-PAYROLL'), JSON.stringify(candidates));
  });

  test('incidents already explained by a problem stop being counted', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    manyIncidents(ws, 5, { category: 'Printing' });
    assert.equal(refreshCandidates(ws).length, 1);

    const p = newProblem(ws);
    for (const t of db.prepare("SELECT id FROM tickets WHERE workspace_id = ? AND type = 'incident'").all(ws)) {
      linkIncident(ws, p, user, t.id);
    }
    assert.deepEqual(refreshCandidates(ws), [], 'once somebody is investigating, stop proposing it');
  });

  test('a dismissed suggestion stays dismissed', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    manyIncidents(ws, 5, { category: 'Printing' });
    const [c] = refreshCandidates(ws);
    dismissCandidate(ws, c.id, user);
    assert.deepEqual(refreshCandidates(ws), [], 'being told twice is why people stop reading these');
  });

  test('but a dismissed cluster that doubles is raised again', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    manyIncidents(ws, 5, { category: 'Printing' });
    const [c] = refreshCandidates(ws);
    dismissCandidate(ws, c.id, user);
    manyIncidents(ws, 6, { category: 'Printing' });
    const again = refreshCandidates(ws);
    assert.equal(again.length, 1, 'a fault that has doubled deserves asking about again');
    assert.equal(again[0].incident_count, 11);
  });

  test('a cluster that falls back below the threshold stops being proposed', () => {
    const ws = newWorkspace();
    manyIncidents(ws, 5, { category: 'Printing' });
    assert.equal(refreshCandidates(ws).length, 1);
    db.prepare("DELETE FROM tickets WHERE workspace_id = ? AND category = 'Printing'").run(ws);
    assert.deepEqual(refreshCandidates(ws), []);
  });

  test('old incidents fall outside the detection window', () => {
    const ws = newWorkspace();
    const old = new Date(Date.now() - 120 * 86400000).toISOString();
    manyIncidents(ws, 6, { category: 'Printing', created_at: old });
    assert.deepEqual(refreshCandidates(ws, { withinDays: 30 }), []);
    assert.equal(refreshCandidates(ws, { withinDays: 200 }).length, 1);
  });

  test('an option passed as undefined falls back to the default', () => {
    // Writing `minIncidents: Number(req.body.min) || undefined` is the natural
    // way to express an optional parameter, and spreading that over the
    // defaults replaced the threshold with undefined -- which reached SQLite
    // as NULL, made `HAVING n >= NULL` never true, and silently found nothing.
    const ws = newWorkspace();
    for (let i = 0; i < 5; i++) newTicket(ws, { category: 'Printing' });
    assert.equal(refreshCandidates(ws, { minIncidents: undefined, withinDays: undefined }).length, 1);
    assert.equal(refreshCandidates(ws, { minIncidents: NaN }).length, 1);
  });

  test('one workspace never sees another workspace pattern', () => {
    const a = newWorkspace(); const b = newWorkspace();
    manyIncidents(a, 6, { category: 'Printing' });
    assert.deepEqual(refreshCandidates(b), []);
  });
});

describe('problem trends', () => {
  test('the practice reports on itself', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws, { root_cause_category: 'capacity', root_cause_detail: 'Disk filled' });
    for (let i = 0; i < 3; i++) linkIncident(ws, p, user, newTicket(ws));
    declareKnownError(ws, p, user, { workaround: 'Clear the archive folder' });
    addAction(ws, p, user, { title: 'Overdue fix', due_date: '2020-01-01' });

    const t = problemTrends(ws);
    assert.equal(t.counts.total, 1);
    assert.equal(t.counts.known_errors, 1);
    assert.equal(t.counts.with_root_cause, 1);
    assert.equal(t.top_problems[0].incident_count, 3);
    assert.ok(t.by_root_cause.some((r) => r.category === 'capacity'));
    assert.equal(t.overdue_actions.length, 1);
  });

  test('coverage says how many incidents are being explained at all', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const p = newProblem(ws);
    for (let i = 0; i < 4; i++) newTicket(ws);
    const incidents = db.prepare("SELECT id FROM tickets WHERE workspace_id = ? AND type = 'incident'").all(ws);
    linkIncident(ws, p, user, incidents[0].id);
    const t = problemTrends(ws);
    assert.equal(t.coverage.incidents, 4);
    assert.equal(t.coverage.explained, 1);
    assert.equal(t.coverage.percent, 25);
  });
});
