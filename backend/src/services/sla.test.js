import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { resolveConditions, computeSlaDueDate, findSlaPolicy } from './sla.js';

// Each test gets its own workspace row so sla_policies rows inserted by one
// test are never visible to another test's findSlaPolicy() query, even
// though every test in this file shares one SQLite connection/process (see
// test/setup.mjs -- each *file* gets its own throwaway database, but tests
// within a file are not otherwise isolated from each other).
function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

describe('sla: resolveConditions', () => {
  test('parses real stored JSON conditions when present', () => {
    const policy = { conditions: JSON.stringify({ logic: 'OR', rules: [{ field: 'priority', operator: 'equals', value: 'high' }] }) };
    assert.deepEqual(resolveConditions(policy), { logic: 'OR', rules: [{ field: 'priority', operator: 'equals', value: 'high' }] });
  });

  test('synthesizes an equivalent AND condition from legacy priority/category/team columns', () => {
    const policy = { conditions: null, priority: 'critical', category: 'Network', team: null };
    assert.deepEqual(resolveConditions(policy), {
      logic: 'AND',
      rules: [
        { field: 'priority', operator: 'equals', value: 'critical' },
        { field: 'category', operator: 'equals', value: 'Network' },
      ],
    });
  });

  test('a policy with no conditions and no legacy columns matches unconditionally (empty rule list)', () => {
    const policy = { conditions: null, priority: null, category: null, team: null };
    assert.deepEqual(resolveConditions(policy), { logic: 'AND', rules: [] });
  });

  test('falls back to legacy synthesis if the stored conditions column is corrupt JSON', () => {
    const policy = { conditions: 'not valid json{{{', priority: 'low', category: null, team: null };
    assert.deepEqual(resolveConditions(policy), { logic: 'AND', rules: [{ field: 'priority', operator: 'equals', value: 'low' }] });
  });
});

describe('sla: findSlaPolicy', () => {
  test('the first enabled policy (by sort_order) whose conditions match wins', () => {
    const workspaceId = newWorkspace();
    const insert = (id, sort_order, conditions, enabled = 1) => db.prepare(
      `INSERT INTO sla_policies (id, workspace_id, name, response_minutes, resolution_minutes, sort_order, enabled, conditions)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, workspaceId, id, 30, 240, sort_order, enabled, JSON.stringify(conditions));

    // Two policies would both match a critical incident -- sort_order picks the winner.
    insert('pol_generic', 10, { logic: 'AND', rules: [] });
    insert('pol_critical', 0, { logic: 'AND', rules: [{ field: 'priority', operator: 'equals', value: 'critical' }] });

    const match = findSlaPolicy({ workspaceId, priority: 'critical', category: 'Network' });
    assert.equal(match.id, 'pol_critical', 'the more specific, lower-sort_order policy wins over the catch-all');

    const fallback = findSlaPolicy({ workspaceId, priority: 'low', category: 'Network' });
    assert.equal(fallback.id, 'pol_generic', 'a non-matching specific policy falls through to the catch-all');
  });

  test('a disabled policy is never matched even if its conditions fit', () => {
    const workspaceId = newWorkspace();
    db.prepare(
      `INSERT INTO sla_policies (id, workspace_id, name, response_minutes, resolution_minutes, sort_order, enabled, conditions)
       VALUES (?,?,?,?,?,?,0,?)`
    ).run('pol_disabled', workspaceId, 'disabled', 30, 240, 0, JSON.stringify({ logic: 'AND', rules: [] }));
    assert.equal(findSlaPolicy({ workspaceId, priority: 'high' }), null);
  });

  test('returns null when nothing matches and there is no catch-all', () => {
    const workspaceId = newWorkspace();
    db.prepare(
      `INSERT INTO sla_policies (id, workspace_id, name, response_minutes, resolution_minutes, sort_order, enabled, conditions)
       VALUES (?,?,?,?,?,?,1,?)`
    ).run('pol_specific', workspaceId, 'specific', 30, 240, 0, JSON.stringify({ logic: 'AND', rules: [{ field: 'priority', operator: 'equals', value: 'critical' }] }));
    assert.equal(findSlaPolicy({ workspaceId, priority: 'low' }), null);
  });

  test('OR logic matches if any one rule matches', () => {
    const workspaceId = newWorkspace();
    db.prepare(
      `INSERT INTO sla_policies (id, workspace_id, name, response_minutes, resolution_minutes, sort_order, enabled, conditions)
       VALUES (?,?,?,?,?,?,1,?)`
    ).run('pol_or', workspaceId, 'or-policy', 30, 240, 0, JSON.stringify({
      logic: 'OR',
      rules: [{ field: 'priority', operator: 'equals', value: 'critical' }, { field: 'category', operator: 'equals', value: 'Security' }],
    }));
    assert.equal(findSlaPolicy({ workspaceId, priority: 'low', category: 'Security' })?.id, 'pol_or');
    assert.equal(findSlaPolicy({ workspaceId, priority: 'low', category: 'Network' }), null);
  });
});

// Computes the next occurrence of a given day-of-week (0=Sun..6=Sat) at a
// specific local time, relative to whenever the suite happens to run --
// deliberately not a hardcoded calendar date, so these tests never depend
// on which weekday a specific date fell on.
function atNextWeekday(targetDow, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() + ((targetDow - d.getDay() + 7) % 7));
  d.setHours(hour, minute, 0, 0);
  return d;
}
function daysAfter(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

describe('sla: computeSlaDueDate', () => {
  test('plain calendar time when businessHoursOnly is false', () => {
    const from = new Date('2026-09-14T10:00:00.000Z');
    const due = computeSlaDueDate(90, false, from);
    assert.equal(due, new Date('2026-09-14T11:30:00.000Z').toISOString());
  });

  test('business-hours math stays within the same day when there is enough time left', () => {
    const from = atNextWeekday(1, 14, 0); // a Monday, 2pm local
    const due = new Date(computeSlaDueDate(60, true, from, null)); // default calendar: Mon-Fri 9-5
    assert.equal(due.toDateString(), from.toDateString(), 'stays on the same calendar day');
    assert.equal(due.getHours(), 15);
  });

  test('business-hours math rolls over a non-business evening into the next business day', () => {
    const from = atNextWeekday(1, 16, 45); // Monday 4:45pm -- 15 business minutes left today
    const due = new Date(computeSlaDueDate(45, true, from, null)); // 15 today + 30 more tomorrow
    assert.equal(due.toDateString(), daysAfter(from, 1).toDateString(), 'rolls into the next calendar day');
    assert.equal(due.getDay(), 2, 'lands on Tuesday');
    assert.equal(due.getHours(), 9);
    assert.equal(due.getMinutes(), 30);
  });

  test('business-hours math skips a weekend entirely', () => {
    const from = atNextWeekday(5, 16, 30); // Friday 4:30pm -- 30 business minutes left today
    const due = new Date(computeSlaDueDate(90, true, from, null)); // 30 today + 60 needed on the next business day
    assert.equal(due.getDay(), 1, 'lands on Monday, not Saturday/Sunday');
    assert.equal(due.toDateString(), daysAfter(from, 3).toDateString(), 'three calendar days later (Sat, Sun, Mon)');
    assert.equal(due.getHours(), 10);
  });
});
