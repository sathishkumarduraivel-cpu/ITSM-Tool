import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { resolveOnCall, resolveShiftRange, isUserOnCall, zonedTimeToInstant } from './oncallEngine.js';

// Same per-test workspace isolation as sla.test.js -- one throwaway database
// per file, but tests within the file share it, so anything queried by
// workspace needs its own workspace row.
function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

let userSeq = 0;
function newUser(name) {
  const id = uid('usr');
  userSeq += 1;
  db.prepare('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)').run(
    id, `${id}-${userSeq}@test.local`, name, 'x'
  );
  return id;
}

function newSchedule(workspaceId, { timezone = 'UTC', enabled = 1 } = {}) {
  const id = uid('ocs');
  db.prepare('INSERT INTO oncall_schedules (id, workspace_id, name, timezone, enabled) VALUES (?,?,?,?,?)').run(
    id, workspaceId, 'Schedule ' + id, timezone, enabled
  );
  return id;
}

function newLayer(scheduleId, opts = {}) {
  const {
    layer_order = 1, name = 'Primary', rotation_type = 'weekly',
    rotation_length_days = 7, handoff_time = '09:00', start_date = '2026-01-05',
    restriction = null, enabled = 1,
  } = opts;
  const id = uid('ocl');
  db.prepare(
    `INSERT INTO oncall_layers (id, schedule_id, layer_order, name, rotation_type, rotation_length_days, handoff_time, start_date, restriction, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, scheduleId, layer_order, name, rotation_type, rotation_length_days, handoff_time, start_date, restriction, enabled);
  return id;
}

function addMembers(layerId, userIds) {
  userIds.forEach((userId, i) => {
    db.prepare('INSERT INTO oncall_layer_members (id, layer_id, user_id, member_order) VALUES (?,?,?,?)').run(
      uid('oclm'), layerId, userId, i + 1
    );
  });
}

describe('oncallEngine: zonedTimeToInstant', () => {
  test('resolves a wall-clock time in a positive-offset zone', () => {
    // 09:00 in Kolkata (UTC+5:30, no DST) is 03:30 UTC.
    const instant = zonedTimeToInstant({ year: 2026, month: 3, day: 10, hour: 9, minute: 0 }, 'Asia/Kolkata');
    assert.equal(instant.toISOString(), '2026-03-10T03:30:00.000Z');
  });

  test('resolves a wall-clock time either side of a DST transition in the same zone', () => {
    // US DST 2026 begins 8 March. 09:00 New York is 14:00 UTC in winter
    // (EST, -5) and 13:00 UTC in summer (EDT, -4) -- the same wall clock
    // maps to a different instant, which is the whole point of storing a
    // zone rather than a fixed offset.
    const winter = zonedTimeToInstant({ year: 2026, month: 2, day: 1, hour: 9, minute: 0 }, 'America/New_York');
    const summer = zonedTimeToInstant({ year: 2026, month: 7, day: 1, hour: 9, minute: 0 }, 'America/New_York');
    assert.equal(winter.toISOString(), '2026-02-01T14:00:00.000Z');
    assert.equal(summer.toISOString(), '2026-07-01T13:00:00.000Z');
  });
});

describe('oncallEngine: rotation maths', () => {
  test('a weekly rotation advances one member per week, in member_order', () => {
    const ws = newWorkspace();
    const [a, b, c] = [newUser('Ana'), newUser('Bo'), newUser('Cy')];
    const sched = newSchedule(ws);
    const layer = newLayer(sched, { start_date: '2026-01-05', handoff_time: '09:00' });
    addMembers(layer, [a, b, c]);

    // Epoch is Mon 5 Jan 09:00 UTC.
    const at = (iso) => resolveOnCall(sched, new Date(iso)).user?.id;
    assert.equal(at('2026-01-05T09:00:00Z'), a, 'first member holds from the epoch instant');
    assert.equal(at('2026-01-11T23:59:00Z'), a, 'still the first member six days later');
    assert.equal(at('2026-01-12T09:00:00Z'), b, 'second member takes over after seven days');
    assert.equal(at('2026-01-19T09:00:00Z'), c);
    assert.equal(at('2026-01-26T09:00:00Z'), a, 'rotation wraps back to the first member');
  });

  test('nobody is on call before the rotation start date', () => {
    const ws = newWorkspace();
    const a = newUser('Ana');
    const sched = newSchedule(ws);
    const layer = newLayer(sched, { start_date: '2026-06-01' });
    addMembers(layer, [a]);

    const res = resolveOnCall(sched, new Date('2026-05-30T12:00:00Z'));
    assert.equal(res.user, null);
    assert.equal(res.source, 'none');
  });

  test('the handoff hour, not midnight, is the boundary', () => {
    const ws = newWorkspace();
    const [a, b] = [newUser('Ana'), newUser('Bo')];
    const sched = newSchedule(ws);
    const layer = newLayer(sched, { rotation_type: 'daily', rotation_length_days: 1, handoff_time: '09:00', start_date: '2026-01-05' });
    addMembers(layer, [a, b]);

    assert.equal(resolveOnCall(sched, new Date('2026-01-06T08:59:00Z')).user?.id, a, 'before 09:00 the previous holder is still on');
    assert.equal(resolveOnCall(sched, new Date('2026-01-06T09:01:00Z')).user?.id, b, 'after 09:00 the next member holds');
  });

  test('a handoff stays at the same local wall-clock time across a DST transition', () => {
    // US DST 2026 begins Sun 8 March. With a daily 09:00 America/New_York
    // handoff, the boundary must remain 09:00 *local* on both sides -- which
    // is 14:00 UTC before the switch and 13:00 UTC after. A naive
    // elapsed-milliseconds rotation drifts by an hour here and hands off at
    // the wrong time for the rest of the year.
    const ws = newWorkspace();
    const [a, b] = [newUser('Ana'), newUser('Bo')];
    const sched = newSchedule(ws, { timezone: 'America/New_York' });
    const layer = newLayer(sched, { rotation_type: 'daily', rotation_length_days: 1, handoff_time: '09:00', start_date: '2026-03-05' });
    addMembers(layer, [a, b]);

    // 5 Mar (EST): holder A. 6 Mar: B. 7 Mar: A. 8 Mar (DST starts): B. 9 Mar: A.
    const holderOn = (iso) => resolveOnCall(sched, new Date(iso)).user?.id;
    // 13:45 UTC on 9 March is 09:45 EDT -- past the local handoff.
    assert.equal(holderOn('2026-03-09T13:45:00Z'), a);
    // 12:45 UTC on 9 March is 08:45 EDT -- before it, so the prior day holds.
    assert.equal(holderOn('2026-03-09T12:45:00Z'), b);
  });
});

describe('oncallEngine: layer stacking and overrides', () => {
  test('a higher layer takes precedence while its restriction is active, and the lower layer shows through outside it', () => {
    const ws = newWorkspace();
    const [primary, dayShift] = [newUser('Primary'), newUser('DayShift')];
    const sched = newSchedule(ws);

    const base = newLayer(sched, { layer_order: 1, name: '24x7 primary', start_date: '2026-01-05' });
    addMembers(base, [primary]);

    // Mon-Fri 09:00-17:00 only.
    const top = newLayer(sched, {
      layer_order: 2, name: 'Business hours', start_date: '2026-01-05',
      restriction: JSON.stringify({ days: [1, 2, 3, 4, 5], start_time: '09:00', end_time: '17:00' }),
    });
    addMembers(top, [dayShift]);

    // Tuesday 6 Jan 2026 at 12:00 UTC -- inside the business-hours window.
    const inHours = resolveOnCall(sched, new Date('2026-01-06T12:00:00Z'));
    assert.equal(inHours.user?.id, dayShift);
    assert.equal(inHours.layerName, 'Business hours');

    // Same Tuesday at 20:00 -- outside it, so the 24x7 layer is responsible.
    const afterHours = resolveOnCall(sched, new Date('2026-01-06T20:00:00Z'));
    assert.equal(afterHours.user?.id, primary);
    assert.equal(afterHours.layerName, '24x7 primary');

    // Saturday 10 Jan at 12:00 -- restricted layer excludes weekends.
    assert.equal(resolveOnCall(sched, new Date('2026-01-10T12:00:00Z')).user?.id, primary);
  });

  test('a restriction whose window wraps past midnight covers the night, not the day', () => {
    const ws = newWorkspace();
    const [primary, night] = [newUser('Primary'), newUser('Night')];
    const sched = newSchedule(ws);
    const base = newLayer(sched, { layer_order: 1, name: 'Primary', start_date: '2026-01-05' });
    addMembers(base, [primary]);
    const nightLayer = newLayer(sched, {
      layer_order: 2, name: 'Night', start_date: '2026-01-05',
      restriction: JSON.stringify({ start_time: '22:00', end_time: '06:00' }),
    });
    addMembers(nightLayer, [night]);

    assert.equal(resolveOnCall(sched, new Date('2026-01-06T23:00:00Z')).user?.id, night, '23:00 is inside a 22:00-06:00 window');
    assert.equal(resolveOnCall(sched, new Date('2026-01-06T03:00:00Z')).user?.id, night, '03:00 is inside it too');
    assert.equal(resolveOnCall(sched, new Date('2026-01-06T12:00:00Z')).user?.id, primary, 'midday is not');
  });

  test('an override beats every layer for its window and reports itself as the reason', () => {
    const ws = newWorkspace();
    const [rota, cover] = [newUser('Rota'), newUser('Cover')];
    const sched = newSchedule(ws);
    const layer = newLayer(sched, { start_date: '2026-01-05' });
    addMembers(layer, [rota]);

    db.prepare(
      'INSERT INTO oncall_overrides (id, schedule_id, user_id, start_at, end_at, reason) VALUES (?,?,?,?,?,?)'
    ).run(uid('oco'), sched, cover, '2026-01-07T00:00:00.000Z', '2026-01-08T00:00:00.000Z', 'Rota is at a wedding');

    const during = resolveOnCall(sched, new Date('2026-01-07T12:00:00Z'));
    assert.equal(during.user?.id, cover);
    assert.equal(during.source, 'override');
    assert.match(during.reason, /wedding/);

    // The window is half-open: the end instant itself is back on the rotation.
    assert.equal(resolveOnCall(sched, new Date('2026-01-08T00:00:00Z')).user?.id, rota);
  });

  test('a disabled schedule puts nobody on call', () => {
    const ws = newWorkspace();
    const a = newUser('Ana');
    const sched = newSchedule(ws, { enabled: 0 });
    const layer = newLayer(sched, { start_date: '2026-01-05' });
    addMembers(layer, [a]);

    const res = resolveOnCall(sched, new Date('2026-01-06T12:00:00Z'));
    assert.equal(res.user, null);
    assert.equal(res.source, 'disabled');
  });

  test('a layer with no members is skipped so a lower layer still answers', () => {
    const ws = newWorkspace();
    const primary = newUser('Primary');
    const sched = newSchedule(ws);
    const base = newLayer(sched, { layer_order: 1, name: 'Primary', start_date: '2026-01-05' });
    addMembers(base, [primary]);
    newLayer(sched, { layer_order: 2, name: 'Empty secondary', start_date: '2026-01-05' }); // no members

    assert.equal(resolveOnCall(sched, new Date('2026-01-06T12:00:00Z')).user?.id, primary);
  });

  test('a malformed restriction does not black out its layer', () => {
    const ws = newWorkspace();
    const a = newUser('Ana');
    const sched = newSchedule(ws);
    const layer = newLayer(sched, { start_date: '2026-01-05', restriction: 'not json{{{' });
    addMembers(layer, [a]);

    assert.equal(resolveOnCall(sched, new Date('2026-01-06T12:00:00Z')).user?.id, a);
  });
});

describe('oncallEngine: range and lookup helpers', () => {
  test('resolveShiftRange coalesces equal samples into contiguous blocks', () => {
    const ws = newWorkspace();
    const [a, b] = [newUser('Ana'), newUser('Bo')];
    const sched = newSchedule(ws);
    const layer = newLayer(sched, { rotation_type: 'daily', rotation_length_days: 1, handoff_time: '09:00', start_date: '2026-01-05' });
    addMembers(layer, [a, b]);

    const blocks = resolveShiftRange(sched, new Date('2026-01-05T09:00:00Z'), new Date('2026-01-08T09:00:00Z'), 60);
    // Three daily shifts across three days, alternating between two people.
    assert.ok(blocks.length >= 3, `expected at least 3 blocks, got ${blocks.length}`);
    const holders = blocks.map((x) => x.user?.id);
    assert.equal(holders[0], a);
    // No two adjacent blocks may report the same holder -- that would mean
    // coalescing failed.
    for (let i = 1; i < blocks.length; i += 1) {
      assert.notEqual(holders[i], holders[i - 1], `block ${i} did not coalesce into block ${i - 1}`);
    }
  });

  test('resolveShiftRange returns nothing for an inverted window', () => {
    const ws = newWorkspace();
    const sched = newSchedule(ws);
    assert.deepEqual(resolveShiftRange(sched, new Date('2026-02-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z')), []);
  });

  test('isUserOnCall only sees schedules in its own workspace', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    const person = newUser('Shared');

    const schedA = newSchedule(wsA);
    const layerA = newLayer(schedA, { start_date: '2026-01-05' });
    addMembers(layerA, [person]);

    const at = new Date('2026-01-06T12:00:00Z');
    assert.equal(isUserOnCall(wsA, person, at), true);
    assert.equal(isUserOnCall(wsB, person, at), false, 'another workspace must not see this schedule');
  });
});
