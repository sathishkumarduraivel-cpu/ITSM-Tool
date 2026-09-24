import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { getClass, ensureDefaultCiClasses, writeAttributes } from './ciClasses.js';
import { ensureDefaultRelationshipTypes, getRelationshipType } from './ciRelationshipTypes.js';
import {
  LIFECYCLE_STATES, allowedTransitions, lifecycleFor, transitionLifecycle,
  checkOut, checkIn, openAssignment, assignmentHistory, heldBy, lifecycleSummary,
} from './assetLifecycle.js';
import { depreciate, saveFinancials, getFinancials, portfolio, expiringSoon, DEPRECIATION_METHODS } from './assetFinancials.js';
import {
  createProduct, updateProduct, deleteProduct, addEntitlement, deleteEntitlement,
  recordInstallation, removeInstallation, listInstallations, positionFor, compliancePosition, LICENSING_METRICS,
} from './licenseCompliance.js';
import { healthReport, healthByClass } from './cmdbHealth.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  ensureDefaultCiClasses(id);
  ensureDefaultRelationshipTypes(id);
  return id;
}

function newUser(ws, name = 'Sam') {
  const id = uid('usr');
  // Users are global; workspace membership is a separate table.
  db.prepare('INSERT INTO users (id, name, email, password_hash, role) VALUES (?,?,?,?,?)')
    .run(id, name, `${id}@example.com`, 'x', 'agent');
  return id;
}

function newAsset(ws, { classKey = 'endpoint', name = 'Laptop', owner = null } = {}) {
  const cls = getClass(ws, classKey);
  const id = uid('ast');
  db.prepare('INSERT INTO assets (id, workspace_id, tag, name, class_id, type, owner_id) VALUES (?,?,?,?,?,?,?)')
    .run(id, ws, uid('TAG'), name, cls.id, 'hardware', owner);
  return id;
}

const iso = (d) => d.toISOString().slice(0, 10);
const daysFromNow = (n) => iso(new Date(Date.now() + n * 86400000));

// ============================================================ lifecycle ===

describe('asset lifecycle', () => {
  test('an asset starts in stock', () => {
    const ws = newWorkspace();
    assert.equal(lifecycleFor(ws, newAsset(ws)).state, 'in_stock');
  });

  test('legal moves are allowed and recorded', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    transitionLifecycle(ws, a, 'in_repair', { reason: 'Screen cracked' });
    const view = lifecycleFor(ws, a);
    assert.equal(view.state, 'in_repair');
    assert.equal(view.history[0].from_state, 'in_stock');
    assert.equal(view.history[0].reason, 'Screen cracked');
  });

  test('an illegal move is refused with a readable reason', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    assert.throws(() => transitionLifecycle(ws, a, 'disposed'),
      /cannot go from In stock to Disposed/);
  });

  test('disposed is the end of the line', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    transitionLifecycle(ws, a, 'retired');
    transitionLifecycle(ws, a, 'disposed');
    assert.deepEqual(allowedTransitions('disposed'), []);
    assert.throws(() => transitionLifecycle(ws, a, 'in_stock'), /cannot go from Disposed/);
  });

  test('moving to the same state is a no-op rather than an error', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    assert.equal(transitionLifecycle(ws, a, 'in_stock').unchanged, true);
  });

  test('an unknown state is refused', () => {
    const ws = newWorkspace();
    assert.throws(() => transitionLifecycle(ws, newAsset(ws), 'melted'), /Unknown lifecycle state/);
  });

  test('an asset still checked out cannot be quietly retired', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    checkOut(ws, a, { userId: newUser(ws) });
    assert.throws(() => transitionLifecycle(ws, a, 'retired'), /still checked out/);
  });

  test('the summary counts the estate across the lifecycle', () => {
    const ws = newWorkspace();
    newAsset(ws); newAsset(ws);
    transitionLifecycle(ws, newAsset(ws), 'in_repair');
    const summary = Object.fromEntries(lifecycleSummary(ws).map((s) => [s.key, s.count]));
    assert.equal(summary.in_stock, 2);
    assert.equal(summary.in_repair, 1);
    assert.equal(summary.disposed, 0, 'every state is listed, including the empty ones');
  });
});

describe('custody', () => {
  test('checking out records who has it and moves the lifecycle', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    const user = newUser(ws, 'Priya');
    checkOut(ws, a, { userId: user, condition: 'Good' });

    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(a);
    assert.equal(asset.owner_id, user);
    assert.equal(asset.lifecycle_state, 'assigned');
    assert.equal(openAssignment(a).user_id, user);
  });

  test('checking in closes the record and frees the asset', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    checkOut(ws, a, { userId: newUser(ws) });
    checkIn(ws, a, { condition: 'Scratched' });

    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(a);
    assert.equal(asset.owner_id, null);
    assert.equal(asset.lifecycle_state, 'in_stock');
    assert.equal(openAssignment(a), null);
    assert.equal(assignmentHistory(ws, a)[0].condition_in, 'Scratched');
  });

  test('checking in something that is not out is refused', () => {
    const ws = newWorkspace();
    assert.throws(() => checkIn(ws, newAsset(ws)), /not currently checked out/);
  });

  test('reissuing closes the previous holding instead of leaving two open', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    const first = newUser(ws, 'First');
    const second = newUser(ws, 'Second');
    checkOut(ws, a, { userId: first });
    const result = checkOut(ws, a, { userId: second });

    assert.equal(result.replaced, true);
    assert.equal(openAssignment(a).user_id, second);
    const open = db.prepare('SELECT COUNT(*) c FROM asset_assignments WHERE asset_id = ? AND returned_at IS NULL').get(a);
    assert.equal(open.c, 1, 'exactly one open holding at any time');
  });

  test('the full custody chain survives', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    const one = newUser(ws, 'One');
    const two = newUser(ws, 'Two');
    checkOut(ws, a, { userId: one });
    checkIn(ws, a);
    checkOut(ws, a, { userId: two });
    assert.equal(assignmentHistory(ws, a).length, 2);
  });

  test('an asset can be issued to a place rather than a person', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    checkOut(ws, a, { label: 'Meeting room 2' });
    assert.equal(openAssignment(a).assigned_to_label, 'Meeting room 2');
  });

  test('issuing to nobody at all is refused', () => {
    const ws = newWorkspace();
    assert.throws(() => checkOut(ws, newAsset(ws), {}), /who or where/);
  });

  test('a disposed asset cannot be issued', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    transitionLifecycle(ws, a, 'retired');
    transitionLifecycle(ws, a, 'disposed');
    assert.throws(() => checkOut(ws, a, { userId: newUser(ws) }), /disposed of/);
  });

  test('what a leaver is holding can be answered in one call', () => {
    const ws = newWorkspace();
    const user = newUser(ws, 'Leaver');
    const laptop = newAsset(ws, { name: 'Laptop' });
    const phone = newAsset(ws, { classKey: 'mobile_device', name: 'Phone' });
    const returned = newAsset(ws, { name: 'Old laptop' });
    checkOut(ws, laptop, { userId: user });
    checkOut(ws, phone, { userId: user });
    checkOut(ws, returned, { userId: user });
    checkIn(ws, returned);

    assert.deepEqual(heldBy(ws, user).map((a) => a.name).sort(), ['Laptop', 'Phone']);
  });
});

// =========================================================== financials ===

describe('depreciation', () => {
  const base = { purchase_cost: 1200, salvage_value: 0, useful_life_months: 36, depreciation_method: 'straight_line' };

  test('on day one nothing has depreciated', () => {
    const d = depreciate({ ...base, in_service_date: '2026-01-01' }, new Date('2026-01-01T00:00:00Z'));
    assert.equal(d.accumulated_depreciation, 0);
    assert.equal(d.book_value, 1200);
  });

  test('halfway through, half the value has gone', () => {
    const d = depreciate({ ...base, in_service_date: '2026-01-01' }, new Date('2027-07-01T00:00:00Z'));
    assert.equal(d.months_elapsed, 18);
    assert.equal(d.book_value, 600);
  });

  test('at the end it is fully depreciated, and stays there', () => {
    const end = depreciate({ ...base, in_service_date: '2026-01-01' }, new Date('2029-01-01T00:00:00Z'));
    assert.equal(end.book_value, 0);
    assert.equal(end.fully_depreciated, true);
    const later = depreciate({ ...base, in_service_date: '2026-01-01' }, new Date('2035-01-01T00:00:00Z'));
    assert.equal(later.book_value, 0, 'never goes negative');
    assert.equal(later.months_elapsed, 36, 'elapsed is capped at the life');
  });

  test('a salvage value is the floor, not zero', () => {
    const d = depreciate({ ...base, salvage_value: 200, in_service_date: '2026-01-01' }, new Date('2030-01-01T00:00:00Z'));
    assert.equal(d.book_value, 200);
  });

  test('a month only counts once its day has been reached', () => {
    const d = depreciate({ ...base, in_service_date: '2026-01-30' }, new Date('2026-03-01T00:00:00Z'));
    assert.equal(d.months_elapsed, 1, 'not 2 — the 30th has not come round again');
  });

  test('declining balance is heavier early and still respects the floor', () => {
    const straight = depreciate({ ...base, in_service_date: '2026-01-01' }, new Date('2026-07-01T00:00:00Z'));
    const declining = depreciate({ ...base, depreciation_method: 'declining_balance', in_service_date: '2026-01-01' }, new Date('2026-07-01T00:00:00Z'));
    assert.ok(declining.accumulated_depreciation > straight.accumulated_depreciation, 'front-loaded');
    const far = depreciate({ ...base, depreciation_method: 'declining_balance', salvage_value: 100, in_service_date: '2020-01-01' }, new Date('2030-01-01T00:00:00Z'));
    assert.equal(far.book_value, 100);
  });

  test('a non-depreciated asset is carried at cost', () => {
    const d = depreciate({ ...base, depreciation_method: 'none', in_service_date: '2020-01-01' });
    assert.equal(d.book_value, 1200);
    assert.equal(d.accumulated_depreciation, 0);
  });

  test('missing information yields an honest unknown, not a confident zero', () => {
    assert.equal(depreciate(null), null);
    assert.equal(depreciate({ purchase_cost: 0 }), null);
    const partial = depreciate({ purchase_cost: 500, in_service_date: '2026-01-01' });
    assert.equal(partial.book_value, 500);
    assert.deepEqual(partial.missing, ['useful_life_months']);
  });

  test('the in-service date drives it, not the purchase date', () => {
    const d = depreciate({ ...base, purchase_date: '2025-01-01', in_service_date: '2026-01-01' }, new Date('2026-07-01T00:00:00Z'));
    assert.equal(d.months_elapsed, 6);
  });

  test('the figure does not shift with the reader timezone', () => {
    // A zone-less SQLite datetime parsed as local time is the drift this
    // codebase has been bitten by before.
    const d = depreciate({ ...base, in_service_date: '2026-01-01 00:00:00' }, new Date('2026-07-01T00:00:00Z'));
    assert.equal(d.months_elapsed, 6);
  });
});

describe('financial records', () => {
  test('saving and reading back includes the computed depreciation', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    saveFinancials(ws, a, { purchase_cost: 900, useful_life_months: 36, in_service_date: '2026-01-01', cost_centre: 'IT' });
    const f = getFinancials(ws, a);
    assert.equal(f.purchase_cost, 900);
    assert.ok(f.depreciation.book_value <= 900);
  });

  test('nonsense values are refused', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    assert.throws(() => saveFinancials(ws, a, { purchase_cost: 'lots' }), /must be a number/);
    assert.throws(() => saveFinancials(ws, a, { purchase_cost: -5 }), /cannot be negative/);
    assert.throws(() => saveFinancials(ws, a, { useful_life_months: 2.5 }), /whole number of months/);
    assert.throws(() => saveFinancials(ws, a, { depreciation_method: 'vibes' }), /Unknown depreciation method/);
    assert.throws(() => saveFinancials(ws, a, { purchase_cost: 100, salvage_value: 500 }), /cannot be more than/);
  });

  test('an asset from another workspace cannot be costed', () => {
    const ws = newWorkspace();
    const other = newWorkspace();
    assert.throws(() => saveFinancials(ws, newAsset(other), { purchase_cost: 100 }), /Asset not found/);
  });

  test('the portfolio totals cost and book value, and counts the unvalued separately', () => {
    const ws = newWorkspace();
    const a = newAsset(ws); const b = newAsset(ws); const c = newAsset(ws);
    saveFinancials(ws, a, { purchase_cost: 1000, useful_life_months: 36, in_service_date: '2026-01-01', cost_centre: 'IT' });
    saveFinancials(ws, b, { purchase_cost: 500, useful_life_months: 36, in_service_date: '2026-01-01', cost_centre: 'Sales' });
    saveFinancials(ws, c, { cost_centre: 'IT' }); // costed by nobody

    const p = portfolio(ws, { asOf: new Date('2026-01-01T00:00:00Z') });
    assert.equal(p.totals.purchase_cost, 1500);
    assert.equal(p.totals.book_value, 1500);
    assert.equal(p.totals.unvalued, 1, 'not silently folded in as zero');
    assert.equal(p.by_cost_centre.find((c2) => c2.cost_centre === 'IT').count, 2);
  });

  test('an empty estate reports zeros rather than failing', () => {
    const ws = newWorkspace();
    assert.equal(portfolio(ws).totals.purchase_cost, 0);
  });
});

describe('expiry warnings', () => {
  test('warranties, contracts and licences expiring inside the horizon are listed', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    db.prepare('UPDATE assets SET warranty_expiry = ? WHERE id = ?').run(daysFromNow(30), a);
    db.prepare('INSERT INTO contracts (id, workspace_id, vendor, name, end_date) VALUES (?,?,?,?,?)')
      .run(uid('con'), ws, 'Dell', 'Support', daysFromNow(10));
    const product = createProduct(ws, { name: 'Widget', licensing_metric: 'per_device' });
    addEntitlement(ws, product.id, { quantity: 5, expiry_date: daysFromNow(45) });

    const soon = expiringSoon(ws, { days: 90 });
    assert.equal(soon.warranties.length, 1);
    assert.equal(soon.contracts.length, 1);
    assert.equal(soon.licences.length, 1);
  });

  test('things far in the future are not listed', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    db.prepare('UPDATE assets SET warranty_expiry = ? WHERE id = ?').run(daysFromNow(400), a);
    assert.equal(expiringSoon(ws, { days: 90 }).warranties.length, 0);
  });

  test('already-expired items are flagged as expired, not merely expiring', () => {
    const ws = newWorkspace();
    const a = newAsset(ws);
    db.prepare('UPDATE assets SET warranty_expiry = ? WHERE id = ?').run(daysFromNow(-10), a);
    assert.equal(expiringSoon(ws).warranties[0].expired, true);
  });
});

// =========================================================== licensing ===

describe('licence compliance', () => {
  const withProduct = (ws, metric) => createProduct(ws, { name: `Product ${metric}`, publisher: 'Acme', licensing_metric: metric });

  test('per-device counts distinct devices', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'per_device');
    addEntitlement(ws, p.id, { quantity: 2 });
    const d1 = newAsset(ws); const d2 = newAsset(ws); const d3 = newAsset(ws);
    for (const d of [d1, d2, d3]) recordInstallation(ws, p.id, { ci_id: d });

    const pos = positionFor(ws, p.id);
    assert.equal(pos.consumed, 3);
    assert.equal(pos.entitled, 2);
    assert.equal(pos.status, 'over_deployed');
    assert.equal(pos.shortfall, 1);
  });

  test('per-user counts people, not installations — the distinction most tools get wrong', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'per_user');
    addEntitlement(ws, p.id, { quantity: 2 });
    const user = newUser(ws, 'Multi-device');
    const laptop = newAsset(ws); const desktop = newAsset(ws);
    recordInstallation(ws, p.id, { ci_id: laptop, user_id: user });
    recordInstallation(ws, p.id, { ci_id: desktop, user_id: user });

    const pos = positionFor(ws, p.id);
    assert.equal(pos.consumed, 1, 'one person with two machines is one licence');
    assert.equal(pos.status, 'under_deployed');
    assert.equal(pos.spare, 1);
  });

  test('the same devices count differently under a different metric', () => {
    const ws = newWorkspace();
    const user = newUser(ws);
    const laptop = newAsset(ws); const desktop = newAsset(ws);

    const perUser = withProduct(ws, 'per_user');
    const perDevice = withProduct(ws, 'per_device');
    for (const p of [perUser, perDevice]) {
      recordInstallation(ws, p.id, { ci_id: laptop, user_id: user });
      recordInstallation(ws, p.id, { ci_id: desktop, user_id: user });
    }
    assert.equal(positionFor(ws, perUser.id).consumed, 1);
    assert.equal(positionFor(ws, perDevice.id).consumed, 2);
  });

  test('per-core reads the core count off the CI', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'per_core');
    addEntitlement(ws, p.id, { quantity: 16 });
    const srv = newAsset(ws, { classKey: 'server', name: 'srv-1' });
    writeAttributes(ws, srv, getClass(ws, 'server').id, { cpu_cores: 24 }, { partial: true });
    recordInstallation(ws, p.id, { ci_id: srv });

    const pos = positionFor(ws, p.id);
    assert.equal(pos.consumed, 24);
    assert.equal(pos.shortfall, 8);
  });

  test('a device with no core count is surfaced rather than counted as zero', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'per_core');
    const srv = newAsset(ws, { classKey: 'server' });
    recordInstallation(ws, p.id, { ci_id: srv });
    const pos = positionFor(ws, p.id);
    assert.ok(pos.caveats.some((c) => /do not report a core count/.test(c)), JSON.stringify(pos.caveats));
  });

  test('per-socket counts hosts, not guests', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'per_socket');
    const host = newAsset(ws, { classKey: 'server' });
    recordInstallation(ws, p.id, { ci_id: host });
    assert.equal(positionFor(ws, p.id).consumed, 1);
  });

  test('free products never count against anything', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'free');
    for (let i = 0; i < 5; i += 1) recordInstallation(ws, p.id, { ci_id: newAsset(ws) });
    const pos = positionFor(ws, p.id);
    assert.equal(pos.consumed, 0);
    assert.equal(pos.status, 'not_applicable');
  });

  test('an expired entitlement stops counting, and says so', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'per_device');
    addEntitlement(ws, p.id, { quantity: 10, expiry_date: daysFromNow(-1) });
    addEntitlement(ws, p.id, { quantity: 2 });
    recordInstallation(ws, p.id, { ci_id: newAsset(ws) });

    const pos = positionFor(ws, p.id);
    assert.equal(pos.entitled, 2, 'the lapsed 10 do not count');
    assert.equal(pos.expired_entitlements, 10);
    assert.ok(pos.caveats.some((c) => /expired licence/.test(c)));
  });

  test('no entitlements at all means everything installed is a shortfall, stated plainly', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'per_device');
    recordInstallation(ws, p.id, { ci_id: newAsset(ws) });
    const pos = positionFor(ws, p.id);
    assert.equal(pos.status, 'over_deployed');
    assert.ok(pos.caveats.some((c) => /No entitlements recorded/.test(c)));
  });

  test('exactly matching is reported as exact, not as a shortfall or a surplus', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'per_device');
    addEntitlement(ws, p.id, { quantity: 1 });
    recordInstallation(ws, p.id, { ci_id: newAsset(ws) });
    assert.equal(positionFor(ws, p.id).status, 'exact');
  });

  test('recording the same installation twice does not double count', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'per_device');
    const device = newAsset(ws);
    recordInstallation(ws, p.id, { ci_id: device, version: '1.0' });
    recordInstallation(ws, p.id, { ci_id: device, version: '2.0' });
    assert.equal(listInstallations(ws, p.id).length, 1);
    assert.equal(listInstallations(ws, p.id)[0].version, '2.0', 'the newer report wins');
  });

  test('removing a device removes its installations with it', () => {
    const ws = newWorkspace();
    const p = withProduct(ws, 'per_device');
    const device = newAsset(ws);
    recordInstallation(ws, p.id, { ci_id: device });
    db.prepare('DELETE FROM assets WHERE id = ?').run(device);
    assert.equal(listInstallations(ws, p.id).length, 0);
  });

  test('the estate position ranks the worst shortfall first', () => {
    const ws = newWorkspace();
    const bad = createProduct(ws, { name: 'Very over', licensing_metric: 'per_device' });
    const mild = createProduct(ws, { name: 'Slightly over', licensing_metric: 'per_device' });
    addEntitlement(ws, mild.id, { quantity: 1 });
    for (let i = 0; i < 5; i += 1) recordInstallation(ws, bad.id, { ci_id: newAsset(ws) });
    for (let i = 0; i < 2; i += 1) recordInstallation(ws, mild.id, { ci_id: newAsset(ws) });

    const report = compliancePosition(ws);
    assert.equal(report.products[0].product.name, 'Very over');
    assert.equal(report.summary.over_deployed, 2);
    assert.equal(report.summary.total_shortfall, 6);
  });

  test('licence cost is totalled from the entitlements', () => {
    const ws = newWorkspace();
    const p = createProduct(ws, { name: 'Costed', licensing_metric: 'per_device' });
    addEntitlement(ws, p.id, { quantity: 10, unit_cost: 25 });
    assert.equal(positionFor(ws, p.id).total_cost, 250);
  });

  test('products are validated and deduplicated', () => {
    const ws = newWorkspace();
    createProduct(ws, { name: 'Office', edition: 'E3' });
    assert.throws(() => createProduct(ws, { name: 'Office', edition: 'E3' }), /already tracked/);
    assert.doesNotThrow(() => createProduct(ws, { name: 'Office', edition: 'E5' }), 'a different edition is a different product');
    assert.throws(() => createProduct(ws, { name: 'Bad', licensing_metric: 'vibes' }), /Unknown licensing metric/);
    assert.throws(() => createProduct(ws, {}), /name is required/);
  });

  test('an installation needs something to attach to', () => {
    const ws = newWorkspace();
    const p = createProduct(ws, { name: 'Widget' });
    assert.throws(() => recordInstallation(ws, p.id, {}), /needs a device, a user/);
  });

  test('every metric the UI offers is actually implemented', () => {
    const ws = newWorkspace();
    for (const metric of LICENSING_METRICS) {
      const p = createProduct(ws, { name: `M ${metric.key}`, licensing_metric: metric.key });
      recordInstallation(ws, p.id, { ci_id: newAsset(ws) });
      const pos = positionFor(ws, p.id);
      assert.ok(Number.isFinite(pos.consumed), `${metric.key} produced ${pos.consumed}`);
      assert.ok(pos.basis, `${metric.key} has no explanation of how it counted`);
    }
  });
});

// ============================================================== health ===

describe('CMDB health', () => {
  test('an empty CMDB says so rather than scoring 100%', () => {
    const ws = newWorkspace();
    const report = healthReport(ws);
    assert.equal(report.score, null);
    assert.match(report.message, /nothing to score/);
  });

  test('a CI missing a required field fails completeness, and is named', () => {
    const ws = newWorkspace();
    const srv = newAsset(ws, { classKey: 'server', name: 'app-01' }); // hostname is required
    const report = healthReport(ws);
    const completeness = report.dimensions.find((d) => d.key === 'completeness');
    assert.equal(completeness.failing, 1);
    assert.equal(completeness.items[0].id, srv);
    assert.ok(completeness.items[0].missing.includes('Hostname'));
  });

  test('filling the field fixes the score', () => {
    const ws = newWorkspace();
    const srv = newAsset(ws, { classKey: 'server' });
    writeAttributes(ws, srv, getClass(ws, 'server').id, { hostname: 'app-01' }, { partial: true });
    assert.equal(healthReport(ws).dimensions.find((d) => d.key === 'completeness').failing, 0);
  });

  test('an unconnected CI fails the relationships dimension', () => {
    const ws = newWorkspace();
    const lonely = newAsset(ws);
    assert.equal(healthReport(ws).dimensions.find((d) => d.key === 'relationships').items[0].id, lonely);
  });

  test('a relationship in either direction counts as connected', () => {
    const ws = newWorkspace();
    const a = newAsset(ws); const b = newAsset(ws);
    const type = getRelationshipType(ws, 'depends_on');
    db.prepare('INSERT INTO asset_relationships (id, asset_id, related_asset_id, relationship_type, type_id) VALUES (?,?,?,?,?)')
      .run(uid('rel'), a, b, 'depends_on', type.id);
    assert.equal(healthReport(ws).dimensions.find((d) => d.key === 'relationships').failing, 0);
  });

  test('an unowned CI fails ownership', () => {
    const ws = newWorkspace();
    newAsset(ws, { owner: null });
    newAsset(ws, { owner: newUser(ws) });
    assert.equal(healthReport(ws).dimensions.find((d) => d.key === 'ownership').failing, 1);
  });

  test('only CIs discovery has actually seen are judged on staleness', () => {
    const ws = newWorkspace();
    newAsset(ws); // hand-entered, never seen by discovery
    assert.equal(healthReport(ws).dimensions.find((d) => d.key === 'freshness').failing, 0,
      'a CI with no last-seen date is not stale — it was never discovered in the first place');

    const seen = newAsset(ws, { classKey: 'server' });
    writeAttributes(ws, seen, getClass(ws, 'server').id, { last_seen_at: '2020-01-01 00:00:00' }, { partial: true });
    assert.equal(healthReport(ws).dimensions.find((d) => d.key === 'freshness').failing, 1);
  });

  test('a recently seen CI is fresh', () => {
    const ws = newWorkspace();
    const srv = newAsset(ws, { classKey: 'server' });
    writeAttributes(ws, srv, getClass(ws, 'server').id, { last_seen_at: new Date().toISOString() }, { partial: true });
    assert.equal(healthReport(ws).dimensions.find((d) => d.key === 'freshness').failing, 0);
  });

  test('every dimension says what to do about it', () => {
    const ws = newWorkspace();
    newAsset(ws);
    for (const dim of healthReport(ws).dimensions) {
      assert.ok(dim.fix, `${dim.key} has no suggested fix`);
      assert.ok(dim.question, `${dim.key} does not say what it measures`);
    }
  });

  test('the headline names the weakest dimension', () => {
    const ws = newWorkspace();
    newAsset(ws);
    assert.match(healthReport(ws).headline, /fail on/);
  });

  test('a perfect estate says so', () => {
    const ws = newWorkspace();
    const a = newAsset(ws, { owner: newUser(ws) });
    const b = newAsset(ws, { owner: newUser(ws) });
    const type = getRelationshipType(ws, 'depends_on');
    db.prepare('INSERT INTO asset_relationships (id, asset_id, related_asset_id, relationship_type, type_id) VALUES (?,?,?,?,?)')
      .run(uid('rel'), a, b, 'depends_on', type.id);
    const report = healthReport(ws);
    assert.equal(report.score, 100);
    assert.equal(report.grade, 'good');
    assert.match(report.headline, /pass every check/);
  });

  test('unclassified CIs are reported separately, not scored as failures', () => {
    const ws = newWorkspace();
    const id = uid('ast');
    db.prepare('INSERT INTO assets (id, workspace_id, tag, name, type) VALUES (?,?,?,?,?)')
      .run(id, ws, 'OLD-1', 'Legacy', 'hardware');
    const report = healthReport(ws);
    assert.equal(report.unclassified.count, 1);
    assert.equal(report.dimensions.find((d) => d.key === 'completeness').failing, 0,
      'a CI with no class has no required fields to be missing');
  });

  test('the per-class breakdown puts the worst class first', () => {
    const ws = newWorkspace();
    const owner = newUser(ws);
    // A healthy-ish printer and a broken server.
    newAsset(ws, { classKey: 'printer', owner });
    newAsset(ws, { classKey: 'server' });
    const rows = healthByClass(ws);
    assert.ok(rows.length >= 2);
    assert.ok(rows[0].score <= rows[rows.length - 1].score);
  });

  test('health never leaks across workspaces', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    newAsset(a);
    assert.equal(healthReport(b).scanned, 0);
  });
});
