// Software licensing: what you are entitled to, what is actually installed,
// and the gap between them.
//
// The gap is the only number anyone wants, and it is the one most tools get
// subtly wrong, because how you COUNT depends on the licensing metric. Ten
// installations of a per-device product consume ten licences; the same ten
// installations belonging to three people consume three under a per-user
// metric. Counting installations and calling it usage is the usual mistake
// and it produces both false over-licensing and, more dangerously, false
// compliance.
import { db, uid } from '../db.js';
import { ConfigError } from './ciClasses.js';

export const LICENSING_METRICS = [
  { key: 'per_device', label: 'Per device', counts: 'Distinct devices it is installed on.' },
  { key: 'per_user', label: 'Per user', counts: 'Distinct people it is assigned to, however many devices each has.' },
  { key: 'per_core', label: 'Per core', counts: 'Total CPU cores across the devices it runs on.' },
  { key: 'per_socket', label: 'Per socket', counts: 'One per host, regardless of how many guests run on it.' },
  { key: 'concurrent', label: 'Concurrent', counts: 'Peak simultaneous use. Recorded installations are an upper bound.' },
  { key: 'subscription', label: 'Subscription', counts: 'Distinct people, and every entitlement carries a renewal date.' },
  { key: 'free', label: 'Free / open source', counts: 'Tracked for visibility. Never counted against an entitlement.' },
];

const METRIC_KEYS = new Set(LICENSING_METRICS.map((m) => m.key));

// ------------------------------------------------------------- products ---

export function listProducts(workspaceId) {
  return db.prepare('SELECT * FROM software_products WHERE workspace_id = ? ORDER BY publisher, name').all(workspaceId);
}

export function getProduct(workspaceId, id) {
  return db.prepare('SELECT * FROM software_products WHERE id = ? AND workspace_id = ?').get(id, workspaceId) || null;
}

export function createProduct(workspaceId, body) {
  if (!body.name) throw new ConfigError('name is required');
  const metric = body.licensing_metric || 'per_device';
  if (!METRIC_KEYS.has(metric)) throw new ConfigError(`Unknown licensing metric: ${metric}`);

  const clash = db.prepare('SELECT id FROM software_products WHERE workspace_id = ? AND name = ? AND COALESCE(edition,\'\') = ?')
    .get(workspaceId, body.name, body.edition || '');
  if (clash) throw new ConfigError(`${body.name}${body.edition ? ` (${body.edition})` : ''} is already tracked`, 409);

  const id = uid('swp');
  db.prepare(
    'INSERT INTO software_products (id, workspace_id, name, publisher, edition, licensing_metric, ci_id, notes) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, workspaceId, body.name, body.publisher || null, body.edition || null, metric, body.ci_id || null, body.notes || null);
  return getProduct(workspaceId, id);
}

export function updateProduct(workspaceId, id, body) {
  const product = getProduct(workspaceId, id);
  if (!product) throw new ConfigError('Product not found', 404);
  if (body.licensing_metric && !METRIC_KEYS.has(body.licensing_metric)) {
    throw new ConfigError(`Unknown licensing metric: ${body.licensing_metric}`);
  }
  const sets = []; const params = [];
  for (const field of ['name', 'publisher', 'edition', 'licensing_metric', 'ci_id', 'notes']) {
    if (body[field] === undefined) continue;
    sets.push(`${field} = ?`); params.push(body[field] || null);
  }
  if (!sets.length) return product;
  params.push(id);
  db.prepare(`UPDATE software_products SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getProduct(workspaceId, id);
}

export function deleteProduct(workspaceId, id) {
  const product = getProduct(workspaceId, id);
  if (!product) throw new ConfigError('Product not found', 404);
  db.prepare('DELETE FROM software_products WHERE id = ?').run(id);
  return { ok: true };
}

// --------------------------------------------------------- entitlements ---

export function addEntitlement(workspaceId, productId, body) {
  const product = getProduct(workspaceId, productId);
  if (!product) throw new ConfigError('Product not found', 404);
  const quantity = Number(body.quantity);
  if (!Number.isInteger(quantity) || quantity < 0) throw new ConfigError('Quantity must be a whole number');

  const id = uid('ent');
  db.prepare(
    `INSERT INTO license_entitlements (id, workspace_id, product_id, quantity, license_key, purchase_date, expiry_date, unit_cost, currency, contract_id, purchase_order_id, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, workspaceId, productId, quantity, body.license_key || null, body.purchase_date || null,
    body.expiry_date || null, body.unit_cost ?? null, body.currency || 'USD',
    body.contract_id || null, body.purchase_order_id || null, body.notes || null,
  );
  return db.prepare('SELECT * FROM license_entitlements WHERE id = ?').get(id);
}

export function deleteEntitlement(workspaceId, id) {
  const row = db.prepare('SELECT id FROM license_entitlements WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new ConfigError('Entitlement not found', 404);
  db.prepare('DELETE FROM license_entitlements WHERE id = ?').run(id);
  return { ok: true };
}

// -------------------------------------------------------- installations ---

export function recordInstallation(workspaceId, productId, body) {
  const product = getProduct(workspaceId, productId);
  if (!product) throw new ConfigError('Product not found', 404);
  if (!body.ci_id && !body.user_id) throw new ConfigError('An installation needs a device, a user, or both');
  if (body.ci_id && !db.prepare('SELECT id FROM assets WHERE id = ? AND workspace_id = ?').get(body.ci_id, workspaceId)) {
    throw new ConfigError('CI not found', 404);
  }

  // Matched with COALESCE rather than left to ON CONFLICT. SQLite treats
  // NULLs as distinct in a UNIQUE index, so an installation recorded against
  // a device but no user never conflicts with itself -- every rescan would
  // insert another row, inflating usage and manufacturing a licence shortfall
  // out of nothing.
  const existing = db.prepare(
    `SELECT id FROM software_installations
     WHERE workspace_id = ? AND product_id = ? AND COALESCE(ci_id,'') = ? AND COALESCE(user_id,'') = ?`
  ).get(workspaceId, productId, body.ci_id || '', body.user_id || '');

  if (existing) {
    db.prepare("UPDATE software_installations SET version = ?, last_seen_at = datetime('now'), source = ? WHERE id = ?")
      .run(body.version || null, body.source || 'manual', existing.id);
    return db.prepare('SELECT * FROM software_installations WHERE id = ?').get(existing.id);
  }

  const id = uid('sin');
  db.prepare(
    `INSERT INTO software_installations (id, workspace_id, product_id, ci_id, user_id, version, last_seen_at, source)
     VALUES (?,?,?,?,?,?,datetime('now'),?)`
  ).run(id, workspaceId, productId, body.ci_id || null, body.user_id || null, body.version || null, body.source || 'manual');
  return db.prepare('SELECT * FROM software_installations WHERE id = ?').get(id);
}

export function removeInstallation(workspaceId, id) {
  const row = db.prepare('SELECT id FROM software_installations WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new ConfigError('Installation not found', 404);
  db.prepare('DELETE FROM software_installations WHERE id = ?').run(id);
  return { ok: true };
}

export function listInstallations(workspaceId, productId) {
  return db.prepare(
    `SELECT i.*, a.name AS ci_name, a.tag AS ci_tag, u.name AS user_name
     FROM software_installations i
     LEFT JOIN assets a ON a.id = i.ci_id
     LEFT JOIN users u ON u.id = i.user_id
     WHERE i.workspace_id = ? AND i.product_id = ? ORDER BY a.name, u.name`
  ).all(workspaceId, productId);
}

// ------------------------------------------------------------ compliance ---

// How many licences a set of installations actually consumes, given the
// metric. This is the function the whole module exists for.
function consumption(workspaceId, product, installations) {
  const metric = product.licensing_metric;

  if (metric === 'free') return { consumed: 0, basis: 'Not counted — free or open source.' };

  if (metric === 'per_user' || metric === 'subscription') {
    const users = new Set(installations.map((i) => i.user_id).filter(Boolean));
    // An installation with a device but nobody assigned still consumes a seat
    // somewhere; counting it as zero would under-report and manufacture
    // compliance out of missing data.
    const unattributed = installations.filter((i) => !i.user_id).length;
    return {
      consumed: users.size + unattributed,
      basis: `${users.size} distinct user(s)${unattributed ? `, plus ${unattributed} installation(s) with nobody assigned` : ''}.`,
      unattributed,
    };
  }

  if (metric === 'per_core' || metric === 'per_socket') {
    const ciIds = [...new Set(installations.map((i) => i.ci_id).filter(Boolean))];
    if (!ciIds.length) return { consumed: 0, basis: 'No devices recorded.' };

    if (metric === 'per_socket') {
      return { consumed: ciIds.length, basis: `${ciIds.length} host(s).` };
    }

    // Cores come from the CI's own cpu_cores attribute. A device that does not
    // report its core count is the interesting case: assuming zero would
    // under-count, so it is surfaced instead.
    const rows = db.prepare(
      `SELECT v.ci_id, v.value FROM ci_attribute_values v
       JOIN ci_class_attributes a ON a.id = v.attribute_id
       WHERE a.attr_key = 'cpu_cores' AND v.ci_id IN (${ciIds.map(() => '?').join(',')})`
    ).all(...ciIds);
    const cores = new Map(rows.map((r) => [r.ci_id, parseInt(r.value, 10) || 0]));
    const unknown = ciIds.filter((id) => !cores.has(id));
    const total = ciIds.reduce((sum, id) => sum + (cores.get(id) || 0), 0);
    return {
      consumed: total,
      basis: `${total} core(s) across ${ciIds.length} device(s)${unknown.length ? `; ${unknown.length} device(s) do not report a core count` : ''}.`,
      unknown_core_count: unknown.length,
    };
  }

  if (metric === 'concurrent') {
    // Without a usage feed, recorded installations are the honest upper bound.
    const devices = new Set(installations.map((i) => i.ci_id || i.user_id).filter(Boolean));
    return { consumed: devices.size, basis: `${devices.size} recorded installation(s) — an upper bound; concurrent peak needs a usage feed.`, estimated: true };
  }

  // per_device, and the default for anything unrecognised.
  const devices = new Set(installations.map((i) => i.ci_id).filter(Boolean));
  const userOnly = installations.filter((i) => !i.ci_id).length;
  return {
    consumed: devices.size + userOnly,
    basis: `${devices.size} distinct device(s)${userOnly ? `, plus ${userOnly} installation(s) with no device recorded` : ''}.`,
  };
}

function entitledQuantity(entitlements, asOf) {
  const today = asOf.toISOString().slice(0, 10);
  let total = 0; let expired = 0;
  for (const e of entitlements) {
    // An expired entitlement stops counting. Leaving it in is how a estate
    // reports itself compliant on licences it no longer holds.
    if (e.expiry_date && String(e.expiry_date).slice(0, 10) < today) { expired += e.quantity; continue; }
    total += e.quantity;
  }
  return { total, expired };
}

export function positionFor(workspaceId, productId, { asOf = new Date() } = {}) {
  const product = getProduct(workspaceId, productId);
  if (!product) throw new ConfigError('Product not found', 404);

  const entitlements = db.prepare('SELECT * FROM license_entitlements WHERE workspace_id = ? AND product_id = ?')
    .all(workspaceId, productId);
  const installations = db.prepare('SELECT * FROM software_installations WHERE workspace_id = ? AND product_id = ?')
    .all(workspaceId, productId);

  const { total: entitled, expired } = entitledQuantity(entitlements, asOf);
  const used = consumption(workspaceId, product, installations);
  const balance = entitled - used.consumed;

  const cost = entitlements.reduce((sum, e) => sum + (Number(e.unit_cost) || 0) * (Number(e.quantity) || 0), 0);
  const nextExpiry = entitlements
    .map((e) => e.expiry_date).filter(Boolean)
    .map((d) => String(d).slice(0, 10))
    .filter((d) => d >= asOf.toISOString().slice(0, 10))
    .sort()[0] || null;

  return {
    product,
    metric: LICENSING_METRICS.find((m) => m.key === product.licensing_metric) || null,
    entitled,
    expired_entitlements: expired,
    consumed: used.consumed,
    basis: used.basis,
    balance,
    // "compliant" is the word people act on, so it is stated rather than left
    // to be inferred from a signed number.
    status: product.licensing_metric === 'free' ? 'not_applicable'
      : balance < 0 ? 'over_deployed'
        : balance === 0 ? 'exact'
          : 'under_deployed',
    shortfall: balance < 0 ? -balance : 0,
    spare: balance > 0 ? balance : 0,
    installation_count: installations.length,
    entitlement_count: entitlements.length,
    total_cost: Math.round(cost * 100) / 100,
    next_expiry: nextExpiry,
    // Anything that makes the number less trustworthy travels with it.
    caveats: [
      ...(used.estimated ? ['Concurrent licensing is estimated from recorded installations.'] : []),
      ...(used.unattributed ? [`${used.unattributed} installation(s) have nobody assigned.`] : []),
      ...(used.unknown_core_count ? [`${used.unknown_core_count} device(s) do not report a core count, so this may be understated.`] : []),
      ...(expired ? [`${expired} expired licence(s) are excluded.`] : []),
      ...(entitlements.length === 0 ? ['No entitlements recorded, so everything installed counts as a shortfall.'] : []),
    ],
  };
}

export function compliancePosition(workspaceId, opts = {}) {
  const products = listProducts(workspaceId);
  const positions = products.map((p) => positionFor(workspaceId, p.id, opts));
  const over = positions.filter((p) => p.status === 'over_deployed');

  return {
    products: positions.sort((a, b) => b.shortfall - a.shortfall || a.product.name.localeCompare(b.product.name)),
    summary: {
      products: positions.length,
      over_deployed: over.length,
      // The number to put in front of a finance or audit conversation.
      total_shortfall: over.reduce((s, p) => s + p.shortfall, 0),
      total_spare: positions.reduce((s, p) => s + p.spare, 0),
      total_licence_cost: Math.round(positions.reduce((s, p) => s + p.total_cost, 0) * 100) / 100,
      at_risk: over.map((p) => ({ id: p.product.id, name: p.product.name, shortfall: p.shortfall })),
    },
  };
}
