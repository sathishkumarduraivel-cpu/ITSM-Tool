import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../src/db.js';
import { nextTicketNumber } from '../src/services/ticketNumbering.js';

// Regression cover for a real multi-tenancy defect: tickets.number,
// assets.tag and purchase_orders.po_number were declared with a column-level
// UNIQUE, which is global rather than per workspace. Because ticket numbering
// restarts per workspace, two tenants both produced INC-1000 and the second
// tenant's very first ticket failed to insert -- multi-workspace was
// effectively broken for tickets.
//
// SQLite cannot drop the implicit index a column-level UNIQUE creates, so
// db.js rebuilds these three tables on boot (retenantUniqueColumn). These
// tests assert the outcome, not the mechanism.

function newWorkspace(name) {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, name, id);
  return id;
}

const insertTicket = (ws, number) => db.prepare(
  "INSERT INTO tickets (id, workspace_id, number, type, title, status) VALUES (?,?,?,'incident','t','open')"
).run(uid('tkt'), ws, number);

const insertAsset = (ws, tag) => db.prepare(
  'INSERT INTO assets (id, workspace_id, tag, name) VALUES (?,?,?,?)'
).run(uid('ast'), ws, tag, 'laptop');

const insertPo = (ws, po) => db.prepare(
  'INSERT INTO purchase_orders (id, workspace_id, po_number, vendor, item) VALUES (?,?,?,?,?)'
).run(uid('po'), ws, po, 'vendor', 'item');

describe('multi-tenancy: per-workspace uniqueness', () => {
  test('two workspaces genuinely generate the same first ticket number', () => {
    const a = newWorkspace('alpha');
    const b = newWorkspace('beta');
    // If numbering ever became globally sequential this test is meaningless,
    // so assert the premise rather than assuming it.
    assert.equal(nextTicketNumber(a, 'incident'), nextTicketNumber(b, 'incident'));
  });

  test('the same ticket number is allowed in two workspaces', () => {
    const a = newWorkspace('alpha');
    const b = newWorkspace('beta');
    const number = nextTicketNumber(a, 'incident');
    insertTicket(a, number);
    assert.doesNotThrow(() => insertTicket(b, number), 'a second tenant must be able to use the same number');
  });

  test('but a duplicate ticket number within one workspace is still rejected', () => {
    const a = newWorkspace('alpha');
    insertTicket(a, 'INC-9000');
    assert.throws(() => insertTicket(a, 'INC-9000'), /UNIQUE/);
  });

  test('the same asset tag is allowed in two workspaces, not within one', () => {
    const a = newWorkspace('alpha');
    const b = newWorkspace('beta');
    insertAsset(a, 'LAP-001');
    assert.doesNotThrow(() => insertAsset(b, 'LAP-001'));
    assert.throws(() => insertAsset(a, 'LAP-001'), /UNIQUE/);
  });

  test('the same PO number is allowed in two workspaces, not within one', () => {
    const a = newWorkspace('alpha');
    const b = newWorkspace('beta');
    insertPo(a, 'PO-001');
    assert.doesNotThrow(() => insertPo(b, 'PO-001'));
    assert.throws(() => insertPo(a, 'PO-001'), /UNIQUE/);
  });
});

describe('multi-tenancy: the rebuild preserved the schema', () => {
  const singleColumnUniqueOn = (table, column) => db
    .prepare('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1').all(table)
    .some((ix) => {
      const parts = db.prepare('SELECT name FROM pragma_index_info(?)').all(ix.name);
      return parts.length === 1 && parts[0].name === column;
    });

  const compositeUniqueOn = (table, column) => db
    .prepare('SELECT name FROM pragma_index_list(?) WHERE "unique" = 1').all(table)
    .some((ix) => {
      const parts = db.prepare('SELECT name FROM pragma_index_info(?)').all(ix.name).map((p) => p.name);
      return parts.length === 2 && parts.includes('workspace_id') && parts.includes(column);
    });

  for (const [table, column] of [['tickets', 'number'], ['assets', 'tag'], ['purchase_orders', 'po_number']]) {
    test(`${table}.${column} is scoped to the workspace, not global`, () => {
      assert.equal(singleColumnUniqueOn(table, column), false, 'the global unique index must be gone');
      assert.equal(compositeUniqueOn(table, column), true, 'and a composite one must exist');
    });
  }

  test('the primary key survived the rebuild', () => {
    for (const table of ['tickets', 'assets', 'purchase_orders']) {
      const pk = db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0').all(table);
      assert.deepEqual(pk.map((p) => p.name), ['id'], `${table} lost its primary key`);
    }
  });

  test('column defaults survived, including function defaults', () => {
    // DEFAULT (datetime('now')) is reported by pragma without its parentheses
    // and is invalid in a CREATE TABLE that way -- the rebuild has to restore
    // them, so a fresh insert must still get a timestamp.
    const ws = newWorkspace('alpha');
    insertTicket(ws, 'INC-9100');
    const row = db.prepare("SELECT created_at, status, source FROM tickets WHERE number = 'INC-9100'").get();
    assert.ok(row.created_at, 'created_at default did not survive');
    assert.equal(row.source, 'portal', 'a literal default did not survive');
  });

  test('foreign keys still resolve after the rebuild', () => {
    const ws = newWorkspace('alpha');
    insertTicket(ws, 'INC-9200');
    const ticket = db.prepare("SELECT id FROM tickets WHERE number = 'INC-9200'").get();
    db.prepare('INSERT INTO ticket_comments (id, ticket_id, body) VALUES (?,?,?)').run(uid('cmt'), ticket.id, 'hello');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });

  test('a foreign key to a missing ticket is still refused', () => {
    assert.throws(
      () => db.prepare('INSERT INTO ticket_comments (id, ticket_id, body) VALUES (?,?,?)').run(uid('cmt'), 'tkt_nope', 'x'),
      /FOREIGN KEY/
    );
  });
});
