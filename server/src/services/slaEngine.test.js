import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  SlaError, businessMinutesBetween, addBusinessMinutes, isHoliday,
  pauseSla, resumeSla, syncPauseState, recalculateTargets, slaSnapshot,
  evaluateSlaSafely, listSlaEvents, thresholdsFor, pauseStatusesFor,
  listHolidays, addHoliday, deleteHoliday, DEFAULT_THRESHOLDS,
} from './slaEngine.js';
import { runTotals } from './reportBuilder.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'T ' + id, id);
  // Mon-Fri 09:00-17:00, so the arithmetic below is predictable.
  for (const d of [1, 2, 3, 4, 5]) {
    db.prepare('INSERT INTO business_hours (id, workspace_id, day_of_week, start_time, end_time) VALUES (?,?,?,?,?)')
      .run(uid('bh'), id, d, '09:00', '17:00');
  }
  return id;
}

function newPolicy(ws, over = {}) {
  const id = uid('sla');
  const p = {
    name: 'Standard', response_minutes: 60, resolution_minutes: 480, business_hours_only: 0,
    ola_response_minutes: null, ola_resolution_minutes: null,
    warning_thresholds: null, pause_on_statuses: null, ...over,
  };
  db.prepare(
    `INSERT INTO sla_policies (id, workspace_id, name, response_minutes, resolution_minutes, business_hours_only, enabled,
                               ola_response_minutes, ola_resolution_minutes, warning_thresholds, pause_on_statuses)
     VALUES (?,?,?,?,?,?,1,?,?,?,?)`
  ).run(id, ws, p.name, p.response_minutes, p.resolution_minutes, p.business_hours_only,
    p.ola_response_minutes, p.ola_resolution_minutes, p.warning_thresholds, p.pause_on_statuses);
  return id;
}

let seq = 0;
function newTicket(ws, over = {}) {
  const id = uid('tkt');
  seq += 1;
  const t = {
    type: 'incident', title: 'Broken', status: 'open', priority: 'medium',
    created_at: new Date().toISOString(), sla_due_at: null, response_due_at: null,
    sla_policy_id: null, responded_at: null, resolved_at: null, ...over,
  };
  const COLUMNS = ['type', 'title', 'status', 'priority', 'created_at', 'sla_due_at', 'response_due_at',
    'sla_policy_id', 'responded_at', 'resolved_at', 'ola_due_at', 'ola_response_due_at', 'reopened_count'];
  for (const k of Object.keys(over)) {
    if (!COLUMNS.includes(k)) throw new Error(`test helper cannot set unknown column: ${k}`);
  }
  const cols = COLUMNS.filter((c) => t[c] !== undefined);
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, ${cols.join(', ')})
     VALUES (?,?,?,${cols.map(() => '?').join(',')})`
  ).run(id, ws, `INC-${4000 + seq}`, ...cols.map((c) => t[c]));
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}
const reload = (id) => db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);

// A fixed Monday, so "two working days later" is arithmetic rather than
// whenever the suite happens to run.
const MONDAY_10AM = () => { const d = new Date(2026, 5, 1, 10, 0, 0); return d; }; // 2026-06-01 is a Monday

describe('working time', () => {
  test('only the hours inside the business window count', () => {
    const ws = newWorkspace();
    const from = MONDAY_10AM();
    const to = new Date(2026, 5, 1, 15, 0, 0);
    assert.equal(businessMinutesBetween(from, to, ws, true), 300);
  });

  test('evenings and weekends do not count', () => {
    const ws = newWorkspace();
    // Friday 16:00 to Monday 10:00 is one hour of Friday plus one of Monday.
    const from = new Date(2026, 5, 5, 16, 0, 0);  // Friday
    const to = new Date(2026, 5, 8, 10, 0, 0);    // Monday
    assert.equal(businessMinutesBetween(from, to, ws, true), 120);
  });

  test('without business hours the clock simply runs', () => {
    const ws = newWorkspace();
    const from = new Date(2026, 5, 5, 16, 0, 0);
    const to = new Date(2026, 5, 8, 16, 0, 0);
    assert.equal(businessMinutesBetween(from, to, ws, false), 3 * 24 * 60);
  });

  test('a backwards or zero range is zero, never negative', () => {
    const ws = newWorkspace();
    assert.equal(businessMinutesBetween(new Date(2026, 5, 8), new Date(2026, 5, 1), ws, true), 0);
    assert.equal(businessMinutesBetween(new Date(2026, 5, 1), new Date(2026, 5, 1), ws, true), 0);
  });

  test('a holiday takes the whole day out', () => {
    const ws = newWorkspace();
    const from = MONDAY_10AM();
    const to = new Date(2026, 5, 2, 10, 0, 0);   // Tuesday 10:00
    assert.equal(businessMinutesBetween(from, to, ws, true), 480, 'Mon 10-17 (420) plus Tue 9-10 (60)');

    addHoliday(ws, { date: '2026-06-02', name: 'Test holiday' });
    assert.equal(businessMinutesBetween(from, to, ws, true), 420, 'Tuesday morning no longer counts');
  });

  test('a recurring holiday applies in every year', () => {
    const ws = newWorkspace();
    addHoliday(ws, { date: '2020-12-25', name: 'Christmas', recurs_annually: true });
    assert.equal(isHoliday(ws, new Date(2026, 11, 25)), true);
    assert.equal(isHoliday(ws, new Date(2026, 11, 26)), false);
  });

  test('adding working minutes skips holidays too', () => {
    const ws = newWorkspace();
    addHoliday(ws, { date: '2026-06-02' });
    // Eight working hours from Monday 10:00 would normally land Tuesday
    // 10:00; with Tuesday a holiday it lands Wednesday.
    const due = new Date(addBusinessMinutes(480, MONDAY_10AM(), ws, true));
    assert.equal(due.getDate(), 3, `landed on the ${due.getDate()}th`);
  });

  test('holidays are validated and unique', () => {
    const ws = newWorkspace();
    assert.throws(() => addHoliday(ws, { date: 'Christmas' }), /YYYY-MM-DD/);
    addHoliday(ws, { date: '2026-06-02' });
    assert.throws(() => addHoliday(ws, { date: '2026-06-02' }), (e) => e.status === 409);
    assert.equal(listHolidays(ws).length, 1);
    deleteHoliday(ws, listHolidays(ws)[0].id);
    assert.equal(listHolidays(ws).length, 0);
    assert.throws(() => deleteHoliday(ws, 'hol_nope'), (e) => e.status === 404);
  });

  test('one workspace never sees another calendar', () => {
    const a = newWorkspace(); const b = newWorkspace();
    addHoliday(a, { date: '2026-06-02' });
    assert.equal(isHoliday(a, new Date(2026, 5, 2)), true);
    assert.equal(isHoliday(b, new Date(2026, 5, 2)), false);
  });
});

describe('pausing the clock', () => {
  test('a pause is recorded, and resuming moves the target out by the wait', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws);
    const due = new Date(Date.now() + 4 * 3600000).toISOString();
    const t = newTicket(ws, { sla_policy_id: policy, sla_due_at: due, response_due_at: due });

    const paused = pauseSla(t, 'Waiting on the requester');
    assert.ok(paused.sla_paused_at);
    assert.equal(reload(t.id).sla_pause_reason, 'Waiting on the requester');

    // Pretend the wait lasted an hour.
    const anHourAgo = new Date(Date.now() - 3600000).toISOString();
    db.prepare('UPDATE tickets SET sla_paused_at = ? WHERE id = ?').run(anHourAgo, t.id);

    const resumed = resumeSla(reload(t.id));
    assert.equal(resumed.sla_paused_at, null);
    assert.ok(resumed.sla_paused_minutes >= 59 && resumed.sla_paused_minutes <= 61, `${resumed.sla_paused_minutes}`);
    assert.ok(new Date(resumed.sla_due_at) > new Date(due), 'the target must move out, or the wait was charged to the desk');
  });

  test('pausing twice does nothing the second time', () => {
    const ws = newWorkspace();
    const t = newTicket(ws, { sla_policy_id: newPolicy(ws) });
    const first = pauseSla(t, 'one');
    const second = pauseSla(reload(t.id), 'two');
    assert.equal(second.sla_paused_at, first.sla_paused_at);
    assert.equal(reload(t.id).sla_pause_reason, 'one', 'the original reason stands');
  });

  test('resuming a running clock is a no-op', () => {
    const ws = newWorkspace();
    const due = new Date(Date.now() + 3600000).toISOString();
    const t = newTicket(ws, { sla_policy_id: newPolicy(ws), sla_due_at: due });
    assert.equal(resumeSla(t).sla_due_at, due);
  });

  test('a resolved ticket cannot be paused', () => {
    const ws = newWorkspace();
    const t = newTicket(ws, { status: 'resolved', sla_policy_id: newPolicy(ws) });
    assert.equal(pauseSla(t, 'x').sla_paused_at, null);
  });

  test('the status drives the clock through the configured pause states', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws, { pause_on_statuses: JSON.stringify(['on_hold']) });
    const t = newTicket(ws, { sla_policy_id: policy, sla_due_at: new Date(Date.now() + 3600000).toISOString() });

    const held = syncPauseState(t, 'on_hold');
    assert.ok(held.sla_paused_at, 'going on hold stops the clock');

    const back = syncPauseState(reload(t.id), 'in_progress');
    assert.equal(back.sla_paused_at, null, 'coming back starts it again');
  });

  test('a policy can choose its own pause states', () => {
    const ws = newWorkspace();
    const policy = db.prepare('SELECT * FROM sla_policies WHERE id = ?').get(
      newPolicy(ws, { pause_on_statuses: JSON.stringify(['pending_approval']) })
    );
    assert.deepEqual(pauseStatusesFor(policy), ['pending_approval']);
    // A policy that says nothing gets the sensible default.
    assert.ok(pauseStatusesFor(null).includes('on_hold'));
  });

  test('resolving while paused does not resume and re-charge the wait', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws, { pause_on_statuses: JSON.stringify(['on_hold']) });
    const t = newTicket(ws, { status: 'on_hold', sla_policy_id: policy, sla_due_at: new Date(Date.now() + 3600000).toISOString() });
    pauseSla(t, 'waiting');
    const done = syncPauseState(reload(t.id), 'resolved');
    assert.equal(done.sla_paused_at, null, 'the clock stops for good');
  });

  test('every pause and resume is on the record', () => {
    const ws = newWorkspace();
    const t = newTicket(ws, { sla_policy_id: newPolicy(ws), sla_due_at: new Date(Date.now() + 3600000).toISOString() });
    pauseSla(t, 'Waiting on a vendor');
    resumeSla(reload(t.id));
    const kinds = listSlaEvents(ws, t.id).map((e) => e.kind);
    assert.deepEqual(kinds, ['paused', 'resumed']);
  });
});

describe('targets and thresholds', () => {
  test('thresholds default sensibly and can be configured', () => {
    assert.deepEqual(thresholdsFor(null), DEFAULT_THRESHOLDS);
    assert.deepEqual(thresholdsFor({ warning_thresholds: JSON.stringify([25, 90]) }), [25, 90]);
    // Nonsense is dropped rather than allowed to fire constantly.
    assert.deepEqual(thresholdsFor({ warning_thresholds: JSON.stringify([0, 100, 150, 'x', 60]) }), [60]);
  });

  test('a warning fires once per threshold, not on every read', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws, { warning_thresholds: JSON.stringify([50]) });
    // Raised two hours ago against a two-hour target: 100% consumed.
    const created = new Date(Date.now() - 2 * 3600000).toISOString();
    const t = newTicket(ws, {
      created_at: created, sla_policy_id: policy,
      sla_due_at: new Date(Date.now() + 10 * 60000).toISOString(),
    });
    evaluateSlaSafely(reload(t.id));
    evaluateSlaSafely(reload(t.id));
    evaluateSlaSafely(reload(t.id));
    const warnings = listSlaEvents(ws, t.id).filter((e) => e.kind === 'warning');
    assert.equal(warnings.length, 1, 'opening a ticket three times must not warn three times');
    assert.equal(warnings[0].threshold, 50);
  });

  test('a breach is stamped with a reason and a time', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws);
    const t = newTicket(ws, {
      created_at: new Date(Date.now() - 3 * 3600000).toISOString(),
      sla_policy_id: policy,
      sla_due_at: new Date(Date.now() - 3600000).toISOString(),
    });
    evaluateSlaSafely(reload(t.id));
    const after = reload(t.id);
    assert.equal(after.sla_breached, 1);
    assert.ok(after.sla_breached_at);
    assert.match(after.sla_breach_reason, /Resolution target passed/);
    assert.equal(listSlaEvents(ws, t.id).filter((e) => e.kind === 'breached').length, 1);
  });

  test('a paused ticket does not accrue warnings', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws, { warning_thresholds: JSON.stringify([50]) });
    const t = newTicket(ws, {
      created_at: new Date(Date.now() - 3 * 3600000).toISOString(),
      sla_policy_id: policy, sla_due_at: new Date(Date.now() - 3600000).toISOString(),
    });
    db.prepare('UPDATE tickets SET sla_paused_at = ? WHERE id = ?').run(new Date().toISOString(), t.id);
    evaluateSlaSafely(reload(t.id));
    assert.equal(listSlaEvents(ws, t.id).length, 0, 'a stopped clock cannot breach');
  });

  test('a resolved ticket stops accruing anything', () => {
    const ws = newWorkspace();
    const t = newTicket(ws, {
      status: 'resolved', resolved_at: new Date().toISOString(),
      sla_policy_id: newPolicy(ws), sla_due_at: new Date(Date.now() - 3600000).toISOString(),
    });
    evaluateSlaSafely(reload(t.id));
    assert.equal(listSlaEvents(ws, t.id).length, 0);
  });

  test('regrading recomputes the target from when it was raised', () => {
    // Measuring from "now" would reward noticing late: a ticket regraded to
    // critical after two days would get a fresh critical clock.
    const ws = newWorkspace();
    const policy = newPolicy(ws, { resolution_minutes: 60 });
    const created = new Date(Date.now() - 5 * 3600000).toISOString();
    const t = newTicket(ws, { created_at: created, sla_policy_id: policy });
    const after = recalculateTargets(reload(t.id), 'priority became critical');
    // 60 minutes from creation, five hours ago, is already in the past.
    assert.ok(new Date(after.sla_due_at) < new Date(), 'the target should already have passed');
    assert.equal(listSlaEvents(ws, t.id).filter((e) => e.kind === 'recalculated').length, 1);
  });

  test('a recalculation keeps time already paused', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws, { resolution_minutes: 60 });
    const t = newTicket(ws, { created_at: new Date().toISOString(), sla_policy_id: policy });
    db.prepare('UPDATE tickets SET sla_paused_minutes = 120 WHERE id = ?').run(t.id);
    const after = recalculateTargets(reload(t.id), 'regraded');
    const minutes = (new Date(after.sla_due_at) - new Date(t.created_at)) / 60000;
    assert.ok(minutes >= 178 && minutes <= 182, `expected 60 + 120 paused, got ${Math.round(minutes)}`);
  });
});

describe('the live picture', () => {
  test('elapsed, remaining and percentage consumed are reported', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws, { resolution_minutes: 240 });
    const t = newTicket(ws, {
      created_at: new Date(Date.now() - 2 * 3600000).toISOString(),
      sla_policy_id: policy,
      sla_due_at: new Date(Date.now() + 2 * 3600000).toISOString(),
    });
    const snap = slaSnapshot(reload(t.id));
    assert.equal(snap.resolution.state, 'running');
    assert.ok(snap.resolution.consumed_pct >= 45 && snap.resolution.consumed_pct <= 55, `${snap.resolution.consumed_pct}%`);
    assert.ok(snap.resolution.remaining_minutes > 0);
    assert.equal(snap.resolution.over_by_minutes, 0);
  });

  test('a missed target reports how far over it went, uncapped', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws, { resolution_minutes: 60 });
    const t = newTicket(ws, {
      created_at: new Date(Date.now() - 4 * 3600000).toISOString(),
      sla_policy_id: policy,
      sla_due_at: new Date(Date.now() - 3 * 3600000).toISOString(),
      status: 'resolved', resolved_at: new Date().toISOString(),
    });
    const snap = slaSnapshot(reload(t.id));
    assert.equal(snap.resolution.state, 'missed');
    assert.ok(snap.resolution.consumed_pct > 100, `a blown target should read over 100%, got ${snap.resolution.consumed_pct}`);
    assert.ok(snap.resolution.over_by_minutes > 0);
  });

  test('a met target reads as met, not merely not-breached', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws, { resolution_minutes: 240 });
    const t = newTicket(ws, {
      created_at: new Date(Date.now() - 2 * 3600000).toISOString(),
      sla_policy_id: policy,
      sla_due_at: new Date(Date.now() + 2 * 3600000).toISOString(),
      status: 'resolved', resolved_at: new Date().toISOString(),
    });
    assert.equal(slaSnapshot(reload(t.id)).resolution.state, 'met');
  });

  test('a paused ticket says so, and why', () => {
    const ws = newWorkspace();
    const t = newTicket(ws, { sla_policy_id: newPolicy(ws), sla_due_at: new Date(Date.now() + 3600000).toISOString() });
    pauseSla(t, 'Waiting on a vendor');
    const snap = slaSnapshot(reload(t.id));
    assert.equal(snap.paused, true);
    assert.equal(snap.pause_reason, 'Waiting on a vendor');
    assert.equal(snap.resolution.state, 'paused');
  });

  test('the internal target is measured separately from the customer one', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws, { resolution_minutes: 480, ola_resolution_minutes: 60 });
    const t = newTicket(ws, {
      created_at: new Date(Date.now() - 2 * 3600000).toISOString(),
      sla_policy_id: policy,
      sla_due_at: new Date(Date.now() + 6 * 3600000).toISOString(),
      ola_due_at: new Date(Date.now() - 3600000).toISOString(),
    });
    evaluateSlaSafely(reload(t.id));
    const after = reload(t.id);
    assert.equal(after.ola_breached, 1, 'the internal handover was missed');
    assert.equal(after.sla_breached, 0, 'but the customer promise is still intact');
    const snap = slaSnapshot(after);
    assert.equal(snap.ola_resolution.state, 'breached');
    assert.equal(snap.resolution.state, 'running');
  });

  test('a ticket with no policy simply has no clocks', () => {
    const ws = newWorkspace();
    const snap = slaSnapshot(newTicket(ws));
    assert.equal(snap.resolution, null);
    assert.equal(snap.response, null);
  });
});

describe('benchmark metrics', () => {
  test('MTTA and MTTR each count only the tickets that reached that point', () => {
    const ws = newWorkspace();
    const created = new Date(Date.now() - 4 * 3600000).toISOString();
    newTicket(ws, { created_at: created, responded_at: new Date(Date.now() - 3 * 3600000).toISOString(), status: 'resolved', resolved_at: new Date(Date.now() - 2 * 3600000).toISOString() });
    newTicket(ws, { created_at: created });  // never responded to, never resolved

    const totals = runTotals(ws);
    assert.ok(Math.abs(totals.mtta_hours - 1) < 0.1, `mtta ${totals.mtta_hours}`);
    assert.ok(Math.abs(totals.mttr_hours - 2) < 0.1, `mttr ${totals.mttr_hours}`);
  });

  test('rates use their own denominators, not the row total', () => {
    const ws = newWorkspace();
    // Two resolved, one of them reopened; plus an unresolved one that must
    // not drag the reopen rate down.
    newTicket(ws, { status: 'resolved', resolved_at: new Date().toISOString() });
    const r = newTicket(ws, { status: 'resolved', resolved_at: new Date().toISOString() });
    db.prepare('UPDATE tickets SET reopened_count = 1 WHERE id = ?').run(r.id);
    newTicket(ws, { status: 'open' });

    const totals = runTotals(ws);
    assert.equal(totals.count, 3);
    assert.equal(totals.resolved, 2);
    assert.equal(totals.reopen_rate_pct, 50, 'one of two resolved was reopened');
  });

  test('SLA compliance ignores tickets that never had a target', () => {
    const ws = newWorkspace();
    const policy = newPolicy(ws);
    // One met, one breached, one with no policy at all.
    newTicket(ws, { sla_policy_id: policy, sla_due_at: new Date(Date.now() + 3600000).toISOString() });
    newTicket(ws, { sla_policy_id: policy, sla_due_at: new Date(Date.now() - 3600000).toISOString() });
    newTicket(ws, {});

    const totals = runTotals(ws);
    assert.equal(totals.sla_compliance_pct, 50, 'the untargeted ticket is not applicable, not a pass');
  });

  test('a breach earlier the same day is counted', () => {
    // sla_due_at is stored as an ISO string ("...T09:00:00.000Z") while
    // datetime('now') uses a space. Compared as plain strings a space sorts
    // before 'T', so a ticket that blew its target two hours ago read as
    // perfectly healthy until the due date fell on an earlier CALENDAR DAY.
    // Every SLA figure in the product was quietly wrong for same-day misses.
    const ws = newWorkspace();
    const policy = newPolicy(ws);
    newTicket(ws, {
      sla_policy_id: policy,
      created_at: new Date(Date.now() - 4 * 3600000).toISOString(),
      sla_due_at: new Date(Date.now() - 2 * 3600000).toISOString(),
    });
    assert.equal(runTotals(ws).breached, 1, 'a target missed two hours ago is a miss');
  });

  test('a same-day miss on a resolved ticket is counted too', () => {
    // resolved_at is stamped by SQLite (space separator) and compared against
    // the ISO sla_due_at -- the same mismatch from the other direction.
    const ws = newWorkspace();
    const policy = newPolicy(ws);
    const t = newTicket(ws, {
      sla_policy_id: policy,
      created_at: new Date(Date.now() - 4 * 3600000).toISOString(),
      sla_due_at: new Date(Date.now() - 3 * 3600000).toISOString(),
      status: 'resolved',
    });
    db.prepare("UPDATE tickets SET resolved_at = datetime('now') WHERE id = ?").run(t.id);
    assert.equal(runTotals(ws).breached, 1, 'resolved after its target is still a miss');
  });

  test('with nothing resolved the rates are unknown rather than zero', () => {
    const ws = newWorkspace();
    newTicket(ws, { status: 'open' });
    const totals = runTotals(ws);
    assert.equal(totals.reopen_rate_pct, null);
    assert.equal(totals.first_contact_resolution_pct, null);
    assert.equal(totals.mttr_hours, null);
  });
});
