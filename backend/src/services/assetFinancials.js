// What assets cost, what they are worth now, and what the estate is worth in
// total.
//
// Depreciation is computed at read time from the purchase facts rather than
// stored and ticked forward by a job. Book value is a pure function of
// (cost, in-service date, useful life, salvage, today) -- storing it would
// mean a nightly job whose only purpose is to make a number that was already
// derivable go stale more slowly. That is the same reasoning escalationEngine
// and the SLA clock already follow in this codebase.
import { db, uid } from '../db.js';
import { ConfigError } from './ciClasses.js';

export const DEPRECIATION_METHODS = [
  { key: 'straight_line', label: 'Straight line', hint: 'Equal amount written off every month. The default, and what most finance teams expect.' },
  { key: 'declining_balance', label: 'Declining balance', hint: 'Double-declining: heavier in the early years, closer to how kit actually loses value.' },
  { key: 'none', label: 'Not depreciated', hint: 'Carried at cost. For leases and things expensed outright.' },
];

const MS_PER_DAY = 86400000;

// SQLite writes 'YYYY-MM-DD HH:MM:SS' with no zone marker, which JS parses as
// LOCAL time -- the drift that bit this codebase before. Dates here are
// treated as plain calendar dates at UTC midnight so a depreciation figure
// does not change with the reader's timezone.
function toDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  const datePart = s.slice(0, 10);
  const ms = Date.parse(`${datePart}T00:00:00Z`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

function monthsBetween(from, to) {
  if (!from || !to) return 0;
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  // Only count a month once its day-of-month has been reached, so an asset
  // bought on the 30th is not depreciated a whole month on the 1st.
  return Math.max(0, to.getUTCDate() >= from.getUTCDate() ? months : months - 1);
}

/**
 * Book value and accumulated depreciation as at a given date.
 *
 * Returns null when there is not enough information to compute anything --
 * an honest "unknown" rather than a confident zero, because a fleet reported
 * as worth nothing is worse than one reported as unvalued.
 */
export function depreciate(financials, asOf = new Date()) {
  if (!financials) return null;
  const cost = Number(financials.purchase_cost);
  if (!Number.isFinite(cost) || cost <= 0) return null;

  const method = financials.depreciation_method || 'straight_line';
  const salvage = Math.max(0, Number(financials.salvage_value) || 0);
  const start = toDate(financials.in_service_date || financials.purchase_date);
  const life = Number(financials.useful_life_months);

  if (method === 'none' || !start || !Number.isFinite(life) || life <= 0) {
    return {
      method, purchase_cost: cost, salvage_value: salvage,
      months_elapsed: start ? monthsBetween(start, asOf) : 0,
      useful_life_months: Number.isFinite(life) && life > 0 ? life : null,
      accumulated_depreciation: 0,
      book_value: cost,
      fully_depreciated: false,
      depreciable: method !== 'none' && (!start || !(life > 0)) ? false : method !== 'none',
      // Say why, so the UI can prompt for the missing field rather than just
      // showing the purchase price and hoping.
      missing: [
        ...(start ? [] : ['in_service_date']),
        ...(Number.isFinite(life) && life > 0 ? [] : ['useful_life_months']),
      ],
    };
  }

  const elapsed = Math.min(life, monthsBetween(start, asOf));
  const depreciable = Math.max(0, cost - salvage);

  let accumulated;
  if (method === 'declining_balance') {
    // Double-declining WITH the standard switch to straight line. Pure
    // declining balance approaches the salvage value asymptotically and never
    // reaches it, so an asset would still be carrying value years after its
    // useful life ended -- which is not what a finance team means by a
    // three-year laptop. Taking whichever charge is larger each month is the
    // textbook treatment and lands exactly on the salvage value at end of life.
    const rate = 2 / life;
    let value = cost;
    for (let m = 0; m < elapsed; m += 1) {
      const remaining = value - salvage;
      if (remaining <= 0) { value = salvage; break; }
      const monthsLeft = life - m;
      const charge = Math.max(remaining * rate, remaining / monthsLeft);
      value -= Math.min(charge, remaining);
      if (value <= salvage) { value = salvage; break; }
    }
    accumulated = cost - value;
  } else {
    accumulated = depreciable * (elapsed / life);
  }

  const bookValue = Math.max(salvage, cost - accumulated);
  const round2 = (n) => Math.round(n * 100) / 100;

  return {
    method,
    purchase_cost: round2(cost),
    salvage_value: round2(salvage),
    useful_life_months: life,
    months_elapsed: elapsed,
    months_remaining: Math.max(0, life - elapsed),
    accumulated_depreciation: round2(cost - bookValue),
    book_value: round2(bookValue),
    monthly_depreciation: round2(depreciable / life),
    fully_depreciated: elapsed >= life,
    depreciable: true,
    missing: [],
  };
}

export function getFinancials(workspaceId, assetId) {
  const row = db.prepare('SELECT * FROM asset_financials WHERE asset_id = ? AND workspace_id = ?').get(assetId, workspaceId);
  if (!row) return null;
  return { ...row, depreciation: depreciate(row) };
}

const FIELDS = [
  'purchase_cost', 'currency', 'purchase_date', 'in_service_date', 'useful_life_months',
  'salvage_value', 'depreciation_method', 'cost_centre', 'budget_code', 'supplier',
  'invoice_number', 'contract_id', 'purchase_order_id', 'annual_support_cost',
  'disposal_date', 'disposal_value', 'disposal_method',
];

export function saveFinancials(workspaceId, assetId, body) {
  const asset = db.prepare('SELECT id FROM assets WHERE id = ? AND workspace_id = ?').get(assetId, workspaceId);
  if (!asset) throw new ConfigError('Asset not found', 404);

  if (body.depreciation_method && !DEPRECIATION_METHODS.some((m) => m.key === body.depreciation_method)) {
    throw new ConfigError(`Unknown depreciation method: ${body.depreciation_method}`);
  }
  for (const numeric of ['purchase_cost', 'salvage_value', 'annual_support_cost', 'disposal_value']) {
    if (body[numeric] === undefined || body[numeric] === null || body[numeric] === '') continue;
    if (!Number.isFinite(Number(body[numeric]))) throw new ConfigError(`${numeric.replace(/_/g, ' ')} must be a number`);
    if (Number(body[numeric]) < 0) throw new ConfigError(`${numeric.replace(/_/g, ' ')} cannot be negative`);
  }
  if (body.useful_life_months !== undefined && body.useful_life_months !== null && body.useful_life_months !== '') {
    const n = Number(body.useful_life_months);
    if (!Number.isInteger(n) || n <= 0) throw new ConfigError('Useful life must be a whole number of months');
  }
  if (body.salvage_value !== undefined && body.purchase_cost !== undefined
      && Number(body.salvage_value) > Number(body.purchase_cost)) {
    throw new ConfigError('Salvage value cannot be more than the purchase cost');
  }
  if (body.contract_id && !db.prepare('SELECT id FROM contracts WHERE id = ? AND workspace_id = ?').get(body.contract_id, workspaceId)) {
    throw new ConfigError('Contract not found', 404);
  }
  if (body.purchase_order_id && !db.prepare('SELECT id FROM purchase_orders WHERE id = ? AND workspace_id = ?').get(body.purchase_order_id, workspaceId)) {
    throw new ConfigError('Purchase order not found', 404);
  }

  const existing = db.prepare('SELECT asset_id FROM asset_financials WHERE asset_id = ?').get(assetId);
  if (!existing) {
    db.prepare('INSERT INTO asset_financials (asset_id, workspace_id) VALUES (?,?)').run(assetId, workspaceId);
  }

  const sets = []; const params = [];
  for (const field of FIELDS) {
    if (body[field] === undefined) continue;
    let v = body[field];
    if (v === '') v = null;
    sets.push(`${field} = ?`); params.push(v);
  }
  if (sets.length) {
    sets.push("updated_at = datetime('now')");
    params.push(assetId);
    db.prepare(`UPDATE asset_financials SET ${sets.join(', ')} WHERE asset_id = ?`).run(...params);
  }
  return getFinancials(workspaceId, assetId);
}

/**
 * The estate's financial position.
 *
 * Grouped by CI class and by cost centre, because those are the two cuts
 * anyone actually asks for: "what are we carrying in laptops" and "what does
 * this department own".
 */
export function portfolio(workspaceId, { asOf = new Date() } = {}) {
  const rows = db.prepare(
    `SELECT f.*, a.name, a.tag, a.class_id, a.lifecycle_state, c.label AS class_label, c.key AS class_key
     FROM asset_financials f
     JOIN assets a ON a.id = f.asset_id
     LEFT JOIN ci_classes c ON c.id = a.class_id
     WHERE f.workspace_id = ?`
  ).all(workspaceId);

  const byClass = new Map();
  const byCostCentre = new Map();
  let totalCost = 0; let totalBook = 0; let totalSupport = 0; let unvalued = 0;

  for (const row of rows) {
    const dep = depreciate(row, asOf);
    const cost = Number(row.purchase_cost) || 0;
    const book = dep ? dep.book_value : 0;
    if (!dep) unvalued += 1;
    totalCost += cost;
    totalBook += book;
    totalSupport += Number(row.annual_support_cost) || 0;

    const classKey = row.class_key || 'unclassified';
    if (!byClass.has(classKey)) byClass.set(classKey, { key: classKey, label: row.class_label || 'Unclassified', count: 0, purchase_cost: 0, book_value: 0 });
    const cls = byClass.get(classKey);
    cls.count += 1; cls.purchase_cost += cost; cls.book_value += book;

    const centre = row.cost_centre || 'Unassigned';
    if (!byCostCentre.has(centre)) byCostCentre.set(centre, { cost_centre: centre, count: 0, purchase_cost: 0, book_value: 0, annual_support_cost: 0 });
    const cc = byCostCentre.get(centre);
    cc.count += 1; cc.purchase_cost += cost; cc.book_value += book; cc.annual_support_cost += Number(row.annual_support_cost) || 0;
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  const tidy = (list) => list.map((e) => ({
    ...e, purchase_cost: round2(e.purchase_cost), book_value: round2(e.book_value),
    ...(e.annual_support_cost !== undefined ? { annual_support_cost: round2(e.annual_support_cost) } : {}),
  }));

  return {
    totals: {
      assets_with_financials: rows.length,
      // Assets nobody has costed are counted separately rather than folded in
      // as zero, so the total never looks more complete than it is.
      unvalued,
      purchase_cost: round2(totalCost),
      book_value: round2(totalBook),
      accumulated_depreciation: round2(totalCost - totalBook),
      annual_support_cost: round2(totalSupport),
      currency: rows[0]?.currency || 'USD',
    },
    by_class: tidy([...byClass.values()]).sort((a, b) => b.book_value - a.book_value),
    by_cost_centre: tidy([...byCostCentre.values()]).sort((a, b) => b.book_value - a.book_value),
  };
}

// Assets whose warranty or support contract is running out. Rides the same
// read-time model as everything else: no scheduler, just a query with a
// horizon, called by whatever wants to warn.
export function expiringSoon(workspaceId, { days = 90 } = {}) {
  const horizon = new Date(Date.now() + days * MS_PER_DAY).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const warranties = db.prepare(
    `SELECT id, tag, name, warranty_expiry FROM assets
     WHERE workspace_id = ? AND warranty_expiry IS NOT NULL AND warranty_expiry != ''
       AND substr(warranty_expiry,1,10) <= ? ORDER BY warranty_expiry`
  ).all(workspaceId, horizon);

  const contracts = db.prepare(
    `SELECT id, name, vendor, end_date FROM contracts
     WHERE workspace_id = ? AND end_date IS NOT NULL AND end_date != ''
       AND substr(end_date,1,10) <= ? ORDER BY end_date`
  ).all(workspaceId, horizon);

  const licences = db.prepare(
    `SELECT e.id, e.expiry_date, e.quantity, p.name AS product_name
     FROM license_entitlements e JOIN software_products p ON p.id = e.product_id
     WHERE e.workspace_id = ? AND e.expiry_date IS NOT NULL AND e.expiry_date != ''
       AND substr(e.expiry_date,1,10) <= ? ORDER BY e.expiry_date`
  ).all(workspaceId, horizon);

  const mark = (list, field) => list.map((r) => ({ ...r, expired: String(r[field]).slice(0, 10) < today }));

  return {
    horizon_days: days,
    warranties: mark(warranties, 'warranty_expiry'),
    contracts: mark(contracts, 'end_date'),
    licences: mark(licences, 'expiry_date'),
  };
}

export function createContractLink(workspaceId, assetId, contractId) {
  return saveFinancials(workspaceId, assetId, { contract_id: contractId });
}

export { uid };
