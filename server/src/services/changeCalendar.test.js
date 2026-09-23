import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  findConflicts, activeFreezes, evaluateWindow, suggestAlternateSlots,
  reserveSlot, releaseSlot, calendarView,
} from './changeCalendar.js';
import { listChangeTypes } from './changeTypes.js';
import { matchTemplate, listTemplates, applyTemplate } from './changeTemplates.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  listChangeTypes(id);
  return id;
}

function newChange(workspaceId, fields = {}) {
  const id = uid('tkt');
  const f = { change_type: 'normal', category: 'Software', subcategory: null, title: 'Calendar test', ...fields };
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, status, change_type, category, subcategory, change_state)
     VALUES (?,?,?,'change',?,'open',?,?,?,'approved')`
  ).run(id, workspaceId, `CHG-${id.slice(-5)}`, f.title, f.change_type, f.category, f.subcategory);
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

let assetSeq = 0;
function newAsset(workspaceId, type = 'server') {
  const id = uid('ast');
  assetSeq += 1;
  db.prepare('INSERT INTO assets (id, workspace_id, tag, name, type, status) VALUES (?,?,?,?,?,?)').run(
    id, workspaceId, `TAG-${assetSeq}`, `asset-${assetSeq}`, type, 'active'
  );
  return id;
}
const linkAsset = (ticketId, assetId) =>
  db.prepare('INSERT INTO ticket_assets (id, ticket_id, asset_id) VALUES (?,?,?)').run(uid('ta'), ticketId, assetId);

function reserve(workspaceId, ticket, start, end) {
  db.prepare('INSERT INTO change_calendar_slots (id, workspace_id, ticket_id, start_at, end_at) VALUES (?,?,?,?,?)').run(
    uid('ccs'), workspaceId, ticket.id, start, end
  );
}

function freeze(workspaceId, fields = {}) {
  const f = {
    name: 'Year end', start_at: '2026-12-20T00:00:00.000Z', end_at: '2027-01-05T00:00:00.000Z',
    scope: 'all', scope_value: null, allow_emergency: 1, ...fields,
  };
  const id = uid('cfw');
  db.prepare(
    'INSERT INTO change_freeze_windows (id, workspace_id, name, start_at, end_at, scope, scope_value, allow_emergency) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, workspaceId, f.name, f.start_at, f.end_at, f.scope, f.scope_value, f.allow_emergency);
  return id;
}

const W = {
  start: '2026-12-01T22:00:00.000Z',
  end: '2026-12-01T23:00:00.000Z',
};

describe('changeCalendar: overlap detection', () => {
  test('windows are half-open, so back-to-back slots do not conflict', () => {
    const ws = newWorkspace();
    const existing = newChange(ws);
    reserve(ws, existing, '2026-12-01T21:00:00.000Z', '2026-12-01T22:00:00.000Z');

    // Starts exactly when the other ends.
    const { conflicts } = findConflicts(ws, { start: W.start, end: W.end });
    assert.equal(conflicts.length, 0, 'touching windows are not overlapping');
  });

  test('a one-minute overlap is a conflict', () => {
    const ws = newWorkspace();
    const existing = newChange(ws);
    reserve(ws, existing, '2026-12-01T21:00:00.000Z', '2026-12-01T22:01:00.000Z');
    assert.equal(findConflicts(ws, { start: W.start, end: W.end }).conflicts.length, 1);
  });

  test('a fully enclosed window conflicts', () => {
    const ws = newWorkspace();
    const existing = newChange(ws);
    reserve(ws, existing, '2026-12-01T20:00:00.000Z', '2026-12-02T02:00:00.000Z');
    assert.equal(findConflicts(ws, { start: W.start, end: W.end }).conflicts.length, 1);
  });

  test('a change does not conflict with its own reservation', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    reserve(ws, change, W.start, W.end);
    assert.equal(findConflicts(ws, { ...W, excludeTicketId: change.id }).conflicts.length, 0);
  });

  test('released slots are ignored', () => {
    const ws = newWorkspace();
    const existing = newChange(ws);
    reserve(ws, existing, W.start, W.end);
    db.prepare("UPDATE change_calendar_slots SET status = 'released' WHERE ticket_id = ?").run(existing.id);
    assert.equal(findConflicts(ws, W).conflicts.length, 0);
  });

  test('closed and rolled-back changes stop holding the calendar', () => {
    const ws = newWorkspace();
    const existing = newChange(ws);
    reserve(ws, existing, W.start, W.end);
    db.prepare("UPDATE tickets SET change_state = 'closed' WHERE id = ?").run(existing.id);
    assert.equal(findConflicts(ws, W).conflicts.length, 0);
  });

  // The distinction that makes the calendar usable rather than noisy.
  test('a shared CI makes a conflict blocking; an unrelated one is only advisory', () => {
    const ws = newWorkspace();
    const database = newAsset(ws);

    const mine = newChange(ws);
    linkAsset(mine.id, database);

    const theirs = newChange(ws);
    linkAsset(theirs.id, database);
    reserve(ws, theirs, W.start, W.end);

    const shared = findConflicts(ws, { ...W, excludeTicketId: mine.id });
    assert.equal(shared.conflicts.length, 1);
    assert.equal(shared.conflicts[0].severity, 'blocking');
    assert.equal(shared.blocking.length, 1);

    // Now an unrelated change on its own CI at the same time.
    const unrelated = newChange(ws);
    linkAsset(unrelated.id, newAsset(ws));
    const advisory = findConflicts(ws, { ...W, excludeTicketId: unrelated.id });
    assert.ok(advisory.conflicts.length >= 1);
    assert.equal(advisory.blocking.length, 0, 'different CIs at the same time is congestion, not collision');
  });

  test('an invalid window is reported rather than silently matching nothing', () => {
    const ws = newWorkspace();
    const result = findConflicts(ws, { start: W.end, end: W.start });
    assert.ok(result.error);
    assert.deepEqual(result.conflicts, []);
  });

  test('conflicts never cross workspaces', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    const theirs = newChange(wsA);
    reserve(wsA, theirs, W.start, W.end);
    assert.equal(findConflicts(wsB, W).conflicts.length, 0);
  });
});

describe('changeCalendar: freeze windows', () => {
  const inFreeze = { start: '2026-12-24T10:00:00.000Z', end: '2026-12-24T12:00:00.000Z' };

  test('a window inside a freeze is detected', () => {
    const ws = newWorkspace();
    freeze(ws);
    const change = newChange(ws);
    assert.equal(activeFreezes(ws, { ...inFreeze, ticket: change }).length, 1);
  });

  test('a window outside every freeze is clear', () => {
    const ws = newWorkspace();
    freeze(ws);
    const change = newChange(ws);
    assert.equal(activeFreezes(ws, { ...W, ticket: change }).length, 0);
  });

  test('a disabled freeze does not apply', () => {
    const ws = newWorkspace();
    freeze(ws);
    db.prepare('UPDATE change_freeze_windows SET enabled = 0 WHERE workspace_id = ?').run(ws);
    assert.equal(activeFreezes(ws, { ...inFreeze, ticket: newChange(ws) }).length, 0);
  });

  test('a category-scoped freeze only catches that category', () => {
    const ws = newWorkspace();
    freeze(ws, { name: 'Finance close', scope: 'category', scope_value: 'Software' });
    assert.equal(activeFreezes(ws, { ...inFreeze, ticket: newChange(ws, { category: 'Software' }) }).length, 1);
    assert.equal(activeFreezes(ws, { ...inFreeze, ticket: newChange(ws, { category: 'Hardware' }) }).length, 0);
  });

  test('a CI-scoped freeze only catches changes touching that CI', () => {
    const ws = newWorkspace();
    const database = newAsset(ws);
    freeze(ws, { name: 'DB freeze', scope: 'asset', scope_value: database });

    const touching = newChange(ws);
    linkAsset(touching.id, database);
    assert.equal(activeFreezes(ws, { ...inFreeze, ticket: touching }).length, 1);

    const elsewhere = newChange(ws);
    linkAsset(elsewhere.id, newAsset(ws));
    assert.equal(activeFreezes(ws, { ...inFreeze, ticket: elsewhere }).length, 0);
  });

  test('a Normal change is hard-stopped by a freeze', () => {
    const ws = newWorkspace();
    freeze(ws);
    const verdict = evaluateWindow(ws, newChange(ws, { change_type: 'normal' }), inFreeze);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /change freeze/i);
    assert.equal(verdict.hardFreezes.length, 1);
  });

  // The judgment call: a freeze is policy, not a wall -- but piercing it is
  // a recorded act.
  test('an Emergency change may pierce a freeze, but only with a reason', () => {
    const ws = newWorkspace();
    freeze(ws, { allow_emergency: 1 });
    const change = newChange(ws, { change_type: 'emergency' });

    const verdict = evaluateWindow(ws, change, inFreeze);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.requiresOverride, true);

    const noReason = reserveSlot(ws, change, { ...inFreeze });
    assert.equal(noReason.ok, false);
    assert.equal(noReason.requiresOverride, true);

    const withReason = reserveSlot(ws, change, { ...inFreeze, overrideReason: 'Sev1 outage, exec approved' });
    assert.equal(withReason.ok, true);
    const after = db.prepare('SELECT freeze_override_reason FROM tickets WHERE id = ?').get(change.id);
    assert.match(after.freeze_override_reason, /Sev1 outage/);
  });

  test('a freeze that forbids emergencies stops even an Emergency change', () => {
    const ws = newWorkspace();
    freeze(ws, { name: 'Hard freeze', allow_emergency: 0 });
    const verdict = evaluateWindow(ws, newChange(ws, { change_type: 'emergency' }), inFreeze);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.hardFreezes.length, 1);
  });
});

describe('changeCalendar: alternate slots', () => {
  test('suggests the next clear window of the same duration', () => {
    const ws = newWorkspace();
    freeze(ws, { start_at: '2026-12-01T00:00:00.000Z', end_at: '2026-12-03T00:00:00.000Z' });
    const change = newChange(ws, { change_type: 'normal' });

    const slots = suggestAlternateSlots(ws, change, { ...W, stepHours: 24, horizonDays: 10, limit: 2 });
    assert.ok(slots.length >= 1, 'should find something past the freeze');
    for (const slot of slots) {
      const duration = new Date(slot.end_at) - new Date(slot.start_at);
      assert.equal(duration, 3600000, 'the requested duration is preserved');
      assert.equal(evaluateWindow(ws, change, { start: slot.start_at, end: slot.end_at }).ok, true);
    }
  });

  test('never suggests a slot that would need a freeze override', () => {
    const ws = newWorkspace();
    // A long freeze covering the whole horizon, piercable by emergencies.
    freeze(ws, { start_at: '2026-12-01T00:00:00.000Z', end_at: '2027-02-01T00:00:00.000Z', allow_emergency: 1 });
    const emergency = newChange(ws, { change_type: 'emergency' });
    const slots = suggestAlternateSlots(ws, emergency, { ...W, horizonDays: 7 });
    assert.deepEqual(slots, [], 'suggesting "break the freeze later instead" is not an alternative');
  });

  test('returns nothing for an invalid window', () => {
    const ws = newWorkspace();
    assert.deepEqual(suggestAlternateSlots(ws, newChange(ws), { start: W.end, end: W.start }), []);
  });
});

describe('changeCalendar: reservation', () => {
  test('reserving stamps the window onto the change', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    const result = reserveSlot(ws, change, W);
    assert.equal(result.ok, true);

    const after = db.prepare('SELECT scheduled_start, scheduled_end FROM tickets WHERE id = ?').get(change.id);
    assert.equal(after.scheduled_start, W.start);
    assert.equal(after.scheduled_end, W.end);
  });

  test('re-scheduling releases the previous slot rather than holding two', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    reserveSlot(ws, change, W);
    reserveSlot(ws, db.prepare('SELECT * FROM tickets WHERE id = ?').get(change.id), {
      start: '2026-12-05T22:00:00.000Z', end: '2026-12-05T23:00:00.000Z',
    });

    const reserved = db.prepare("SELECT COUNT(*) c FROM change_calendar_slots WHERE ticket_id = ? AND status = 'reserved'").get(change.id).c;
    assert.equal(reserved, 1);
    const released = db.prepare("SELECT COUNT(*) c FROM change_calendar_slots WHERE ticket_id = ? AND status = 'released'").get(change.id).c;
    assert.equal(released, 1, 'the old slot is kept as history, not deleted');
  });

  test('a blocking conflict refuses the reservation and offers alternates', () => {
    const ws = newWorkspace();
    const database = newAsset(ws);

    const theirs = newChange(ws);
    linkAsset(theirs.id, database);
    reserve(ws, theirs, W.start, W.end);

    const mine = newChange(ws);
    linkAsset(mine.id, database);
    const result = reserveSlot(ws, mine, W);
    assert.equal(result.ok, false);
    assert.match(result.error, /same configuration item/);
    assert.ok(Array.isArray(result.alternates));
  });

  test('an advisory conflict is allowed but reported', () => {
    const ws = newWorkspace();
    const theirs = newChange(ws);
    linkAsset(theirs.id, newAsset(ws));
    reserve(ws, theirs, W.start, W.end);

    const mine = newChange(ws);
    linkAsset(mine.id, newAsset(ws));
    const result = reserveSlot(ws, mine, W);
    assert.equal(result.ok, true);
    assert.ok(result.advisoryConflicts.length >= 1, 'the congestion is surfaced, not hidden');
  });

  test('releasing clears the window and frees the calendar', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    reserveSlot(ws, change, W);
    releaseSlot(ws, change.id);

    const after = db.prepare('SELECT scheduled_start FROM tickets WHERE id = ?').get(change.id);
    assert.equal(after.scheduled_start, null);
    assert.equal(findConflicts(ws, W).conflicts.length, 0);
  });

  test('calendarView returns the slots and the freezes to shade', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    reserveSlot(ws, change, W);
    freeze(ws, { start_at: '2026-12-01T00:00:00.000Z', end_at: '2026-12-02T00:00:00.000Z' });

    const view = calendarView(ws, { from: '2026-11-30T00:00:00.000Z', to: '2026-12-03T00:00:00.000Z' });
    assert.equal(view.slots.length, 1);
    assert.equal(view.slots[0].number, change.number);
    assert.equal(view.freezes.length, 1);
  });
});

describe('changeTemplates: matching', () => {
  test('default templates seed once', () => {
    const ws = newWorkspace();
    const first = listTemplates(ws);
    assert.ok(first.length >= 3);
    assert.equal(listTemplates(ws).length, first.length);
  });

  test('matches on category plus subcategory, most specific winning', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { category: 'Hardware', subcategory: 'Laptop' });
    const matched = matchTemplate(ws, change);
    assert.ok(matched);
    assert.match(matched.name, /laptop/i);
  });

  test('subcategory is matched inside the multi-value list', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { category: 'Hardware', subcategory: 'Monitor, Laptop' });
    assert.match(matchTemplate(ws, change).name, /laptop/i);
  });

  test('a non-matching category yields no template, which is the Normal fallback', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { category: 'Facilities', subcategory: 'Power' });
    assert.equal(matchTemplate(ws, change), null);
  });

  test('a disabled template never matches', () => {
    const ws = newWorkspace();
    listTemplates(ws); // materialize the lazy defaults before disabling them
    db.prepare('UPDATE standard_change_templates SET enabled = 0 WHERE workspace_id = ?').run(ws);
    assert.equal(matchTemplate(ws, newChange(ws, { category: 'Hardware', subcategory: 'Laptop' })), null);
  });

  test('a title keyword narrows between two templates on the same category', () => {
    const ws = newWorkspace();
    db.prepare('DELETE FROM standard_change_templates WHERE workspace_id = ?').run(ws);
    db.prepare(
      'INSERT INTO standard_change_templates (id, workspace_id, name, match_category) VALUES (?,?,?,?)'
    ).run(uid('sct'), ws, 'Any software', 'Software');
    db.prepare(
      'INSERT INTO standard_change_templates (id, workspace_id, name, match_category, match_title_contains) VALUES (?,?,?,?,?)'
    ).run(uid('sct'), ws, 'Java upgrade', 'Software', 'java');

    assert.equal(matchTemplate(ws, newChange(ws, { category: 'Software', title: 'Upgrade Java runtime' })).name, 'Java upgrade');
    assert.equal(matchTemplate(ws, newChange(ws, { category: 'Software', title: 'Install Figma' })).name, 'Any software');
  });

  test('applying a template fills blank plans but never overwrites the requester', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { category: 'Hardware', subcategory: 'Laptop' });
    db.prepare('UPDATE tickets SET implementation_plan = ? WHERE id = ?').run('My own careful plan', change.id);
    const reloaded = db.prepare('SELECT * FROM tickets WHERE id = ?').get(change.id);

    const template = matchTemplate(ws, reloaded);
    const after = applyTemplate(ws, reloaded, template);

    assert.equal(after.implementation_plan, 'My own careful plan', 'the requester wins');
    assert.ok(after.rollback_plan, 'the blank backout plan is filled from the template');
    assert.equal(after.standard_template_id, template.id);

    const usage = db.prepare('SELECT usage_count FROM standard_change_templates WHERE id = ?').get(template.id);
    assert.equal(usage.usage_count, 1);
  });
});
