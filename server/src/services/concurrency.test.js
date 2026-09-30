import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { ConflictError, checkVersion, versionBump, currentVersion } from './concurrency.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'T ' + id, id);
  return id;
}
function newUser(ws, name = 'Agent') {
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(id, name, `${id}@x.local`, 'x', 'agent');
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, active) VALUES (?,?,?,?,1)')
    .run(uid('wm'), ws, id, 'agent');
  return { id, name, role: 'agent' };
}
let seq = 0;
function newTicket(ws, over = {}) {
  const id = uid('tkt');
  seq += 1;
  const t = { type: 'incident', title: 'Broken', status: 'open', priority: 'medium', ...over };
  db.prepare('INSERT INTO tickets (id, workspace_id, number, type, title, status, priority) VALUES (?,?,?,?,?,?,?)')
    .run(id, ws, `INC-${6000 + seq}`, t.type, t.title, t.status, t.priority);
  return id;
}
// Writes the way the route does: the bump rides in the same statement.
function writeTicket(id, fields, params, userId) {
  const bump = versionBump(userId);
  db.prepare(`UPDATE tickets SET ${[...fields, ...bump.sql].join(', ')} WHERE id = ?`).run(...params, ...bump.params, id);
}

describe('optimistic locking', () => {
  test('a record starts at version 1', () => {
    const ws = newWorkspace();
    assert.equal(currentVersion('tickets', newTicket(ws)), 1);
  });

  test('writing bumps the version', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newTicket(ws);
    writeTicket(id, ['title = ?'], ['Changed'], user.id);
    assert.equal(currentVersion('tickets', id), 2);
    writeTicket(id, ['title = ?'], ['Changed again'], user.id);
    assert.equal(currentVersion('tickets', id), 3);
  });

  test('writing against the current version is allowed', () => {
    const ws = newWorkspace();
    const id = newTicket(ws);
    assert.doesNotThrow(() => checkVersion('tickets', id, 1));
  });

  test('writing against a stale version is refused', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newTicket(ws);
    writeTicket(id, ['title = ?'], ['Someone else got here first'], user.id);
    assert.throws(() => checkVersion('tickets', id, 1), (e) => {
      assert.ok(e instanceof ConflictError);
      assert.equal(e.status, 409);
      return true;
    });
  });

  test('the conflict names who changed it and to what', () => {
    // A refusal is only useful if the person can act on it.
    const ws = newWorkspace();
    const first = newUser(ws, 'Priya');
    const id = newTicket(ws, { title: 'Original', priority: 'low' });
    writeTicket(id, ['title = ?', 'priority = ?'], ['Priya edited this', 'critical'], first.id);

    assert.throws(() => checkVersion('tickets', id, 1, { fields: ['title', 'priority'] }), (e) => {
      assert.equal(e.conflict.current_version, 2);
      assert.equal(e.conflict.updated_by_name, 'Priya');
      assert.equal(e.conflict.current_values.title, 'Priya edited this');
      assert.equal(e.conflict.current_values.priority, 'critical');
      return true;
    });
  });

  test('the conflict only reports the fields the write was touching', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newTicket(ws, { title: 'A', priority: 'low' });
    writeTicket(id, ['title = ?'], ['B'], user.id);
    assert.throws(() => checkVersion('tickets', id, 1, { fields: ['title'] }), (e) => {
      assert.deepEqual(Object.keys(e.conflict.current_values), ['title']);
      return true;
    });
  });

  test('recent history travels with the conflict', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newTicket(ws);
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)')
      .run(uid('h'), id, 'updated', 'priority');
    writeTicket(id, ['title = ?'], ['x'], user.id);
    assert.throws(() => checkVersion('tickets', id, 1), (e) => {
      assert.ok(e.conflict.recent_changes.length >= 1);
      return true;
    });
  });

  test('a caller that sends no version is let through', () => {
    // Automations, the public API and monitoring integrations have no user
    // staring at a stale form; requiring a version would break them all for
    // no benefit.
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newTicket(ws);
    writeTicket(id, ['title = ?'], ['moved on'], user.id);
    for (const v of [undefined, null, '']) {
      assert.doesNotThrow(() => checkVersion('tickets', id, v), `version ${JSON.stringify(v)} should be allowed`);
    }
  });

  test('a nonsense version is treated as no version rather than a conflict', () => {
    const ws = newWorkspace();
    const id = newTicket(ws);
    assert.doesNotThrow(() => checkVersion('tickets', id, 'banana'));
  });

  test('a version sent as a string still compares correctly', () => {
    // Query strings and form fields arrive as text.
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newTicket(ws);
    assert.doesNotThrow(() => checkVersion('tickets', id, '1'));
    writeTicket(id, ['title = ?'], ['x'], user.id);
    assert.throws(() => checkVersion('tickets', id, '1'), ConflictError);
    assert.doesNotThrow(() => checkVersion('tickets', id, '2'));
  });

  test('a missing record is not a conflict', () => {
    // It is a 404 for the caller to report, not a stale-write problem.
    assert.doesNotThrow(() => checkVersion('tickets', 'tkt_nope', 5));
  });

  test('a table with no version column cannot be locked by accident', () => {
    assert.throws(() => checkVersion('users', 'usr_1', 1), /no version column/);
    assert.throws(() => currentVersion('kb_articles', 'x'), /no version column/);
  });

  test('major incidents are lockable too', () => {
    // The war room is the highest-contention record in the product.
    const ws = newWorkspace();
    const ticket = newTicket(ws);
    const id = uid('mi');
    db.prepare('INSERT INTO major_incidents (id, workspace_id, ticket_id, number, severity, summary) VALUES (?,?,?,?,?,?)')
      .run(id, ws, ticket, 'MI-1', 'sev1', 'Everything is down');
    assert.equal(currentVersion('major_incidents', id), 1);
    assert.doesNotThrow(() => checkVersion('major_incidents', id, 1));
    db.prepare('UPDATE major_incidents SET row_version = row_version + 1 WHERE id = ?').run(id);
    assert.throws(() => checkVersion('major_incidents', id, 1), ConflictError);
  });

  test('the second of two concurrent edits is the one refused', () => {
    // The scenario the whole feature exists for: both loaded version 1, both
    // edit, and the first to save wins rather than the last.
    const ws = newWorkspace();
    const priya = newUser(ws, 'Priya');
    const sam = newUser(ws, 'Sam');
    const id = newTicket(ws, { title: 'Printer jammed' });

    const priyaLoaded = currentVersion('tickets', id);
    const samLoaded = currentVersion('tickets', id);
    assert.equal(priyaLoaded, samLoaded, 'both are looking at the same version');

    // Priya saves first.
    assert.doesNotThrow(() => checkVersion('tickets', id, priyaLoaded));
    writeTicket(id, ['title = ?'], ['Printer jammed — toner replaced'], priya.id);

    // Sam saves second, against what he loaded.
    assert.throws(() => checkVersion('tickets', id, samLoaded, { fields: ['title'] }), (e) => {
      assert.equal(e.conflict.updated_by_name, 'Priya');
      assert.match(e.conflict.current_values.title, /toner replaced/);
      return true;
    });
    // And Priya's work is still there.
    assert.match(db.prepare('SELECT title FROM tickets WHERE id = ?').get(id).title, /toner replaced/);
  });

  test('after seeing the conflict, saving against the new version succeeds', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const id = newTicket(ws);
    writeTicket(id, ['title = ?'], ['theirs'], user.id);
    const now = currentVersion('tickets', id);
    assert.doesNotThrow(() => checkVersion('tickets', id, now));
    writeTicket(id, ['title = ?'], ['mine, re-applied'], user.id);
    assert.equal(db.prepare('SELECT title FROM tickets WHERE id = ?').get(id).title, 'mine, re-applied');
  });
});
