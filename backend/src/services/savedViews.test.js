import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  FilterError, compileFilters, compileSort, validateFilters, filterMeta, FILTER_FIELDS,
} from './ticketFilters.js';
import {
  ViewError, listViews, getView, createView, updateView, deleteView,
  duplicateView, setPreference, runFilter, viewCounts, ensureBuiltInViews,
} from './savedViews.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'T ' + id, id);
  return id;
}
function newUser(ws, role = 'agent', team = null) {
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, name, email, password_hash, role, team) VALUES (?,?,?,?,?,?)')
    .run(id, role + '-' + id.slice(-4), `${id}@x.local`, 'x', role, team);
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, active) VALUES (?,?,?,?,1)')
    .run(uid('wm'), ws, id, role);
  return { id, role, team, permissions: [] };
}
let seq = 0;
const COLUMNS = ['type', 'title', 'status', 'priority', 'team', 'category', 'assignee_id', 'requester_id',
  'created_at', 'sla_due_at', 'sla_breached', 'is_spam', 'urgency', 'impact'];
function newTicket(ws, over = {}) {
  const id = uid('tkt');
  seq += 1;
  const t = { type: 'incident', title: 'Broken', status: 'open', priority: 'medium', created_at: new Date().toISOString(), ...over };
  for (const k of Object.keys(over)) if (!COLUMNS.includes(k)) throw new Error(`helper cannot set ${k}`);
  const cols = COLUMNS.filter((c) => t[c] !== undefined);
  db.prepare(`INSERT INTO tickets (id, workspace_id, number, ${cols.join(', ')}) VALUES (?,?,?,${cols.map(() => '?').join(',')})`)
    .run(id, ws, `INC-${7000 + seq}`, ...cols.map((c) => t[c]));
  return id;
}

describe('the filter compiler: nothing a client sends becomes SQL', () => {
  test('an unknown field is refused', () => {
    assert.throws(() => compileFilters({ logic: 'AND', rules: [{ field: 'password_hash', op: 'equals', value: 'x' }] }),
      /Unknown field/);
  });

  test('a field name cannot smuggle in SQL', () => {
    // The column comes from the allowlist, so this is refused by name rather
    // than escaped — there is no path where it reaches the query at all.
    assert.throws(() => compileFilters({
      logic: 'AND',
      rules: [{ field: "status = 'x' OR 1=1 --", op: 'equals', value: 'y' }],
    }), /Unknown field/);
  });

  test('a value containing SQL is bound, not interpolated', () => {
    const out = compileFilters({ logic: 'AND', rules: [{ field: 'title', op: 'contains', value: "'; DROP TABLE tickets; --" }] });
    assert.ok(!out.sql.includes('DROP'), 'the value must not appear in the SQL');
    assert.ok(out.sql.includes('?'), 'it must be a bound parameter');
    assert.equal(out.params[0], "%'; DROP TABLE tickets; --%");
  });

  test('an operator a field does not support is refused', () => {
    assert.throws(() => compileFilters({ logic: 'AND', rules: [{ field: 'sla_breached', op: 'contains', value: 'x' }] }),
      /cannot be used with/);
  });

  test('sorting only ever uses an allowlisted column', () => {
    assert.match(compileSort('created_at', 'asc'), /t\.created_at ASC/);
    // Anything else falls back rather than being interpolated.
    assert.match(compileSort('title; DROP TABLE tickets', 'asc'), /t\.created_at/);
    assert.ok(!compileSort('title; DROP TABLE tickets', 'asc').includes('DROP'));
  });

  test('priority sorts by severity, not alphabetically', () => {
    // Alphabetically "critical" sits between "medium" and "low", which is
    // not what anyone means by "most urgent first".
    const sql = compileSort('priority', 'desc');
    assert.match(sql, /CASE t\.priority/);
    assert.match(sql, /'critical' THEN 0/);
  });

  test('every field the builder offers can actually be compiled', () => {
    const meta = filterMeta();
    for (const f of meta.fields) {
      for (const op of f.operators) {
        const value = op === 'between' ? [1, 2] : (op.includes('in_') ? 3 : (op === 'in' || op === 'not_in' ? ['a'] : 'x'));
        assert.doesNotThrow(
          () => compileFilters({ logic: 'AND', rules: [{ field: f.key, op, value }] }, { userId: 'usr_1' }),
          `${f.key} offers ${op} but cannot compile it`
        );
      }
    }
  });

  test('"is not" still returns rows where the field is empty', () => {
    // Without this a ticket with no team vanishes from "team is not Network",
    // which reads as data loss rather than a filter.
    const out = compileFilters({ logic: 'AND', rules: [{ field: 'team', op: 'not_equals', value: 'Network' }] });
    assert.match(out.sql, /IS NULL OR/);
  });

  test('a nested OR group compiles inside an AND', () => {
    const out = compileFilters({
      logic: 'AND',
      rules: [
        { field: 'status', op: 'equals', value: 'open' },
        { logic: 'OR', rules: [
          { field: 'priority', op: 'equals', value: 'high' },
          { field: 'priority', op: 'equals', value: 'critical' },
        ] },
      ],
    });
    assert.match(out.sql, / AND /);
    assert.match(out.sql, / OR /);
    assert.deepEqual(out.params, ['open', 'high', 'critical']);
  });

  test('an absurdly deep tree is refused', () => {
    let tree = { logic: 'AND', rules: [{ field: 'status', op: 'equals', value: 'open' }] };
    for (let i = 0; i < 12; i++) tree = { logic: 'AND', rules: [tree] };
    assert.throws(() => compileFilters(tree), /nested too deeply/);
  });

  test('too many conditions are refused', () => {
    const rules = Array.from({ length: 60 }, () => ({ field: 'status', op: 'equals', value: 'open' }));
    assert.throws(() => compileFilters({ logic: 'AND', rules }), /at most/);
  });

  test('an empty filter compiles to nothing rather than to "everything"', () => {
    assert.equal(compileFilters(null), null);
    assert.equal(compileFilters({ logic: 'AND', rules: [] }), null);
  });

  test('a value is required where the operator needs one', () => {
    assert.throws(() => compileFilters({ logic: 'AND', rules: [{ field: 'title', op: 'contains', value: '' }] }), /needs a value/);
    // And not required where it does not.
    assert.doesNotThrow(() => compileFilters({ logic: 'AND', rules: [{ field: 'title', op: 'is_empty' }] }));
  });

  test('"is me" binds the caller, not whatever the client claims', () => {
    const out = compileFilters({ logic: 'AND', rules: [{ field: 'assignee_id', op: 'is_me', value: 'usr_someone_else' }] },
      { userId: 'usr_real' });
    assert.deepEqual(out.params, ['usr_real']);
  });
});

describe('running filters', () => {
  test('conditions actually select the right rows', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    newTicket(ws, { priority: 'critical', status: 'open' });
    newTicket(ws, { priority: 'low', status: 'open' });
    newTicket(ws, { priority: 'critical', status: 'closed' });

    const out = runFilter(ws, user, { filters: { logic: 'AND', rules: [
      { field: 'priority', op: 'equals', value: 'critical' },
      { field: 'status', op: 'not_equals', value: 'closed' },
    ] } });
    assert.equal(out.total, 1);
    assert.equal(out.tickets[0].priority, 'critical');
  });

  test('an OR group widens the result', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    newTicket(ws, { priority: 'high' });
    newTicket(ws, { priority: 'critical' });
    newTicket(ws, { priority: 'low' });
    const out = runFilter(ws, user, { filters: { logic: 'OR', rules: [
      { field: 'priority', op: 'equals', value: 'high' },
      { field: 'priority', op: 'equals', value: 'critical' },
    ] } });
    assert.equal(out.total, 2);
  });

  test('a requester only ever sees their own, whatever the filter says', () => {
    // A saved view is user input; it must not be able to widen visibility.
    const ws = newWorkspace();
    const requester = newUser(ws, 'requester');
    const other = newUser(ws, 'requester');
    newTicket(ws, { requester_id: requester.id });
    newTicket(ws, { requester_id: other.id });
    newTicket(ws, { requester_id: other.id });

    const out = runFilter(ws, requester, { filters: { logic: 'AND', rules: [] } });
    assert.equal(out.total, 1, 'an empty filter must not show everyone else');

    const sneaky = runFilter(ws, requester, {
      filters: { logic: 'OR', rules: [{ field: 'requester_id', op: 'equals', value: other.id }] },
    });
    assert.equal(sneaky.total, 0, 'nor can a filter naming someone else');
  });

  test('spam stays out unless it is asked for', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    newTicket(ws, {});
    newTicket(ws, { is_spam: 1 });
    assert.equal(runFilter(ws, user, { filters: null }).total, 1);
    assert.equal(runFilter(ws, user, { filters: null, include_spam: true }).total, 2);
  });

  test('one workspace never sees another', () => {
    const a = newWorkspace(); const b = newWorkspace();
    newTicket(a, {}); newTicket(b, {}); newTicket(b, {});
    assert.equal(runFilter(a, newUser(a), { filters: null }).total, 1);
  });

  test('the result says when it was truncated', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    for (let i = 0; i < 5; i++) newTicket(ws, {});
    const out = runFilter(ws, user, { filters: null, limit: 2 });
    assert.equal(out.returned, 2);
    assert.equal(out.total, 5);
    assert.equal(out.truncated, true);
  });
});

describe('saved views', () => {
  test('a workspace gets useful views without configuring anything', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const views = listViews(ws, user);
    assert.ok(views.length >= 5, `${views.length} built-in views`);
    assert.ok(views.every((v) => v.built_in));
    assert.ok(views.some((v) => /unassigned/i.test(v.name)));
  });

  test('every built-in view actually runs', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    newTicket(ws, { assignee_id: user.id, priority: 'critical' });
    for (const v of listViews(ws, user)) {
      assert.doesNotThrow(() => runFilter(ws, user, { filters: v.filters, sort_by: v.sort_by, sort_dir: v.sort_dir }),
        `built-in view "${v.name}" does not run`);
    }
  });

  test('"my open tickets" means the caller, not its author', () => {
    const ws = newWorkspace();
    const priya = newUser(ws);
    const sam = newUser(ws);
    newTicket(ws, { assignee_id: priya.id, status: 'open' });
    newTicket(ws, { assignee_id: sam.id, status: 'open' });
    const view = listViews(ws, priya).find((v) => /my open/i.test(v.name));
    assert.equal(runFilter(ws, priya, { filters: view.filters }).total, 1);
    assert.equal(runFilter(ws, sam, { filters: view.filters }).total, 1);
  });

  test('a private view is invisible to everybody else', () => {
    const ws = newWorkspace();
    const owner = newUser(ws);
    const other = newUser(ws);
    const view = createView(ws, owner, { name: 'Mine', scope: 'private', filters: { logic: 'AND', rules: [] } });
    assert.ok(listViews(ws, owner).some((v) => v.id === view.id));
    assert.ok(!listViews(ws, other).some((v) => v.id === view.id));
    // 404 rather than 403: that a colleague has a private view is itself not shared.
    assert.throws(() => getView(ws, view.id, other), (e) => e.status === 404);
  });

  test('a team view reaches that team and nobody else', () => {
    const ws = newWorkspace();
    const network = newUser(ws, 'agent', 'Network');
    const desktop = newUser(ws, 'agent', 'Desktop');
    const view = createView(ws, network, { name: 'Network queue', scope: 'team', team: 'Network', filters: { logic: 'AND', rules: [] } });
    assert.ok(listViews(ws, network).some((v) => v.id === view.id));
    assert.ok(!listViews(ws, desktop).some((v) => v.id === view.id));
  });

  test('a team view needs a team', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    assert.throws(() => createView(ws, user, { name: 'x', scope: 'team', filters: { logic: 'AND', rules: [] } }), (e) => {
      assert.equal(e.field_errors[0].field, 'team');
      return true;
    });
  });

  test('a workspace view reaches everyone', () => {
    const ws = newWorkspace();
    const author = newUser(ws);
    const other = newUser(ws);
    const view = createView(ws, author, { name: 'Everyone', scope: 'workspace', filters: { logic: 'AND', rules: [] } });
    assert.ok(listViews(ws, other).some((v) => v.id === view.id));
  });

  test('a view with an invalid filter is refused at save time', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    assert.throws(() => createView(ws, user, {
      name: 'Bad', filters: { logic: 'AND', rules: [{ field: 'nonsense', op: 'equals', value: 'x' }] },
    }), /Unknown field/);
  });

  test('only the owner or an admin can change or remove one', () => {
    const ws = newWorkspace();
    const owner = newUser(ws);
    const other = newUser(ws);
    const boss = newUser(ws, 'admin');
    const view = createView(ws, owner, { name: 'Shared', scope: 'workspace', filters: { logic: 'AND', rules: [] } });
    assert.throws(() => updateView(ws, view.id, other, { name: 'Hijacked' }), (e) => e.status === 403);
    assert.throws(() => deleteView(ws, view.id, other), (e) => e.status === 403);
    assert.doesNotThrow(() => updateView(ws, view.id, boss, { name: 'Renamed by admin' }));
    assert.equal(getView(ws, view.id, owner).name, 'Renamed by admin');
  });

  test('a built-in view cannot be edited or removed, only copied', () => {
    const ws = newWorkspace(); const user = newUser(ws, 'admin');
    const builtIn = listViews(ws, user)[0];
    assert.throws(() => updateView(ws, builtIn.id, user, { name: 'x' }), /cannot be changed/);
    assert.throws(() => deleteView(ws, builtIn.id, user), /cannot be removed/);

    const copy = duplicateView(ws, builtIn.id, user);
    assert.ok(copy.id !== builtIn.id);
    assert.equal(copy.scope, 'private', 'a copy starts private rather than inheriting a shared scope');
    assert.deepEqual(copy.filters, builtIn.filters);
    assert.doesNotThrow(() => updateView(ws, copy.id, user, { name: 'My version' }));
  });

  test('a default is per person, not per view', () => {
    // Pinning a shared view must not pin it for the rest of the team.
    const ws = newWorkspace();
    const a = newUser(ws);
    const b = newUser(ws);
    const view = createView(ws, a, { name: 'Shared', scope: 'workspace', filters: { logic: 'AND', rules: [] } });
    setPreference(ws, view.id, a, { is_default: true });
    assert.equal(listViews(ws, a).find((v) => v.id === view.id).is_default, 1);
    assert.ok(!listViews(ws, b).find((v) => v.id === view.id).is_default);
  });

  test('setting a new default clears the old one', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const one = createView(ws, user, { name: 'One', filters: { logic: 'AND', rules: [] } });
    const two = createView(ws, user, { name: 'Two', filters: { logic: 'AND', rules: [] } });
    setPreference(ws, one.id, user, { is_default: true });
    setPreference(ws, two.id, user, { is_default: true });
    const views = listViews(ws, user);
    assert.equal(views.filter((v) => v.is_default).length, 1);
    assert.equal(views.find((v) => v.is_default).id, two.id);
  });

  test('counts are reported per view', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    newTicket(ws, { assignee_id: user.id, status: 'open' });
    newTicket(ws, { status: 'open' });
    const counts = viewCounts(ws, user);
    const mine = listViews(ws, user).find((v) => /my open/i.test(v.name));
    const unassigned = listViews(ws, user).find((v) => /unassigned/i.test(v.name));
    assert.equal(counts[mine.id], 1);
    assert.equal(counts[unassigned.id], 1);
  });

  test('a view whose filter no longer compiles has no count rather than breaking the list', () => {
    const ws = newWorkspace(); const user = newUser(ws);
    const view = createView(ws, user, { name: 'Fine', filters: { logic: 'AND', rules: [] } });
    // Corrupt it behind the service's back, the way a schema change could.
    db.prepare('UPDATE saved_views SET filters = ? WHERE id = ?')
      .run(JSON.stringify({ logic: 'AND', rules: [{ field: 'gone_away', op: 'equals', value: 'x' }] }), view.id);
    const counts = viewCounts(ws, user);
    assert.equal(counts[view.id], null);
    assert.ok(Object.keys(counts).length > 1, 'the other views still counted');
  });

  test('another workspace view cannot be reached', () => {
    const a = newWorkspace(); const b = newWorkspace();
    const view = createView(a, newUser(a), { name: 'A only', scope: 'workspace', filters: { logic: 'AND', rules: [] } });
    assert.throws(() => getView(b, view.id, newUser(b)), (e) => e.status === 404);
  });
});
