import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { createTask, updateTask, deleteTask, computeTaskAggregates } from './tasks.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

// A minimal, valid ticket row -- just enough to satisfy ticket_tasks' FK
// constraint (PRAGMA foreign_keys = ON) and give createTask() an
// {id, workspace_id} to work with. Tasks in these tests are never assigned
// (assignee_id left unset), so notifyAssignee() short-circuits and no
// email/notification side effects fire.
function newTicket(workspaceId) {
  const id = uid('tkt');
  db.prepare('INSERT INTO tickets (id, number, type, title, workspace_id) VALUES (?,?,?,?,?)')
    .run(id, id, 'incident', 'Test ticket', workspaceId);
  return { id, workspace_id: workspaceId };
}

describe('tasks: dependency cycle detection', () => {
  test('a task cannot be made to depend on itself', () => {
    const ws = newWorkspace();
    const ticket = newTicket(ws);
    const a = createTask(ticket, { title: 'A' });
    assert.throws(() => updateTask(ticket, a.id, { depends_on_task_id: a.id }), /cannot depend on itself/);
  });

  test('a direct two-task cycle (A depends on B, then B set to depend on A) is refused', () => {
    const ws = newWorkspace();
    const ticket = newTicket(ws);
    const a = createTask(ticket, { title: 'A' });
    const b = createTask(ticket, { title: 'B', depends_on_task_id: a.id });
    assert.throws(() => updateTask(ticket, a.id, { depends_on_task_id: b.id }), /would create a cycle/);
  });

  test('a longer chain (A depends on B, B depends on C) refuses closing the loop at the far end', () => {
    const ws = newWorkspace();
    const ticket = newTicket(ws);
    const a = createTask(ticket, { title: 'A' });
    const b = createTask(ticket, { title: 'B', depends_on_task_id: a.id }); // B -> A
    const c = createTask(ticket, { title: 'C', depends_on_task_id: b.id }); // C -> B -> A
    // Making A depend on C would close the loop: A -> C -> B -> A.
    assert.throws(() => updateTask(ticket, a.id, { depends_on_task_id: c.id }), /would create a cycle/);
  });

  test('a real, non-circular chain is accepted', () => {
    const ws = newWorkspace();
    const ticket = newTicket(ws);
    const a = createTask(ticket, { title: 'A' });
    const b = createTask(ticket, { title: 'B' });
    const c = createTask(ticket, { title: 'C' });
    updateTask(ticket, b.id, { depends_on_task_id: a.id });
    const updated = updateTask(ticket, c.id, { depends_on_task_id: b.id });
    assert.equal(updated.depends_on_task_id, b.id);
  });

  test('a dependency must belong to the same ticket', () => {
    const ws = newWorkspace();
    const ticketA = newTicket(ws);
    const ticketB = newTicket(ws);
    const foreign = createTask(ticketB, { title: 'Foreign task' });
    assert.throws(() => createTask(ticketA, { title: 'Depends on another ticket\'s task', depends_on_task_id: foreign.id }), /does not belong to this ticket/);
  });
});

describe('tasks: status transitions blocked by an incomplete dependency', () => {
  test('cannot move a task to in_progress or done while its dependency is not done', () => {
    const ws = newWorkspace();
    const ticket = newTicket(ws);
    const dep = createTask(ticket, { title: 'Must finish first' });
    const blocked = createTask(ticket, { title: 'Blocked', depends_on_task_id: dep.id });

    assert.throws(() => updateTask(ticket, blocked.id, { status: 'in_progress' }), /blocked by an incomplete dependency/);

    updateTask(ticket, dep.id, { status: 'done' });
    const nowUnblocked = updateTask(ticket, blocked.id, { status: 'done' });
    assert.equal(nowUnblocked.status, 'done');
    assert.ok(nowUnblocked.completed_at, 'completed_at is stamped on completion');
  });
});

describe('tasks: deleteTask clears dangling dependency references', () => {
  test('deleting a task that others depend on clears their depends_on_task_id instead of leaving a dangling reference', () => {
    const ws = newWorkspace();
    const ticket = newTicket(ws);
    const dep = createTask(ticket, { title: 'Will be deleted' });
    const dependent = createTask(ticket, { title: 'Depends on it', depends_on_task_id: dep.id });

    deleteTask(ticket.id, dep.id);

    const reloaded = db.prepare('SELECT * FROM ticket_tasks WHERE id = ?').get(dependent.id);
    assert.equal(reloaded.depends_on_task_id, null);
    // And the now-unblocked task can move straight to done without error.
    const done = updateTask(ticket, dependent.id, { status: 'done' });
    assert.equal(done.status, 'done');
  });
});

describe('tasks: computeTaskAggregates', () => {
  test('is vacuously "all completed" for a ticket with no tasks at all', () => {
    const ws = newWorkspace();
    const ticket = newTicket(ws);
    assert.deepEqual(computeTaskAggregates(ticket.id), { tasks_total: 0, tasks_open: 0, tasks_completed: 0, all_tasks_completed: 'true' });
  });

  test('reflects a real mix of open and done tasks', () => {
    const ws = newWorkspace();
    const ticket = newTicket(ws);
    const a = createTask(ticket, { title: 'A' });
    createTask(ticket, { title: 'B' });
    updateTask(ticket, a.id, { status: 'done' });

    const agg = computeTaskAggregates(ticket.id);
    assert.equal(agg.tasks_total, 2);
    assert.equal(agg.tasks_completed, 1);
    assert.equal(agg.tasks_open, 1);
    assert.equal(agg.all_tasks_completed, 'false');
  });
});
