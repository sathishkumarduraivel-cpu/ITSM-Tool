// Field Manager: admin-defined custom fields per ticket type. Distinct from
// Business Rules (ticket_field_rules) -- this is where the fields themselves
// get created/typed/deleted; Business Rules only governs visibility/required/
// validation of fields that already exist here (or built into the schema).
import { db, uid } from '../db.js';

export function slugify(label) {
  return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field';
}

export function listCustomFields(workspaceId, ticketType) {
  return db.prepare(
    'SELECT * FROM ticket_custom_fields WHERE workspace_id = ? AND ticket_type = ? ORDER BY sort_order, created_at'
  ).all(workspaceId, ticketType).map((f) => ({ ...f, options: f.options ? JSON.parse(f.options) : [] }));
}

// Validates raw submitted custom values against this type's field
// definitions. Returns { values } (field_key -> normalized value, array for
// multiselect) or { error }. Fields the caller never mentions are simply
// skipped unless marked required.
export function normalizeCustomValues(defs, rawValues) {
  const values = {};
  for (const def of defs) {
    const raw = rawValues ? rawValues[def.field_key] : undefined;
    const empty = raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0);
    if (empty) {
      if (def.required) return { error: `Field "${def.label}" is required.` };
      continue;
    }
    if (def.field_type === 'multiselect') {
      const arr = Array.isArray(raw) ? raw : [raw];
      const invalid = arr.find((v) => !def.options.includes(v));
      if (invalid) return { error: `"${invalid}" is not a valid option for "${def.label}".` };
      values[def.field_key] = arr;
    } else if (def.field_type === 'select') {
      if (!def.options.includes(raw)) return { error: `"${raw}" is not a valid option for "${def.label}".` };
      values[def.field_key] = raw;
    } else {
      values[def.field_key] = String(raw);
    }
  }
  return { values };
}

export function saveCustomValues(ticketId, defs, values) {
  const byKey = Object.fromEntries(defs.map((d) => [d.field_key, d]));
  for (const [key, val] of Object.entries(values || {})) {
    const def = byKey[key];
    if (!def) continue;
    const stored = Array.isArray(val) ? JSON.stringify(val) : val;
    db.prepare(
      `INSERT INTO ticket_custom_field_values (id, ticket_id, field_id, value) VALUES (?,?,?,?)
       ON CONFLICT(ticket_id, field_id) DO UPDATE SET value = excluded.value`
    ).run(uid('cfv'), ticketId, def.id, stored);
  }
}

export function getCustomValues(ticketId) {
  const rows = db.prepare(
    `SELECT f.field_key, f.label, f.field_type, v.value
     FROM ticket_custom_field_values v JOIN ticket_custom_fields f ON f.id = v.field_id
     WHERE v.ticket_id = ?
     ORDER BY f.sort_order`
  ).all(ticketId);
  return rows.map((r) => ({ ...r, value: r.field_type === 'multiselect' ? JSON.parse(r.value || '[]') : r.value }));
}
