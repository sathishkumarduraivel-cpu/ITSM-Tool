import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  ensureDefaultFieldPolicy, getFieldPolicy, saveFieldPolicy, accessFor,
  policyForState, checkEdit, missingRequired, GOVERNABLE_FIELDS, ACCESS_LEVELS,
} from './changeFieldPolicy.js';
import { STATE_KEYS } from './changeWorkflow.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

const change = (state, over = {}) => ({
  id: 'tkt_1', type: 'change', change_state: state,
  title: 'Patch the payments cluster', description: 'desc', category: 'Infrastructure',
  implementation_plan: 'Apply the patch', rollback_plan: 'Restore the snapshot', test_plan: null,
  priority: 'high', impact: 'high', risk: 'high', planned_start: '2026-10-01 20:00:00',
  planned_end: '2026-10-01 22:00:00', assignee_id: null, team: null, subcategory: null,
  ...over,
});

describe('changeFieldPolicy: defaults', () => {
  test('every change state is represented', () => {
    const ws = newWorkspace();
    const policy = getFieldPolicy(ws);
    assert.deepEqual(Object.keys(policy).sort(), [...STATE_KEYS].sort());
  });

  test('early states leave everything open', () => {
    const ws = newWorkspace();
    const policy = getFieldPolicy(ws);
    assert.deepEqual(policy.new, {});
    assert.deepEqual(policy.in_review, {});
  });

  test('the plans freeze once the change is with the CAB', () => {
    const ws = newWorkspace();
    const policy = getFieldPolicy(ws);
    assert.equal(policy.pending_approval.implementation_plan, 'readonly');
    assert.equal(policy.pending_approval.rollback_plan, 'readonly');
  });

  test('the schedule freezes once the change is scheduled, not before', () => {
    const ws = newWorkspace();
    const policy = getFieldPolicy(ws);
    assert.equal(policy.approved.planned_start, undefined, 'still movable after approval');
    assert.equal(policy.scheduled.planned_start, 'readonly');
  });

  test('a closed change is entirely read-only', () => {
    const ws = newWorkspace();
    const policy = getFieldPolicy(ws);
    for (const f of GOVERNABLE_FIELDS) assert.equal(policy.closed[f.key], 'readonly', f.key);
  });

  test('seeding happens once, not on every read', () => {
    const ws = newWorkspace();
    ensureDefaultFieldPolicy(ws);
    const first = db.prepare('SELECT COUNT(*) c FROM change_state_field_rules WHERE workspace_id = ?').get(ws).c;
    ensureDefaultFieldPolicy(ws);
    getFieldPolicy(ws);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM change_state_field_rules WHERE workspace_id = ?').get(ws).c, first);
  });

  test('one workspace policy does not leak into another', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    saveFieldPolicy(a, { new: { title: 'readonly' } });
    assert.equal(accessFor(a, 'new', 'title'), 'readonly');
    assert.equal(accessFor(b, 'new', 'title'), 'editable');
  });
});

describe('changeFieldPolicy: enforcement', () => {
  test('a locked field cannot be edited in that state', () => {
    const ws = newWorkspace();
    const result = checkEdit(ws, change('approved'), { implementation_plan: 'Something else entirely' });
    assert.ok(result, 'should have been refused');
    assert.deepEqual(result.fields, ['implementation_plan']);
    assert.match(result.error, /Implementation plan cannot be edited while this change is Approved/);
  });

  test('the same field is fine in an earlier state', () => {
    const ws = newWorkspace();
    assert.equal(checkEdit(ws, change('new'), { implementation_plan: 'Rewritten' }), null);
    assert.equal(checkEdit(ws, change('in_review'), { implementation_plan: 'Rewritten' }), null);
  });

  test('an unlocked field is still editable in a locked state', () => {
    const ws = newWorkspace();
    assert.equal(checkEdit(ws, change('approved'), { assignee_id: 'usr_1' }), null);
  });

  test('every blocked field is named, not just the first', () => {
    const ws = newWorkspace();
    const result = checkEdit(ws, change('scheduled'), {
      implementation_plan: 'x', rollback_plan: 'y', planned_start: '2026-11-01 09:00:00',
    });
    assert.deepEqual(result.fields.sort(), ['implementation_plan', 'planned_start', 'rollback_plan']);
  });

  test('re-posting the value a field already holds is allowed', () => {
    // A form that PUTs every field back must still be able to save the one
    // thing that did change.
    const ws = newWorkspace();
    const ticket = change('approved');
    assert.equal(checkEdit(ws, ticket, {
      implementation_plan: ticket.implementation_plan,
      rollback_plan: ticket.rollback_plan,
      assignee_id: 'usr_2',
    }), null);
  });

  test('a null and an empty string count as the same unchanged value', () => {
    const ws = newWorkspace();
    const ticket = change('approved', { test_plan: null });
    assert.equal(checkEdit(ws, ticket, { test_plan: '' }), null);
  });

  test('non-change tickets are never governed by this', () => {
    const ws = newWorkspace();
    const incident = { ...change('closed'), type: 'incident' };
    assert.equal(checkEdit(ws, incident, { title: 'anything' }), null);
  });

  test('a change with no state yet is not governed', () => {
    const ws = newWorkspace();
    assert.equal(checkEdit(ws, change(null), { implementation_plan: 'x' }), null);
  });

  test('a closed change refuses edits to everything', () => {
    const ws = newWorkspace();
    const result = checkEdit(ws, change('closed'), { title: 'Renamed after the fact' });
    assert.ok(result);
    assert.match(result.error, /Closed/);
  });
});

describe('changeFieldPolicy: administration', () => {
  test('the grid can be replaced wholesale', () => {
    const ws = newWorkspace();
    const saved = saveFieldPolicy(ws, {
      new: { title: 'readonly' },
      approved: { priority: 'readonly', team: 'required' },
    });
    assert.equal(saved.new.title, 'readonly');
    assert.equal(saved.approved.priority, 'readonly');
    assert.equal(saved.approved.team, 'required');
    assert.equal(saved.scheduled.implementation_plan, undefined, 'the defaults were replaced, not merged');
  });

  test('editable is stored as absence rather than a row', () => {
    const ws = newWorkspace();
    saveFieldPolicy(ws, { approved: { title: 'editable', priority: 'readonly' } });
    assert.equal(getFieldPolicy(ws).approved.title, undefined);
    assert.equal(accessFor(ws, 'approved', 'title'), 'editable');
  });

  test('clearing the whole grid means everything editable, and stays cleared', () => {
    const ws = newWorkspace();
    ensureDefaultFieldPolicy(ws);
    saveFieldPolicy(ws, {});
    assert.equal(accessFor(ws, 'closed', 'title'), 'editable');
    // The lazy seeder must not helpfully put the defaults back on next read.
    assert.equal(getFieldPolicy(ws).closed.title, undefined);
    assert.equal(checkEdit(ws, change('closed'), { title: 'Now allowed' }), null);
  });

  test('an unknown state, field or access level is refused', () => {
    const ws = newWorkspace();
    assert.throws(() => saveFieldPolicy(ws, { nonsense: { title: 'readonly' } }), /Unknown change state/);
    assert.throws(() => saveFieldPolicy(ws, { new: { nonsense: 'readonly' } }), /Unknown field/);
    assert.throws(() => saveFieldPolicy(ws, { new: { title: 'invisible' } }), /Unknown access level/);
  });

  test('a rejected save leaves the previous policy untouched', () => {
    const ws = newWorkspace();
    saveFieldPolicy(ws, { approved: { priority: 'readonly' } });
    assert.throws(() => saveFieldPolicy(ws, { approved: { priority: 'readonly' }, nonsense: {} }));
    assert.equal(accessFor(ws, 'approved', 'priority'), 'readonly');
  });

  test('access levels are exactly the three the UI offers', () => {
    assert.deepEqual(ACCESS_LEVELS, ['editable', 'readonly', 'required']);
  });
});

describe('changeFieldPolicy: what the UI is handed', () => {
  test('a state resolves to the lists the form needs', () => {
    const ws = newWorkspace();
    const view = policyForState(ws, 'scheduled');
    assert.equal(view.state_label, 'Scheduled');
    assert.ok(view.readonly.includes('planned_start'));
    assert.equal(view.fields.length, GOVERNABLE_FIELDS.length, 'every field is listed, with its access');
    assert.equal(view.fields.find((f) => f.key === 'assignee_id').access, 'editable');
  });

  test('an unknown state degrades to everything editable', () => {
    const ws = newWorkspace();
    const view = policyForState(ws, 'not_a_state');
    assert.deepEqual(view.readonly, []);
  });

  test('required fields that are empty are reported', () => {
    const ws = newWorkspace();
    saveFieldPolicy(ws, { approved: { test_plan: 'required', team: 'required' } });
    const missing = missingRequired(ws, change('approved', { test_plan: null, team: 'Network' }));
    assert.deepEqual(missing.map((m) => m.field), ['test_plan']);
  });

  test('a stored rule for a field that no longer exists is ignored', () => {
    const ws = newWorkspace();
    ensureDefaultFieldPolicy(ws);
    db.prepare('INSERT INTO change_state_field_rules (id, workspace_id, state_key, field_key, access) VALUES (?,?,?,?,?)')
      .run(uid('csf'), ws, 'approved', 'a_field_we_removed', 'readonly');
    assert.equal(getFieldPolicy(ws).approved.a_field_we_removed, undefined);
    assert.equal(checkEdit(ws, change('approved'), { a_field_we_removed: 'x' }), null);
  });
});
