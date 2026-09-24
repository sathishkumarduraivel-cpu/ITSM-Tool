// CI classes: what an `assets` row means, and what it is allowed to contain.
//
// Two ideas carry the whole module:
//
// 1. Attributes are INHERITED down the class tree. An attribute is declared
//    once on the class that owns it, and every descendant gets it. A child
//    may redeclare the same attr_key to tighten it (optional -> required,
//    text -> identifier); the nearest declaration wins.
// 2. Values are validated against that resolved schema on every write, from
//    every direction -- the form, a CSV import, a discovery payload. A CMDB
//    that accepts "8GB" into a number field is a CMDB nobody can report on,
//    so this is the only door.
import { db, uid } from '../db.js';
import { DEFAULT_CLASSES, DEFAULT_ATTRIBUTES, LEGACY_TYPE_TO_CLASS } from './ciClassDefaults.js';

export const DATA_TYPES = [
  'text', 'textarea', 'number', 'integer', 'date', 'datetime',
  'boolean', 'select', 'multiselect', 'reference', 'ip', 'url', 'email',
];

// Types whose value is a set of admin-configured strings.
const OPTION_TYPES = new Set(['select', 'multiselect']);

// Deep enough for any sane model; the guard is really there so a corrupted
// parent pointer cannot spin forever.
const MAX_DEPTH = 12;

const SLUG = /^[a-z][a-z0-9_]{0,48}$/;

// ---------------------------------------------------------------- seeding

export function ensureDefaultCiClasses(workspaceId) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM ci_classes WHERE workspace_id = ?').get(workspaceId);
  if (c > 0) return;

  // The seed is ~140 inserts. This database runs in DELETE journal mode, so
  // each statement outside a transaction is its own fsync -- wrapping the
  // seed turns a visibly slow first page load into one flush. It also means
  // a crash midway cannot leave a workspace holding half a class model,
  // which would then never re-seed because the count is no longer zero.
  db.exec('BEGIN');
  try {
    seedDefaults(workspaceId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function seedDefaults(workspaceId) {
  // DEFAULT_CLASSES is ordered parent-before-child, so a single pass can
  // resolve parents as it goes.
  const idByKey = new Map();
  DEFAULT_CLASSES.forEach((cls, i) => {
    const id = uid('cic');
    db.prepare(
      `INSERT INTO ci_classes (id, workspace_id, key, label, plural_label, description, parent_class_id,
                               icon, color, is_asset, is_abstract, sort_order, enabled, system)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1)`
    ).run(
      id, workspaceId, cls.key, cls.label, cls.plural_label || null, cls.description || null,
      cls.parent ? idByKey.get(cls.parent) : null,
      cls.icon || null, cls.color || null, cls.is_asset, cls.is_abstract, i * 10,
    );
    idByKey.set(cls.key, id);
  });

  // Attributes go in afterwards so a reference attribute can point at a class
  // declared later in the list (hardware.installed_rack -> rack).
  for (const [classKey, attrs] of Object.entries(DEFAULT_ATTRIBUTES)) {
    const classId = idByKey.get(classKey);
    if (!classId) continue;
    attrs.forEach((a, i) => {
      db.prepare(
        `INSERT INTO ci_class_attributes (id, workspace_id, class_id, attr_key, label, data_type, options,
                                          reference_class_id, unit, required, is_identifier, default_value,
                                          min_value, max_value, pattern, help_text, sort_order, enabled, system)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1)`
      ).run(
        uid('cia'), workspaceId, classId, a.attr_key, a.label, a.data_type,
        a.options ? JSON.stringify(a.options) : null,
        a.reference_class ? idByKey.get(a.reference_class) || null : null,
        a.unit || null, a.required || 0, a.is_identifier || 0, a.default_value ?? null,
        a.min_value ?? null, a.max_value ?? null, a.pattern || null, a.help_text || null, i * 10,
      );
    });
  }
}

// ---------------------------------------------------------------- reading

export function listClasses(workspaceId, { includeDisabled = false } = {}) {
  ensureDefaultCiClasses(workspaceId);
  const sql = `SELECT * FROM ci_classes WHERE workspace_id = ?${includeDisabled ? '' : ' AND enabled = 1'} ORDER BY sort_order, label`;
  return db.prepare(sql).all(workspaceId);
}

export function getClass(workspaceId, idOrKey) {
  if (!idOrKey) return null;
  ensureDefaultCiClasses(workspaceId);
  return db.prepare('SELECT * FROM ci_classes WHERE workspace_id = ? AND (id = ? OR key = ?)')
    .get(workspaceId, idOrKey, idOrKey) || null;
}

// Root-first, ending with the class itself. Cycle-safe: a class already seen
// terminates the walk rather than repeating it.
export function ancestryOf(workspaceId, classId) {
  const byId = new Map(listClasses(workspaceId, { includeDisabled: true }).map((c) => [c.id, c]));
  const chain = [];
  const seen = new Set();
  let cur = byId.get(classId);
  let depth = 0;
  while (cur && !seen.has(cur.id) && depth < MAX_DEPTH) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parent_class_id ? byId.get(cur.parent_class_id) : null;
    depth += 1;
  }
  return chain;
}

export function descendantsOf(workspaceId, classId, { includeSelf = true } = {}) {
  const all = listClasses(workspaceId, { includeDisabled: true });
  const childrenOf = new Map();
  for (const c of all) {
    if (!c.parent_class_id) continue;
    if (!childrenOf.has(c.parent_class_id)) childrenOf.set(c.parent_class_id, []);
    childrenOf.get(c.parent_class_id).push(c);
  }
  const out = [];
  const seen = new Set();
  const walk = (id, depth) => {
    if (seen.has(id) || depth > MAX_DEPTH) return;
    seen.add(id);
    for (const child of childrenOf.get(id) || []) { out.push(child); walk(child.id, depth + 1); }
  };
  const self = all.find((c) => c.id === classId);
  if (!self) return [];
  if (includeSelf) out.push(self);
  walk(classId, 0);
  return out;
}

// The nested shape the class picker and the admin tree render from.
export function classTree(workspaceId) {
  const all = listClasses(workspaceId, { includeDisabled: true });
  const nodes = new Map(all.map((c) => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const c of all) {
    const node = nodes.get(c.id);
    const parent = c.parent_class_id ? nodes.get(c.parent_class_id) : null;
    if (parent && parent !== node) parent.children.push(node); else roots.push(node);
  }
  return roots;
}

// The resolved schema for a class: everything it declares plus everything it
// inherits, with the nearest declaration of a given attr_key winning.
export function effectiveAttributes(workspaceId, classId, { includeDisabled = false } = {}) {
  const chain = ancestryOf(workspaceId, classId);
  if (!chain.length) return [];
  const rows = db.prepare(
    `SELECT * FROM ci_class_attributes WHERE workspace_id = ? AND class_id IN (${chain.map(() => '?').join(',')})
     ${includeDisabled ? '' : 'AND enabled = 1'} ORDER BY sort_order, label`
  ).all(workspaceId, ...chain.map((c) => c.id));

  const depthOf = new Map(chain.map((c, i) => [c.id, i]));
  const byKey = new Map();
  for (const row of rows) {
    const prior = byKey.get(row.attr_key);
    // Later in the chain means closer to the class itself, so it overrides.
    if (prior && depthOf.get(prior.class_id) >= depthOf.get(row.class_id)) continue;
    byKey.set(row.attr_key, row);
  }

  const ownerById = new Map(chain.map((c) => [c.id, c]));
  return [...byKey.values()]
    .map((row) => ({
      ...row,
      options: parseOptions(row),
      owner_class_key: ownerById.get(row.class_id)?.key || null,
      owner_class_label: ownerById.get(row.class_id)?.label || null,
      inherited: row.class_id !== classId ? 1 : 0,
    }))
    .sort((a, b) => (depthOf.get(a.class_id) - depthOf.get(b.class_id))
      || (a.sort_order - b.sort_order)
      || a.label.localeCompare(b.label));
}

export function identifierAttributes(workspaceId, classId) {
  return effectiveAttributes(workspaceId, classId).filter((a) => a.is_identifier);
}

// An asset row saved before classes existed still has to read as something.
export function resolveClass(workspaceId, asset) {
  if (!asset) return null;
  if (asset.class_id) {
    const cls = getClass(workspaceId, asset.class_id);
    if (cls) return cls;
  }
  const legacyKey = LEGACY_TYPE_TO_CLASS[asset.type];
  return legacyKey ? getClass(workspaceId, legacyKey) : null;
}

// Ownership, warranty and financial fields only mean something on a class
// that represents a thing somebody bought.
export function isAssetClass(workspaceId, classId) {
  const cls = getClass(workspaceId, classId);
  return !!cls && !!cls.is_asset;
}

function parseOptions(row) {
  if (!row.options) return [];
  try {
    const parsed = JSON.parse(row.options);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------- validation

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidIp(value) {
  const m = IPV4.exec(value);
  if (m) return m.slice(1).every((o) => o.length <= 3 && Number(o) <= 255 && !(o.length > 1 && o[0] === '0'));
  // Anything with a colon is treated as IPv6 and only shape-checked: a full
  // IPv6 grammar is not worth carrying, and rejecting a valid address would
  // be worse than accepting an odd one.
  return value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value) && value.length <= 45;
}

// Returns { value, error }. `value` is the canonical TEXT form that goes into
// ci_attribute_values, or null to mean "not set".
export function coerceValue(workspaceId, attr, raw) {
  const empty = raw === undefined || raw === null || raw === ''
    || (Array.isArray(raw) && raw.length === 0);
  if (empty) return { value: null };

  const type = attr.data_type;
  const options = Array.isArray(attr.options) ? attr.options : parseOptions(attr);

  if (type === 'number' || type === 'integer') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) return { error: `${attr.label} must be a number` };
    if (type === 'integer' && !Number.isInteger(n)) return { error: `${attr.label} must be a whole number` };
    if (attr.min_value !== null && attr.min_value !== undefined && n < attr.min_value) {
      return { error: `${attr.label} must be at least ${attr.min_value}` };
    }
    if (attr.max_value !== null && attr.max_value !== undefined && n > attr.max_value) {
      return { error: `${attr.label} must be at most ${attr.max_value}` };
    }
    return { value: String(n) };
  }

  if (type === 'boolean') {
    const s = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return { value: '1' };
    if (['0', 'false', 'no', 'n', 'off'].includes(s)) return { value: '0' };
    return { error: `${attr.label} must be true or false` };
  }

  if (type === 'multiselect') {
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    const cleaned = list.map((v) => String(v).trim()).filter(Boolean);
    const unknown = cleaned.filter((v) => !options.includes(v));
    if (unknown.length) return { error: `${attr.label}: ${unknown.join(', ')} is not an allowed option` };
    if (!cleaned.length) return { value: null };
    return { value: JSON.stringify([...new Set(cleaned)]) };
  }

  const s = String(raw).trim();
  if (!s) return { value: null };

  if (type === 'select') {
    if (!options.includes(s)) return { error: `${attr.label}: ${s} is not an allowed option` };
    return { value: s };
  }

  if (type === 'date') {
    if (!DATE_ONLY.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
      return { error: `${attr.label} must be a date (YYYY-MM-DD)` };
    }
    return { value: s };
  }

  if (type === 'datetime') {
    if (Number.isNaN(Date.parse(s))) return { error: `${attr.label} must be a date and time` };
    return { value: s };
  }

  if (type === 'ip') {
    if (!isValidIp(s)) return { error: `${attr.label} must be an IP address` };
    return { value: s };
  }

  if (type === 'url') {
    try {
      const u = new URL(s);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('scheme');
    } catch {
      return { error: `${attr.label} must be an http or https URL` };
    }
    return { value: s };
  }

  if (type === 'email') {
    if (!EMAIL.test(s)) return { error: `${attr.label} must be an email address` };
    return { value: s };
  }

  if (type === 'reference') {
    const target = db.prepare('SELECT id, class_id, type, name FROM assets WHERE id = ? AND workspace_id = ?')
      .get(s, workspaceId);
    if (!target) return { error: `${attr.label}: no such CI in this workspace` };
    if (attr.reference_class_id) {
      const allowed = new Set(descendantsOf(workspaceId, attr.reference_class_id).map((c) => c.id));
      const targetClass = resolveClass(workspaceId, target);
      if (!targetClass || !allowed.has(targetClass.id)) {
        const want = getClass(workspaceId, attr.reference_class_id);
        return { error: `${attr.label} must point at a ${want ? want.label : 'permitted'} CI` };
      }
    }
    return { value: s };
  }

  // text / textarea, plus anything an admin adds later that behaves like text.
  if (attr.pattern) {
    let re = null;
    try { re = new RegExp(attr.pattern); } catch { re = null; }
    // A pattern that does not compile is an admin mistake, not a reason to
    // reject the user's data -- ignore it rather than blocking every write.
    if (re && !re.test(s)) return { error: attr.help_text || `${attr.label} is not in the expected format` };
  }
  return { value: s };
}

// Validates a whole payload against a class's resolved schema.
//
// `partial` is what a PATCH passes: only the supplied keys are checked, and
// missing required attributes are not an error because they may already be
// stored. A create passes partial=false and must satisfy every requirement.
//
// Every problem is collected, not just the first -- a form that reveals one
// error per submit is its own kind of bug.
export function validateAttributes(workspaceId, classId, input = {}, { partial = false, applyDefaults = true } = {}) {
  const attrs = effectiveAttributes(workspaceId, classId);
  const byKey = new Map(attrs.map((a) => [a.attr_key, a]));
  const errors = [];
  const values = new Map(); // attribute id -> canonical text or null

  for (const key of Object.keys(input)) {
    if (!byKey.has(key)) errors.push({ attr_key: key, message: `Unknown attribute: ${key}` });
  }

  for (const attr of attrs) {
    const supplied = Object.prototype.hasOwnProperty.call(input, attr.attr_key);
    let raw = supplied ? input[attr.attr_key] : undefined;

    if (!supplied) {
      if (partial) continue;
      if (applyDefaults && attr.default_value !== null && attr.default_value !== undefined && attr.default_value !== '') {
        raw = attr.default_value;
      }
    }

    const { value, error } = coerceValue(workspaceId, attr, raw);
    if (error) { errors.push({ attr_key: attr.attr_key, message: error }); continue; }
    if (value === null && attr.required && !partial) {
      errors.push({ attr_key: attr.attr_key, message: `${attr.label} is required` });
      continue;
    }
    if (supplied || value !== null) values.set(attr.id, value);
  }

  return { ok: errors.length === 0, errors, values };
}

// --------------------------------------------------------- value read/write

function decode(dataType, stored) {
  if (stored === null || stored === undefined) return null;
  if (dataType === 'number') return Number(stored);
  if (dataType === 'integer') return parseInt(stored, 10);
  if (dataType === 'boolean') return stored === '1';
  if (dataType === 'multiselect') {
    try { const v = JSON.parse(stored); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return stored;
}

// attr_key -> typed value, for every attribute that has one stored.
export function readAttributes(ciId) {
  const rows = db.prepare(
    `SELECT a.attr_key, a.data_type, v.value FROM ci_attribute_values v
     JOIN ci_class_attributes a ON a.id = v.attribute_id
     WHERE v.ci_id = ?`
  ).all(ciId);
  const out = {};
  for (const row of rows) out[row.attr_key] = decode(row.data_type, row.value);
  return out;
}

// The same read for a whole page of CIs, in one query. The list endpoint
// would otherwise issue one per row, which is the difference between an
// inventory that opens instantly and one that crawls at a few thousand CIs.
export function readAttributesFor(ciIds) {
  const out = new Map(ciIds.map((id) => [id, {}]));
  if (!ciIds.length) return out;

  // SQLite caps a statement at 999 host parameters by default, so page the
  // id list rather than assuming the caller passed a small one.
  const CHUNK = 500;
  for (let i = 0; i < ciIds.length; i += CHUNK) {
    const slice = ciIds.slice(i, i + CHUNK);
    const rows = db.prepare(
      `SELECT v.ci_id, a.attr_key, a.data_type, v.value FROM ci_attribute_values v
       JOIN ci_class_attributes a ON a.id = v.attribute_id
       WHERE v.ci_id IN (${slice.map(() => '?').join(',')})`
    ).all(...slice);
    for (const row of rows) out.get(row.ci_id)[row.attr_key] = decode(row.data_type, row.value);
  }
  return out;
}

// The shape the CI detail view renders: the full resolved schema with each
// attribute's current value attached, so an unset required field is visible
// rather than simply absent.
export function readAttributeDetail(workspaceId, ciId, classId) {
  const stored = db.prepare('SELECT attribute_id, value, source, updated_at FROM ci_attribute_values WHERE ci_id = ?')
    .all(ciId);
  const byAttrId = new Map(stored.map((r) => [r.attribute_id, r]));
  return effectiveAttributes(workspaceId, classId).map((attr) => {
    const row = byAttrId.get(attr.id);
    return {
      ...attr,
      value: row ? decode(attr.data_type, row.value) : null,
      raw_value: row ? row.value : null,
      source: row ? row.source : null,
      updated_at: row ? row.updated_at : null,
    };
  });
}

// Writes a validated payload. Returns { ok, errors } and writes nothing at
// all when validation fails -- a half-applied CI is worse than a rejected one.
export function writeAttributes(workspaceId, ciId, classId, input, { partial = true, source = 'manual' } = {}) {
  const result = validateAttributes(workspaceId, classId, input, { partial });
  if (!result.ok) return result;

  const upsert = db.prepare(
    `INSERT INTO ci_attribute_values (id, ci_id, attribute_id, value, source, updated_at)
     VALUES (?,?,?,?,?,datetime('now'))
     ON CONFLICT(ci_id, attribute_id) DO UPDATE SET value = excluded.value, source = excluded.source, updated_at = excluded.updated_at`
  );
  const clear = db.prepare('DELETE FROM ci_attribute_values WHERE ci_id = ? AND attribute_id = ?');

  // Safe to open a transaction here: validateAttributes above has already
  // forced any lazy class seeding, so nothing inside this block can try to
  // start a second one.
  db.exec('BEGIN');
  try {
    for (const [attributeId, value] of result.values) {
      if (value === null) clear.run(ciId, attributeId);
      else upsert.run(uid('civ'), ciId, attributeId, value, source);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return result;
}

// Changing a CI's class keeps every value whose attr_key still resolves on
// the new class and drops the rest, rather than silently keeping orphaned
// rows that no longer appear anywhere.
export function reconcileValuesForClass(workspaceId, ciId, newClassId) {
  const keep = new Set(effectiveAttributes(workspaceId, newClassId, { includeDisabled: true }).map((a) => a.id));
  const current = db.prepare(
    `SELECT v.id, v.attribute_id, v.value, a.attr_key FROM ci_attribute_values v
     JOIN ci_class_attributes a ON a.id = v.attribute_id WHERE v.ci_id = ?`
  ).all(ciId);

  const byKey = new Map(effectiveAttributes(workspaceId, newClassId, { includeDisabled: true }).map((a) => [a.attr_key, a]));
  let moved = 0; let dropped = 0;
  for (const row of current) {
    if (keep.has(row.attribute_id)) continue;
    const replacement = byKey.get(row.attr_key);
    if (replacement) {
      // Same field, declared on a different class -- carry the value across.
      db.prepare('UPDATE ci_attribute_values SET attribute_id = ? WHERE id = ?').run(replacement.id, row.id);
      moved += 1;
    } else {
      db.prepare('DELETE FROM ci_attribute_values WHERE id = ?').run(row.id);
      dropped += 1;
    }
  }
  return { moved, dropped };
}

// ------------------------------------------------------------------- CRUD

class ConfigError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export { ConfigError };

export function createClass(workspaceId, body) {
  ensureDefaultCiClasses(workspaceId);
  const key = String(body.key || '').trim().toLowerCase();
  if (!SLUG.test(key)) throw new ConfigError('key must be lowercase letters, numbers and underscores, starting with a letter');
  if (!body.label) throw new ConfigError('label is required');
  if (getClass(workspaceId, key)) throw new ConfigError(`A class with the key ${key} already exists`, 409);

  let parent = null;
  if (body.parent_class_id) {
    parent = getClass(workspaceId, body.parent_class_id);
    if (!parent) throw new ConfigError('Parent class not found', 404);
  }

  const id = uid('cic');
  const { max } = db.prepare('SELECT COALESCE(MAX(sort_order), 0) max FROM ci_classes WHERE workspace_id = ?').get(workspaceId);
  db.prepare(
    `INSERT INTO ci_classes (id, workspace_id, key, label, plural_label, description, parent_class_id,
                             icon, color, is_asset, is_abstract, sort_order, enabled, system)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
  ).run(
    id, workspaceId, key, body.label, body.plural_label || null, body.description || null,
    parent ? parent.id : null, body.icon || null, body.color || null,
    // A new class inherits its parent's nature unless told otherwise: a child
    // of Business Service is not suddenly something that depreciates.
    body.is_asset === undefined ? (parent ? parent.is_asset : 1) : (body.is_asset ? 1 : 0),
    body.is_abstract ? 1 : 0, max + 10, body.enabled === 0 ? 0 : 1,
  );
  return getClass(workspaceId, id);
}

export function updateClass(workspaceId, classId, body) {
  const cls = getClass(workspaceId, classId);
  if (!cls) throw new ConfigError('Class not found', 404);

  if (body.key !== undefined && body.key !== cls.key) {
    if (cls.system) throw new ConfigError('The key of a built-in class cannot be changed');
    const key = String(body.key).trim().toLowerCase();
    if (!SLUG.test(key)) throw new ConfigError('key must be lowercase letters, numbers and underscores');
    if (getClass(workspaceId, key)) throw new ConfigError(`A class with the key ${key} already exists`, 409);
  }

  if (body.parent_class_id !== undefined && body.parent_class_id !== cls.parent_class_id) {
    if (body.parent_class_id) {
      const parent = getClass(workspaceId, body.parent_class_id);
      if (!parent) throw new ConfigError('Parent class not found', 404);
      if (parent.id === cls.id) throw new ConfigError('A class cannot be its own parent');
      // Re-parenting under one's own descendant would make the tree a ring,
      // and every ancestry walk would then depend on the depth guard rather
      // than on the data being sane.
      if (descendantsOf(workspaceId, cls.id).some((d) => d.id === parent.id)) {
        throw new ConfigError('That would put the class underneath itself');
      }
    }
  }

  if (body.is_abstract && !cls.is_abstract) {
    const { c } = db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ? AND class_id = ?').get(workspaceId, cls.id);
    if (c > 0) throw new ConfigError(`${c} CI(s) are on this class, so it cannot become an abstract grouping`);
  }

  const allowed = ['key', 'label', 'plural_label', 'description', 'parent_class_id', 'icon', 'color', 'is_asset', 'is_abstract', 'sort_order', 'enabled'];
  const sets = []; const params = [];
  for (const field of allowed) {
    if (body[field] === undefined) continue;
    let v = body[field];
    if (['is_asset', 'is_abstract', 'enabled'].includes(field)) v = v ? 1 : 0;
    if (field === 'key') v = String(v).trim().toLowerCase();
    if (field === 'parent_class_id' && !v) v = null;
    sets.push(`${field} = ?`); params.push(v);
  }
  if (!sets.length) return cls;
  sets.push("updated_at = datetime('now')");
  params.push(cls.id);
  db.prepare(`UPDATE ci_classes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getClass(workspaceId, cls.id);
}

export function deleteClass(workspaceId, classId) {
  const cls = getClass(workspaceId, classId);
  if (!cls) throw new ConfigError('Class not found', 404);
  if (cls.system) throw new ConfigError('Built-in classes cannot be deleted. Disable it instead.');

  const children = descendantsOf(workspaceId, cls.id, { includeSelf: false });
  if (children.length) throw new ConfigError(`${children.length} class(es) inherit from this one`);

  const { c } = db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ? AND class_id = ?').get(workspaceId, cls.id);
  if (c > 0) throw new ConfigError(`${c} CI(s) are still on this class`);

  db.prepare('DELETE FROM ci_classes WHERE id = ?').run(cls.id);
  return { ok: true };
}

function validateAttributeBody(workspaceId, body, existing = null) {
  const dataType = body.data_type || existing?.data_type || 'text';
  if (!DATA_TYPES.includes(dataType)) throw new ConfigError(`Unsupported field type: ${dataType}`);

  const options = body.options !== undefined
    ? body.options
    : (existing ? parseOptions(existing) : null);
  if (OPTION_TYPES.has(dataType)) {
    if (!Array.isArray(options) || options.length === 0) throw new ConfigError('A choice field needs at least one option');
  }

  const referenceClassId = body.reference_class_id !== undefined ? body.reference_class_id : existing?.reference_class_id;
  if (dataType === 'reference') {
    if (!referenceClassId) throw new ConfigError('A reference field must say which class it points at');
    if (!getClass(workspaceId, referenceClassId)) throw new ConfigError('Referenced class not found', 404);
  }

  if (body.pattern) {
    try { new RegExp(body.pattern); } catch { throw new ConfigError('The validation pattern is not a valid regular expression'); }
  }

  const min = body.min_value ?? existing?.min_value;
  const max = body.max_value ?? existing?.max_value;
  if (min !== null && min !== undefined && max !== null && max !== undefined && Number(min) > Number(max)) {
    throw new ConfigError('The minimum cannot be greater than the maximum');
  }
  return { dataType, options, referenceClassId };
}

export function createAttribute(workspaceId, classId, body) {
  const cls = getClass(workspaceId, classId);
  if (!cls) throw new ConfigError('Class not found', 404);

  const attrKey = String(body.attr_key || '').trim().toLowerCase();
  if (!SLUG.test(attrKey)) throw new ConfigError('Field key must be lowercase letters, numbers and underscores, starting with a letter');
  if (!body.label) throw new ConfigError('label is required');

  const clash = db.prepare('SELECT id FROM ci_class_attributes WHERE workspace_id = ? AND class_id = ? AND attr_key = ?')
    .get(workspaceId, cls.id, attrKey);
  if (clash) throw new ConfigError(`This class already declares ${attrKey}`, 409);

  const { dataType, options, referenceClassId } = validateAttributeBody(workspaceId, { ...body, attr_key: attrKey });

  const { max } = db.prepare('SELECT COALESCE(MAX(sort_order), 0) max FROM ci_class_attributes WHERE workspace_id = ? AND class_id = ?')
    .get(workspaceId, cls.id);
  const id = uid('cia');
  db.prepare(
    `INSERT INTO ci_class_attributes (id, workspace_id, class_id, attr_key, label, data_type, options,
                                      reference_class_id, unit, required, is_identifier, default_value,
                                      min_value, max_value, pattern, help_text, sort_order, enabled, system)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`
  ).run(
    id, workspaceId, cls.id, attrKey, body.label, dataType,
    OPTION_TYPES.has(dataType) ? JSON.stringify(options) : null,
    dataType === 'reference' ? referenceClassId : null,
    body.unit || null, body.required ? 1 : 0, body.is_identifier ? 1 : 0, body.default_value ?? null,
    body.min_value ?? null, body.max_value ?? null, body.pattern || null, body.help_text || null,
    max + 10, body.enabled === 0 ? 0 : 1,
  );
  return db.prepare('SELECT * FROM ci_class_attributes WHERE id = ?').get(id);
}

export function updateAttribute(workspaceId, attributeId, body) {
  const attr = db.prepare('SELECT * FROM ci_class_attributes WHERE id = ? AND workspace_id = ?').get(attributeId, workspaceId);
  if (!attr) throw new ConfigError('Field not found', 404);

  if (body.attr_key !== undefined && body.attr_key !== attr.attr_key && attr.system) {
    throw new ConfigError('The key of a built-in field cannot be changed');
  }

  // Retyping a field that already holds data would leave values that no
  // longer parse -- refuse, and let the admin clear or delete it explicitly.
  if (body.data_type && body.data_type !== attr.data_type) {
    const { c } = db.prepare('SELECT COUNT(*) c FROM ci_attribute_values WHERE attribute_id = ?').get(attr.id);
    if (c > 0) throw new ConfigError(`${c} CI(s) already hold a value for this field, so its type cannot change`);
  }

  const { dataType, options, referenceClassId } = validateAttributeBody(workspaceId, body, attr);

  // Narrowing the options of a live choice field silently invalidates stored
  // values; name the CIs that would break instead of breaking them.
  if (OPTION_TYPES.has(dataType) && body.options !== undefined) {
    const allowed = new Set(options);
    const stored = db.prepare('SELECT value FROM ci_attribute_values WHERE attribute_id = ? AND value IS NOT NULL').all(attr.id);
    const orphaned = new Set();
    for (const row of stored) {
      const vals = dataType === 'multiselect' ? decode('multiselect', row.value) : [row.value];
      for (const v of vals) if (!allowed.has(v)) orphaned.add(v);
    }
    if (orphaned.size) throw new ConfigError(`Still in use by existing CIs: ${[...orphaned].join(', ')}`);
  }

  const allowed = ['attr_key', 'label', 'data_type', 'unit', 'required', 'is_identifier', 'default_value', 'min_value', 'max_value', 'pattern', 'help_text', 'sort_order', 'enabled'];
  const sets = []; const params = [];
  for (const field of allowed) {
    if (body[field] === undefined) continue;
    let v = body[field];
    if (['required', 'is_identifier', 'enabled'].includes(field)) v = v ? 1 : 0;
    if (field === 'attr_key') v = String(v).trim().toLowerCase();
    sets.push(`${field} = ?`); params.push(v);
  }
  if (body.options !== undefined) {
    sets.push('options = ?');
    params.push(OPTION_TYPES.has(dataType) ? JSON.stringify(options) : null);
  }
  if (body.reference_class_id !== undefined) {
    sets.push('reference_class_id = ?');
    params.push(dataType === 'reference' ? referenceClassId : null);
  }
  if (!sets.length) return attr;
  params.push(attr.id);
  db.prepare(`UPDATE ci_class_attributes SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM ci_class_attributes WHERE id = ?').get(attr.id);
}

export function deleteAttribute(workspaceId, attributeId) {
  const attr = db.prepare('SELECT * FROM ci_class_attributes WHERE id = ? AND workspace_id = ?').get(attributeId, workspaceId);
  if (!attr) throw new ConfigError('Field not found', 404);
  if (attr.system) throw new ConfigError('Built-in fields cannot be deleted. Disable it instead.');
  const { c } = db.prepare('SELECT COUNT(*) c FROM ci_attribute_values WHERE attribute_id = ?').get(attr.id);
  db.prepare('DELETE FROM ci_class_attributes WHERE id = ?').run(attr.id);
  return { ok: true, values_removed: c };
}
