import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  BenchmarkError, KPIS, benchmarkMeta, targetFor, listTargets, setTarget, deleteTarget,
  measure, scorecard,
} from './benchmarks.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'T ' + id, id);
  return id;
}
const user = { id: 'usr_test', role: 'admin' };

let seq = 0;
const COLUMNS = ['type', 'title', 'status', 'priority', 'created_at', 'responded_at', 'resolved_at',
  'sla_due_at', 'reopened_count', 'change_type', 'change_state', 'deleted_at'];
function newTicket(ws, over = {}) {
  const id = uid('tkt');
  seq += 1;
  const t = { type: 'incident', title: 'X', status: 'open', priority: 'medium', created_at: '2026-06-15 10:00:00', ...over };
  for (const k of Object.keys(over)) if (!COLUMNS.includes(k)) throw new Error(`helper cannot set ${k}`);
  const cols = COLUMNS.filter((c) => t[c] !== undefined);
  db.prepare(`INSERT INTO tickets (id, workspace_id, number, ${cols.join(', ')}) VALUES (?,?,?,${cols.map(() => '?').join(',')})`)
    .run(id, ws, `T-${8000 + seq}`, ...cols.map((c) => t[c]));
  return id;
}
const JUNE = { from: '2026-06-01', to: '2026-06-30' };

describe('the KPI catalogue', () => {
  test('every KPI states its calculation and its denominator', () => {
    // §19 asks for benchmarks reported with denominator definitions, because
    // most arguments about a number are arguments about what was counted.
    for (const [key, k] of Object.entries(KPIS)) {
      assert.ok(k.calculation, `${key} has no calculation`);
      assert.ok(k.denominator, `${key} has no denominator definition`);
      assert.ok(['percent', 'minutes'].includes(k.unit), `${key} has an odd unit`);
      assert.ok(['gte', 'lte'].includes(k.comparator), `${key} has no direction`);
    }
  });

  test('every KPI in the catalogue can actually be measured', () => {
    const ws = newWorkspace();
    for (const kpi of Object.keys(KPIS)) {
      assert.doesNotThrow(() => measure(ws, kpi, JUNE), `${kpi} is offered but cannot be measured`);
    }
  });

  test('the metadata matches what the service accepts', () => {
    const meta = benchmarkMeta();
    assert.equal(meta.kpis.length, Object.keys(KPIS).length);
    for (const k of meta.kpis) {
      assert.doesNotThrow(() => setTarget(newWorkspace(), user, { kpi: k.key, target_value: 1, effective_from: '2026-01-01' }));
    }
  });

  test('an unknown KPI is refused', () => {
    assert.throws(() => measure(newWorkspace(), 'vibes', JUNE), /Unknown KPI/);
    assert.throws(() => setTarget(newWorkspace(), user, { kpi: 'vibes', target_value: 1 }), /Unknown KPI/);
  });
});

describe('target versioning', () => {
  test('with nothing configured the specification default is used, and says so', () => {
    // A report must never silently invent a target the customer never agreed.
    const ws = newWorkspace();
    const t = targetFor(ws, 'incident_sla_compliance');
    assert.equal(t.target_value, KPIS.incident_sla_compliance.starting);
    assert.equal(t.is_default, true);
    assert.match(t.note, /not a target this workspace has agreed/i);
  });

  test('a target applies from its start date onwards', () => {
    const ws = newWorkspace();
    setTarget(ws, user, { kpi: 'reopen_rate', target_value: 5, effective_from: '2026-06-01' });
    assert.equal(targetFor(ws, 'reopen_rate', '2026-06-15').target_value, 5);
    assert.equal(targetFor(ws, 'reopen_rate', '2026-06-01').target_value, 5);
    // Before it existed, the default still applies.
    assert.equal(targetFor(ws, 'reopen_rate', '2026-05-31').is_default, true);
  });

  test('a newer target closes the old one rather than overlapping it', () => {
    // Every date must have exactly one answer to "what were we aiming at".
    const ws = newWorkspace();
    setTarget(ws, user, { kpi: 'reopen_rate', target_value: 10, effective_from: '2026-01-01' });
    setTarget(ws, user, { kpi: 'reopen_rate', target_value: 5, effective_from: '2026-04-01' });

    const history = listTargets(ws, 'reopen_rate');
    assert.equal(history.length, 2);
    const older = history.find((h) => h.target_value === 10);
    assert.equal(older.effective_to, '2026-03-31', 'the old one closes the day before the new one starts');

    assert.equal(targetFor(ws, 'reopen_rate', '2026-03-31').target_value, 10);
    assert.equal(targetFor(ws, 'reopen_rate', '2026-04-01').target_value, 5);
  });

  test('setting a target on a date that already has one replaces it', () => {
    const ws = newWorkspace();
    setTarget(ws, user, { kpi: 'reopen_rate', target_value: 10, effective_from: '2026-04-01' });
    setTarget(ws, user, { kpi: 'reopen_rate', target_value: 8, effective_from: '2026-04-01' });
    const history = listTargets(ws, 'reopen_rate');
    assert.equal(history.length, 1);
    assert.equal(history[0].target_value, 8);
  });

  test('removing a target brings the previous one back into force', () => {
    const ws = newWorkspace();
    setTarget(ws, user, { kpi: 'reopen_rate', target_value: 10, effective_from: '2026-01-01' });
    setTarget(ws, user, { kpi: 'reopen_rate', target_value: 5, effective_from: '2026-04-01' });
    const newer = listTargets(ws, 'reopen_rate').find((t) => t.target_value === 5);
    deleteTarget(ws, newer.id);
    // The older one reopens, so the timeline has no hole in it.
    assert.equal(targetFor(ws, 'reopen_rate', '2026-06-01').target_value, 10);
    assert.equal(listTargets(ws, 'reopen_rate')[0].effective_to, null);
  });

  test('a percentage target has to be a percentage', () => {
    const ws = newWorkspace();
    assert.throws(() => setTarget(ws, user, { kpi: 'reopen_rate', target_value: 150 }), /between 0 and 100/);
    assert.throws(() => setTarget(ws, user, { kpi: 'reopen_rate', target_value: -5 }), /between 0 and 100/);
    assert.throws(() => setTarget(ws, user, { kpi: 'reopen_rate', target_value: 'lots' }), /as a number/);
  });

  test('a minutes target may exceed 100 but not go negative', () => {
    const ws = newWorkspace();
    assert.doesNotThrow(() => setTarget(ws, user, { kpi: 'mttr_minutes', target_value: 720 }));
    assert.throws(() => setTarget(ws, user, { kpi: 'mttr_minutes', target_value: -1 }), /cannot be negative/);
  });

  test('a malformed date is refused', () => {
    const ws = newWorkspace();
    assert.throws(() => setTarget(ws, user, { kpi: 'reopen_rate', target_value: 5, effective_from: 'April' }), /YYYY-MM-DD/);
  });

  test('one workspace never sees another targets', () => {
    const a = newWorkspace(); const b = newWorkspace();
    setTarget(a, user, { kpi: 'reopen_rate', target_value: 1, effective_from: '2026-01-01' });
    assert.equal(targetFor(a, 'reopen_rate', '2026-06-01').target_value, 1);
    assert.equal(targetFor(b, 'reopen_rate', '2026-06-01').is_default, true);
  });
});

describe('measuring against the target that was in force', () => {
  test('a period is judged by what the desk was aiming at THEN, not now', () => {
    // This is the whole point of versioning. Two resolved tickets, one
    // reopened, is a 50% reopen rate: against the old 60% target that passes,
    // against the new 10% target it fails. Measuring March against April's
    // target would be the wrong comparison.
    const ws = newWorkspace();
    newTicket(ws, { status: 'resolved', created_at: '2026-03-10 10:00:00', resolved_at: '2026-03-11 10:00:00' });
    newTicket(ws, { status: 'resolved', created_at: '2026-03-12 10:00:00', resolved_at: '2026-03-13 10:00:00', reopened_count: 1 });

    setTarget(ws, user, { kpi: 'reopen_rate', target_value: 60, effective_from: '2026-01-01' });
    setTarget(ws, user, { kpi: 'reopen_rate', target_value: 10, effective_from: '2026-04-01' });

    const march = measure(ws, 'reopen_rate', { from: '2026-03-01', to: '2026-03-31' });
    assert.equal(march.value, 50);
    assert.equal(march.target, 60, 'March is judged against the March target');
    assert.equal(march.met, true);
    assert.equal(march.target_effective_from, '2026-01-01');
  });

  test('the same data against a later target reads differently', () => {
    const ws = newWorkspace();
    newTicket(ws, { status: 'resolved', created_at: '2026-05-10 10:00:00', resolved_at: '2026-05-11 10:00:00' });
    newTicket(ws, { status: 'resolved', created_at: '2026-05-12 10:00:00', resolved_at: '2026-05-13 10:00:00', reopened_count: 1 });
    setTarget(ws, user, { kpi: 'reopen_rate', target_value: 10, effective_from: '2026-04-01' });
    const may = measure(ws, 'reopen_rate', { from: '2026-05-01', to: '2026-05-31' });
    assert.equal(may.value, 50);
    assert.equal(may.target, 10);
    assert.equal(may.met, false, 'the same 50% now misses');
  });

  test('a lower-is-better KPI is judged in the right direction', () => {
    const ws = newWorkspace();
    newTicket(ws, { status: 'resolved', created_at: '2026-06-10 10:00:00', resolved_at: '2026-06-10 10:30:00' });
    setTarget(ws, user, { kpi: 'mttr_minutes', target_value: 60, effective_from: '2026-01-01' });
    const m = measure(ws, 'mttr_minutes', JUNE);
    assert.equal(m.comparator, 'lte');
    assert.equal(m.value, 30);
    assert.equal(m.met, true, '30 minutes against a 60-minute ceiling passes');
  });

  test('every figure carries the numbers it was computed from', () => {
    const ws = newWorkspace();
    newTicket(ws, { status: 'resolved', created_at: '2026-06-10 10:00:00', resolved_at: '2026-06-11 10:00:00' });
    newTicket(ws, { status: 'resolved', created_at: '2026-06-12 10:00:00', resolved_at: '2026-06-13 10:00:00', reopened_count: 1 });
    const m = measure(ws, 'reopen_rate', JUNE);
    assert.equal(m.numerator, 1);
    assert.equal(m.denominator, 2);
    assert.ok(m.denominator_definition);
    assert.ok(m.calculation);
  });

  test('a figure computed from almost nothing is flagged rather than trusted', () => {
    const ws = newWorkspace();
    newTicket(ws, { status: 'resolved', created_at: '2026-06-10 10:00:00', resolved_at: '2026-06-11 10:00:00' });
    const m = measure(ws, 'reopen_rate', JUNE);
    assert.equal(m.value, 0);
    assert.equal(m.low_confidence, true, 'one ticket is not evidence, and a green light would imply it was');
  });

  test('with nothing to measure the value is unknown, not zero', () => {
    const ws = newWorkspace();
    const m = measure(ws, 'reopen_rate', JUNE);
    assert.equal(m.value, null);
    assert.equal(m.met, null, 'unknown is neither met nor missed');
    assert.equal(m.denominator, 0);
  });

  test('SLA compliance counts only tickets that had a target', () => {
    const ws = newWorkspace();
    // Met, missed, and one with no target at all.
    newTicket(ws, { status: 'resolved', created_at: '2026-06-01 10:00:00', resolved_at: '2026-06-01 11:00:00', sla_due_at: '2026-06-01 12:00:00' });
    newTicket(ws, { status: 'resolved', created_at: '2026-06-02 10:00:00', resolved_at: '2026-06-02 14:00:00', sla_due_at: '2026-06-02 12:00:00' });
    newTicket(ws, { status: 'resolved', created_at: '2026-06-03 10:00:00', resolved_at: '2026-06-03 11:00:00' });
    const m = measure(ws, 'incident_sla_compliance', JUNE);
    assert.equal(m.denominator, 2, 'the untargeted ticket is not applicable, not a pass');
    assert.equal(m.value, 50);
  });

  test('emergency change rate counts every change raised', () => {
    const ws = newWorkspace();
    newTicket(ws, { type: 'change', change_type: 'emergency', created_at: '2026-06-01 10:00:00' });
    newTicket(ws, { type: 'change', change_type: 'normal', created_at: '2026-06-02 10:00:00' });
    newTicket(ws, { type: 'change', change_type: 'standard', created_at: '2026-06-03 10:00:00' });
    newTicket(ws, { type: 'change', change_type: 'normal', created_at: '2026-06-04 10:00:00' });
    const m = measure(ws, 'emergency_change_rate', JUNE);
    assert.equal(m.value, 25);
    assert.equal(m.comparator, 'lte');
  });

  test('a deleted ticket is not counted', () => {
    const ws = newWorkspace();
    newTicket(ws, { status: 'resolved', created_at: '2026-06-10 10:00:00', resolved_at: '2026-06-11 10:00:00' });
    newTicket(ws, { status: 'resolved', created_at: '2026-06-10 10:00:00', resolved_at: '2026-06-11 10:00:00', reopened_count: 1, deleted_at: '2026-06-12 10:00:00' });
    assert.equal(measure(ws, 'reopen_rate', JUNE).denominator, 1);
  });

  test('the scorecard reports every KPI at once', () => {
    const ws = newWorkspace();
    const all = scorecard(ws, JUNE);
    assert.equal(all.length, Object.keys(KPIS).length);
    for (const row of all) {
      assert.ok(row.label && row.calculation && row.denominator_definition);
      assert.ok('target' in row && 'met' in row);
    }
  });

  test('one workspace figures never include another', () => {
    const a = newWorkspace(); const b = newWorkspace();
    for (let i = 0; i < 4; i++) newTicket(b, { status: 'resolved', created_at: '2026-06-10 10:00:00', resolved_at: '2026-06-11 10:00:00' });
    assert.equal(measure(a, 'reopen_rate', JUNE).denominator, 0);
  });
});
