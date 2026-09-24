import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  validateSchema, validateSubmission, visibleFields, evaluateCondition, describeSubmission, parseSchema,
} from './catalogForms.js';
import {
  createItem, updateItem, deleteItem, getItem, listItems, hydrateItem,
  isEntitled, addEntitlement, removeEntitlement, listEntitlements,
  addApprovalStage, updateApprovalStage, listApprovalStages, resolveApprovalChain,
  addFulfilmentTask, listFulfilmentTasks, createFulfilmentTasks,
} from './catalogItems.js';
import { catalogOverview, itemPerformance, approvalBottlenecks } from './catalogAnalytics.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'T ' + id, id);
  return id;
}
function newUser(ws, role = 'requester', { team = null, managerId = null } = {}) {
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, name, email, password_hash, role, team) VALUES (?,?,?,?,?,?)')
    .run(id, role + '-' + id.slice(-4), `${id}@x.local`, 'x', role, team);
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, active, manager_id) VALUES (?,?,?,?,1,?)')
    .run(uid('wm'), ws, id, role, managerId);
  return { id, role, permissions: [], team };
}
const admin = (ws) => ({ ...newUser(ws, 'admin'), role: 'admin', permissions: ['catalog.manage'] });

function newGroup(ws, name = 'Desktop', managerId = null) {
  const id = uid('grp');
  db.prepare('INSERT INTO groups (id, workspace_id, name, manager_user_id) VALUES (?,?,?,?)').run(id, ws, name, managerId);
  return id;
}
const addToGroup = (groupId, userId) => db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)')
  .run(uid('gm'), groupId, userId);

const item = (ws, over = {}) => createItem(ws, {
  name: over.name || 'New laptop',
  description: 'A laptop',
  status: 'published',
  ...over,
});

function ticketFor(ws, itemId, requesterId) {
  const id = uid('tkt');
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, status, source, catalog_item_id, requester_id)
     VALUES (?,?,?,'request',?,?,'catalog',?,?)`
  ).run(id, ws, 'REQ-' + id.slice(-5), 'req', 'open', itemId, requesterId);
  return id;
}

// ================================================================= forms ===

describe('catalog forms: schema validation', () => {
  test('a good schema passes', () => {
    assert.deepEqual(validateSchema([
      { key: 'model', label: 'Model', type: 'select', options: ['13"', '16"'] },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ]), []);
  });

  test('a choice field with no options is caught at save time, not order time', () => {
    const errors = validateSchema([{ key: 'model', label: 'Model', type: 'select' }]);
    assert.ok(errors.some((e) => /at least one option/.test(e)), JSON.stringify(errors));
  });

  test('duplicate and malformed keys are refused', () => {
    const errors = validateSchema([
      { key: 'a', label: 'A', type: 'text' },
      { key: 'a', label: 'Again', type: 'text' },
      { key: 'Bad Key', label: 'B', type: 'text' },
    ]);
    assert.ok(errors.some((e) => /used more than once/.test(e)));
    assert.ok(errors.some((e) => /lowercase letters/.test(e)));
  });

  test('an unknown field type is refused', () => {
    assert.ok(validateSchema([{ key: 'a', label: 'A', type: 'slider' }]).some((e) => /unknown field type/i.test(e)));
  });

  test('a condition pointing at a field that does not exist is refused', () => {
    const errors = validateSchema([
      { key: 'a', label: 'A', type: 'text', show_when: { field: 'ghost', op: 'equals', value: 'x' } },
    ]);
    assert.ok(errors.some((e) => /not a field on this form/.test(e)), JSON.stringify(errors));
  });

  test('a field cannot depend on itself', () => {
    const errors = validateSchema([{ key: 'a', label: 'A', type: 'text', show_when: { field: 'a', value: 'x' } }]);
    assert.ok(errors.some((e) => /cannot depend on itself/.test(e)));
  });

  test('a broken regex is caught', () => {
    assert.ok(validateSchema([{ key: 'a', label: 'A', type: 'text', pattern: '([' }])
      .some((e) => /not a valid regular expression/.test(e)));
  });
});

describe('catalog forms: conditional visibility', () => {
  const schema = [
    { key: 'for_self', label: 'For me?', type: 'checkbox' },
    { key: 'colleague', label: 'Who for', type: 'user', show_when: { field: 'for_self', op: 'equals', value: 'false' } },
    { key: 'reason', label: 'Why', type: 'text', required: true, show_when: { field: 'colleague', op: 'is_not_empty' } },
  ];

  test('a hidden field stays hidden', () => {
    assert.deepEqual(visibleFields(schema, { for_self: true }).map((f) => f.key), ['for_self']);
  });

  test('answering reveals the next question', () => {
    assert.deepEqual(visibleFields(schema, { for_self: false }).map((f) => f.key), ['for_self', 'colleague']);
  });

  test('and the one after that', () => {
    assert.deepEqual(
      visibleFields(schema, { for_self: false, colleague: 'usr_1' }).map((f) => f.key),
      ['for_self', 'colleague', 'reason'],
    );
  });

  test('hiding a controller hides everything under it', () => {
    // colleague is hidden, so reason must be too even though it has a value.
    assert.deepEqual(visibleFields(schema, { for_self: true, colleague: 'usr_1' }).map((f) => f.key), ['for_self']);
  });

  test('every operator behaves', () => {
    assert.equal(evaluateCondition({ field: 'a', op: 'equals', value: '5' }, { a: 5 }), true);
    assert.equal(evaluateCondition({ field: 'a', op: 'not_equals', value: '5' }, { a: 6 }), true);
    assert.equal(evaluateCondition({ field: 'a', op: 'gt', value: '5' }, { a: 6 }), true);
    assert.equal(evaluateCondition({ field: 'a', op: 'lt', value: '5' }, { a: 4 }), true);
    assert.equal(evaluateCondition({ field: 'a', op: 'contains', value: 'ap' }, { a: 'laptop' }), true, 'lAPtop');
    assert.equal(evaluateCondition({ field: 'a', op: 'contains', value: 'zz' }, { a: 'laptop' }), false);
    assert.equal(evaluateCondition({ field: 'a', op: 'contains', value: 'top' }, { a: 'laptop' }), true);
    assert.equal(evaluateCondition({ field: 'a', op: 'contains', value: 'x' }, { a: ['x', 'y'] }), true);
    assert.equal(evaluateCondition({ field: 'a', op: 'is_empty' }, { a: '' }), true);
    assert.equal(evaluateCondition({ field: 'a', op: 'is_not_empty' }, { a: 'v' }), true);
  });
});

describe('catalog forms: submission validation', () => {
  const ws = newWorkspace();
  const schema = [
    { key: 'model', label: 'Model', type: 'select', options: ['13', '16'], required: true },
    { key: 'qty', label: 'Screens', type: 'number', min: 1, max: 3 },
    { key: 'email', label: 'Contact', type: 'email' },
    { key: 'when', label: 'Needed by', type: 'date' },
    { key: 'extras', label: 'Extras', type: 'multiselect', options: ['dock', 'case'] },
  ];

  test('good answers come back typed', () => {
    const r = validateSubmission(ws, schema, { model: '13', qty: '2', extras: 'dock,case' });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.values.qty, 2);
    assert.deepEqual(r.values.extras, ['dock', 'case']);
  });

  test('a required answer that is missing is refused, and named', () => {
    const r = validateSubmission(ws, schema, { qty: 1 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.field === 'model'));
  });

  test('a value that was never an option is refused', () => {
    const r = validateSubmission(ws, schema, { model: '17' });
    assert.ok(r.errors.some((e) => /not one of the options/.test(e.message)));
  });

  test('numbers are range-checked', () => {
    assert.ok(validateSubmission(ws, schema, { model: '13', qty: '9' }).errors.some((e) => /at most 3/.test(e.message)));
    assert.ok(validateSubmission(ws, schema, { model: '13', qty: 'lots' }).errors.some((e) => /must be a number/.test(e.message)));
  });

  test('emails and dates are shape-checked', () => {
    assert.ok(validateSubmission(ws, schema, { model: '13', email: 'nope' }).errors.some((e) => e.field === 'email'));
    assert.ok(validateSubmission(ws, schema, { model: '13', when: '31/01/2026' }).errors.some((e) => e.field === 'when'));
  });

  test('a field that is not on the form at all is refused', () => {
    assert.ok(validateSubmission(ws, schema, { model: '13', sneaky: 'x' }).errors.some((e) => e.field === 'sneaky'));
  });

  test('a required field inside a hidden branch does not block the requester', () => {
    const conditional = [
      { key: 'other', label: 'For someone else?', type: 'checkbox' },
      { key: 'who', label: 'Who', type: 'text', required: true, show_when: { field: 'other', op: 'equals', value: 'true' } },
    ];
    assert.equal(validateSubmission(ws, conditional, { other: false }).ok, true);
    assert.equal(validateSubmission(ws, conditional, { other: true }).ok, false);
  });

  test('a value posted for a hidden field is DISCARDED, not trusted', () => {
    // Otherwise hiding a question is cosmetic and anyone can post around it.
    const conditional = [
      { key: 'other', label: 'For someone else?', type: 'checkbox' },
      { key: 'who', label: 'Who', type: 'text', show_when: { field: 'other', op: 'equals', value: 'true' } },
    ];
    const r = validateSubmission(ws, conditional, { other: false, who: 'the CEO' });
    assert.equal(r.ok, true);
    assert.equal(r.values.who, undefined);
    assert.deepEqual(r.discarded, ['who']);
  });

  test('a person field must point at somebody in this workspace', () => {
    const other = newWorkspace();
    const outsider = newUser(other, 'requester');
    const insider = newUser(ws, 'requester');
    const s = [{ key: 'who', label: 'Who', type: 'user' }];
    assert.equal(validateSubmission(ws, s, { who: insider.id }).ok, true);
    assert.equal(validateSubmission(ws, s, { who: outsider.id }).ok, false);
    assert.equal(validateSubmission(ws, s, { who: 'usr_nope' }).ok, false);
  });

  test('the description resolves references to names', () => {
    const who = newUser(ws, 'requester');
    const s = [{ key: 'who', label: 'Requested for', type: 'user' }];
    const text = describeSubmission(ws, s, { who: who.id });
    assert.ok(!text.includes(who.id), text);
    assert.ok(text.startsWith('Requested for: '), text);
  });

  test('a checkbox reads as Yes or No, not true or false', () => {
    const s = [{ key: 'urgent', label: 'Urgent', type: 'checkbox' }];
    assert.equal(describeSubmission(ws, s, { urgent: true }), 'Urgent: Yes');
  });
});

// =========================================================== entitlement ===

describe('catalog entitlement', () => {
  test('an item with no rules is open to everyone', () => {
    const ws = newWorkspace(); const a = admin(ws); const r = newUser(ws);
    const i = item(ws);
    assert.equal(isEntitled(ws, r, i.id), true);
    assert.ok(listItems(ws, r).some((x) => x.id === i.id));
  });

  test('a group rule hides the item from everyone outside it', () => {
    const ws = newWorkspace(); const a = admin(ws);
    const inside = newUser(ws); const outside = newUser(ws);
    const g = newGroup(ws, 'Engineering');
    addToGroup(g, inside.id);

    const i = item(ws, { name: 'Dev laptop' });
    addEntitlement(ws, i.id, { rule_type: 'group', rule_value: g });

    assert.equal(isEntitled(ws, inside, i.id), true);
    assert.equal(isEntitled(ws, outside, i.id), false);
    assert.ok(listItems(ws, inside).some((x) => x.id === i.id));
    assert.ok(!listItems(ws, outside).some((x) => x.id === i.id));
  });

  test('a department rule matches the user team', () => {
    const ws = newWorkspace();
    const eng = newUser(ws, 'requester', { team: 'Engineering' });
    const sales = newUser(ws, 'requester', { team: 'Sales' });
    const i = item(ws);
    addEntitlement(ws, i.id, { rule_type: 'department', rule_value: 'Engineering' });
    assert.equal(isEntitled(ws, eng, i.id), true);
    assert.equal(isEntitled(ws, sales, i.id), false);
  });

  test('rules are OR-ed — any one match is enough', () => {
    const ws = newWorkspace();
    const sales = newUser(ws, 'requester', { team: 'Sales' });
    const i = item(ws);
    addEntitlement(ws, i.id, { rule_type: 'department', rule_value: 'Engineering' });
    addEntitlement(ws, i.id, { rule_type: 'department', rule_value: 'Sales' });
    assert.equal(isEntitled(ws, sales, i.id), true);
  });

  test('whoever maintains the catalog always sees everything', () => {
    const ws = newWorkspace(); const a = admin(ws);
    const i = item(ws);
    addEntitlement(ws, i.id, { rule_type: 'group', rule_value: newGroup(ws) });
    assert.equal(isEntitled(ws, a, i.id), true, 'otherwise they cannot test what they just configured');
  });

  test('the list and the single check agree for every user', () => {
    const ws = newWorkspace();
    const g = newGroup(ws);
    const member = newUser(ws); addToGroup(g, member.id);
    const other = newUser(ws);
    const open = item(ws, { name: 'Open' });
    const closed = item(ws, { name: 'Closed' });
    addEntitlement(ws, closed.id, { rule_type: 'group', rule_value: g });

    for (const u of [member, other]) {
      const listed = listItems(ws, u).map((x) => x.id);
      for (const id of [open.id, closed.id]) {
        assert.equal(listed.includes(id), isEntitled(ws, u, id), `${u.id} disagreement on ${id}`);
      }
    }
  });

  test('an unknown rule type is refused', () => {
    const ws = newWorkspace();
    assert.throws(() => addEntitlement(ws, item(ws).id, { rule_type: 'zodiac', rule_value: 'leo' }), /Unknown rule type/);
  });
});

// ============================================================ item model ===

describe('catalog items', () => {
  test('a new item starts as a draft and is not orderable', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = createItem(ws, { name: 'Half built' });
    assert.equal(i.status, 'draft');
    assert.ok(!listItems(ws, r).some((x) => x.id === i.id));
  });

  test('publishing makes it visible', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = createItem(ws, { name: 'Ready' });
    updateItem(ws, i.id, { status: 'published' });
    assert.ok(listItems(ws, r).some((x) => x.id === i.id));
  });

  test('a retired item disappears from the catalog', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = item(ws);
    updateItem(ws, i.id, { status: 'retired' });
    assert.ok(!listItems(ws, r).some((x) => x.id === i.id));
  });

  test('a manager can still see drafts when they ask for them', () => {
    const ws = newWorkspace(); const a = admin(ws);
    const i = createItem(ws, { name: 'Draft thing' });
    assert.ok(!listItems(ws, a).some((x) => x.id === i.id), 'not by default');
    assert.ok(listItems(ws, a, { includeUnpublished: true }).some((x) => x.id === i.id));
  });

  test('a bad form schema blocks the save and says why', () => {
    const ws = newWorkspace();
    try {
      createItem(ws, { name: 'Bad', form_schema: [{ key: 'x', label: 'X', type: 'select' }] });
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err.field_errors.some((e) => e.field === 'form_schema'), JSON.stringify(err.field_errors));
    }
  });

  test('negative money is refused', () => {
    const ws = newWorkspace();
    try { createItem(ws, { name: 'X', cost: -5 }); assert.fail('should have thrown'); }
    catch (err) { assert.ok(err.field_errors.some((e) => e.field === 'cost')); }
  });

  test('an item that has been ordered cannot be deleted', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = item(ws);
    ticketFor(ws, i.id, r.id);
    assert.throws(() => deleteItem(ws, i.id), /Retire it instead/);
  });

  test('an item nobody has ordered deletes cleanly', () => {
    const ws = newWorkspace();
    const i = item(ws);
    assert.deepEqual(deleteItem(ws, i.id), { ok: true });
  });
});

// ====================================================== approval chains ===

describe('catalog approval chains', () => {
  test('no stages configured falls back to the item own approver', () => {
    const ws = newWorkspace();
    const i = item(ws, { approval_required: 1, approver_type: 'role', approver_role: 'admin' });
    const chain = resolveApprovalChain(ws, getItem(ws, i.id), {});
    assert.equal(chain.length, 1);
    assert.equal(chain[0].approver_role, 'admin');
  });

  test('an item needing no approval produces an empty chain', () => {
    const ws = newWorkspace();
    const i = item(ws, { approval_required: 0 });
    assert.deepEqual(resolveApprovalChain(ws, getItem(ws, i.id), {}), []);
  });

  test('stages run in order', () => {
    const ws = newWorkspace();
    const i = item(ws);
    addApprovalStage(ws, i.id, { name: 'Manager', approver_type: 'role', approver_role: 'admin' });
    addApprovalStage(ws, i.id, { name: 'Security', approver_type: 'role', approver_role: 'admin' });
    const chain = resolveApprovalChain(ws, getItem(ws, i.id), {});
    assert.deepEqual(chain.map((c) => c.name), ['Manager', 'Security']);
    assert.deepEqual(chain.map((c) => c.step_order), [1, 2]);
  });

  test('a conditional stage only applies when its condition holds', () => {
    const ws = newWorkspace();
    const i = item(ws, { cost: 100 });
    addApprovalStage(ws, i.id, { name: 'Manager', approver_type: 'role', approver_role: 'admin' });
    addApprovalStage(ws, i.id, {
      name: 'Budget holder', approver_type: 'role', approver_role: 'admin',
      condition_field: '_cost', condition_op: 'gt', condition_value: '500',
    });

    const cheap = resolveApprovalChain(ws, getItem(ws, i.id), { cost: 100 });
    assert.deepEqual(cheap.map((c) => c.name), ['Manager']);

    const dear = resolveApprovalChain(ws, getItem(ws, i.id), { cost: 900 });
    assert.deepEqual(dear.map((c) => c.name), ['Manager', 'Budget holder']);
    assert.deepEqual(dear.map((c) => c.step_order), [1, 2], 'steps renumber so there is never a gap');
  });

  test('a stage can be conditional on a form answer', () => {
    const ws = newWorkspace();
    const i = item(ws);
    addApprovalStage(ws, i.id, {
      name: 'Security', approver_type: 'role', approver_role: 'admin',
      condition_field: 'access_level', condition_op: 'equals', condition_value: 'admin',
    });
    assert.equal(resolveApprovalChain(ws, getItem(ws, i.id), { values: { access_level: 'standard' } }).length, 0);
    assert.equal(resolveApprovalChain(ws, getItem(ws, i.id), { values: { access_level: 'admin' } }).length, 1);
  });

  test("the requester's manager is resolved from their workspace membership", () => {
    const ws = newWorkspace();
    const boss = newUser(ws, 'agent');
    const staff = newUser(ws, 'requester', { managerId: boss.id });
    const i = item(ws);
    addApprovalStage(ws, i.id, { name: 'Line manager', approver_type: 'requester_manager' });
    const chain = resolveApprovalChain(ws, getItem(ws, i.id), { requester: staff });
    assert.equal(chain[0].approver_id, boss.id);
  });

  test('no manager recorded falls back to an admin rather than skipping the gate', () => {
    const ws = newWorkspace();
    const orphan = newUser(ws, 'requester');
    const i = item(ws);
    addApprovalStage(ws, i.id, { name: 'Line manager', approver_type: 'requester_manager' });
    const chain = resolveApprovalChain(ws, getItem(ws, i.id), { requester: orphan });
    assert.equal(chain.length, 1, 'the stage must not vanish');
    assert.equal(chain[0].approver_role, 'admin');
  });

  test('a team stage goes to the team manager', () => {
    const ws = newWorkspace();
    const lead = newUser(ws, 'agent');
    const g = newGroup(ws, 'Security', lead.id);
    const i = item(ws);
    addApprovalStage(ws, i.id, { name: 'Security', approver_type: 'group_manager', approver_group_id: g });
    assert.equal(resolveApprovalChain(ws, getItem(ws, i.id), {})[0].approver_id, lead.id);
  });

  test('a disabled stage is skipped', () => {
    const ws = newWorkspace();
    const i = item(ws);
    const s = addApprovalStage(ws, i.id, { name: 'Manager', approver_type: 'role', approver_role: 'admin' });
    updateApprovalStage(ws, s.id, { enabled: 0 });
    assert.equal(resolveApprovalChain(ws, getItem(ws, i.id), {}).length, 0);
  });

  test('a team stage with no team chosen is refused at configuration time', () => {
    const ws = newWorkspace();
    assert.throws(() => addApprovalStage(ws, item(ws).id, { name: 'X', approver_type: 'group_manager' }), /Choose which team/);
  });
});

// ========================================================== fulfilment ===

describe('catalog fulfilment', () => {
  test('templates become real tasks on the ticket', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = item(ws);
    addFulfilmentTask(ws, i.id, { title: 'Order the hardware', assignee_type: 'unassigned' });
    addFulfilmentTask(ws, i.id, { title: 'Image the machine', assignee_type: 'unassigned' });

    const ticket = ticketFor(ws, i.id, r.id);
    const created = createFulfilmentTasks(ws, ticket, getItem(ws, i.id), { requester: r });
    assert.equal(created.length, 2);

    const tasks = db.prepare('SELECT * FROM ticket_tasks WHERE ticket_id = ? ORDER BY sort_order').all(ticket);
    assert.deepEqual(tasks.map((t) => t.title), ['Order the hardware', 'Image the machine']);
  });

  test('sequential tasks are chained so only the first is ready', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = item(ws);
    addFulfilmentTask(ws, i.id, { title: 'First', assignee_type: 'unassigned' });
    addFulfilmentTask(ws, i.id, { title: 'Second', assignee_type: 'unassigned' });

    const ticket = ticketFor(ws, i.id, r.id);
    createFulfilmentTasks(ws, ticket, getItem(ws, i.id), { requester: r });
    const tasks = db.prepare('SELECT * FROM ticket_tasks WHERE ticket_id = ? ORDER BY sort_order').all(ticket);
    assert.equal(tasks[0].depends_on_task_id, null);
    assert.equal(tasks[1].depends_on_task_id, tasks[0].id);
  });

  test('a parallel task does not wait', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = item(ws);
    addFulfilmentTask(ws, i.id, { title: 'First', assignee_type: 'unassigned' });
    addFulfilmentTask(ws, i.id, { title: 'Alongside', assignee_type: 'unassigned', sequential: false });

    const ticket = ticketFor(ws, i.id, r.id);
    createFulfilmentTasks(ws, ticket, getItem(ws, i.id), { requester: r });
    const tasks = db.prepare('SELECT * FROM ticket_tasks WHERE ticket_id = ? ORDER BY sort_order').all(ticket);
    assert.equal(tasks[1].depends_on_task_id, null);
  });

  test('a team task is assigned to the team manager', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const lead = newUser(ws, 'agent');
    const g = newGroup(ws, 'Desktop', lead.id);
    const i = item(ws);
    addFulfilmentTask(ws, i.id, { title: 'Build it', assignee_type: 'group', assignee_group_id: g });

    const ticket = ticketFor(ws, i.id, r.id);
    createFulfilmentTasks(ws, ticket, getItem(ws, i.id), { requester: r });
    assert.equal(db.prepare('SELECT assignee_id FROM ticket_tasks WHERE ticket_id = ?').get(ticket).assignee_id, lead.id);
  });

  test('a task with a due offset gets a date', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = item(ws);
    addFulfilmentTask(ws, i.id, { title: 'Soon', assignee_type: 'unassigned', due_offset_days: 3 });
    const ticket = ticketFor(ws, i.id, r.id);
    createFulfilmentTasks(ws, ticket, getItem(ws, i.id), { requester: r });
    const due = db.prepare('SELECT due_date FROM ticket_tasks WHERE ticket_id = ?').get(ticket).due_date;
    assert.ok(due > new Date().toISOString().slice(0, 10));
  });

  test('a conditional task only appears when it applies', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = item(ws);
    addFulfilmentTask(ws, i.id, { title: 'Always', assignee_type: 'unassigned' });
    addFulfilmentTask(ws, i.id, {
      title: 'Only for admins', assignee_type: 'unassigned',
      condition_field: 'access', condition_op: 'equals', condition_value: 'admin',
    });

    const t1 = ticketFor(ws, i.id, r.id);
    createFulfilmentTasks(ws, t1, getItem(ws, i.id), { values: { access: 'standard' }, requester: r });
    assert.deepEqual(db.prepare('SELECT title FROM ticket_tasks WHERE ticket_id = ?').all(t1).map((x) => x.title), ['Always']);

    const t2 = ticketFor(ws, i.id, r.id);
    createFulfilmentTasks(ws, t2, getItem(ws, i.id), { values: { access: 'admin' }, requester: r });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ticket_tasks WHERE ticket_id = ?').get(t2).c, 2);
  });

  test('an item with no templates creates nothing rather than failing', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = item(ws);
    assert.deepEqual(createFulfilmentTasks(ws, ticketFor(ws, i.id, r.id), getItem(ws, i.id), { requester: r }), []);
  });
});

// ============================================================ analytics ===

describe('catalog analytics', () => {
  test('an empty catalog reports honestly rather than dividing by zero', () => {
    const ws = newWorkspace(); const a = admin(ws);
    const o = catalogOverview(ws, {});
    assert.equal(o.requests.total, 0);
    assert.equal(o.delivery.on_time_rate, null);
    assert.match(o.delivery.note, /No requests on items with a delivery target/);
  });

  test('items nobody has ever ordered are surfaced', () => {
    const ws = newWorkspace();
    item(ws, { name: 'Ignored thing' });
    assert.ok(catalogOverview(ws, {}).never_requested.some((i) => i.name === 'Ignored thing'));
  });

  test('delivery performance counts only items that made a promise', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const promised = item(ws, { name: 'Laptop', delivery_days: 5 });
    const unpromised = item(ws, { name: 'Sticker' });

    const late = ticketFor(ws, promised.id, r.id);
    db.prepare("UPDATE tickets SET fulfilment_due_at = '2020-01-01 00:00:00', resolved_at = '2020-02-01 00:00:00' WHERE id = ?").run(late);
    const ontime = ticketFor(ws, promised.id, r.id);
    db.prepare("UPDATE tickets SET fulfilment_due_at = '2030-01-01 00:00:00', resolved_at = '2029-01-01 00:00:00' WHERE id = ?").run(ontime);
    ticketFor(ws, unpromised.id, r.id); // no target, must not be counted

    const d = catalogOverview(ws, {}).delivery;
    assert.equal(d.measured, 2);
    assert.equal(d.on_time, 1);
    assert.equal(d.late, 1);
    assert.equal(d.on_time_rate, 50);
  });

  test('requests still in flight are not counted as on time', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = item(ws, { delivery_days: 5 });
    const open = ticketFor(ws, i.id, r.id);
    db.prepare("UPDATE tickets SET fulfilment_due_at = '2020-01-01 00:00:00' WHERE id = ?").run(open);
    const d = catalogOverview(ws, {}).delivery;
    assert.equal(d.on_time_rate, null, 'nothing has finished, so there is no rate to report');
    assert.equal(d.outstanding, 1);
    assert.equal(d.overdue_now, 1);
  });

  test('pending approvals are grouped by who is sitting on them', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const boss = newUser(ws, 'agent');
    const i = item(ws);
    const t = ticketFor(ws, i.id, r.id);
    for (let n = 0; n < 3; n += 1) {
      db.prepare("INSERT INTO approvals (id, ticket_id, approver_id, step_order, status) VALUES (?,?,?,?, 'pending')")
        .run(uid('apr'), ticketFor(ws, i.id, r.id), boss.id, 1);
    }
    const b = approvalBottlenecks(ws, {});
    assert.equal(b.pending_total, 3);
    assert.equal(b.by_approver[0].pending, 3);
  });

  test('per-item performance reports requests and spend', () => {
    const ws = newWorkspace(); const r = newUser(ws);
    const i = item(ws, { name: 'Laptop', cost: 900 });
    const t = ticketFor(ws, i.id, r.id);
    db.prepare('UPDATE tickets SET catalog_cost = 900 WHERE id = ?').run(t);
    const row = itemPerformance(ws, {}).find((x) => x.name === 'Laptop');
    assert.equal(row.requests, 1);
    assert.equal(row.spend, 900);
  });
});
