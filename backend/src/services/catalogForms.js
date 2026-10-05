// The catalog request form: what a field can be, when it is shown, and
// whether what came back is acceptable.
//
// The previous implementation stored a form schema and then accepted whatever
// the browser posted. A required field could be left blank, a number field
// could contain "soon", a select could contain a value that was never an
// option -- and all of it went straight into the ticket description as text.
// Nothing downstream could rely on any of it.
//
// Conditional visibility is the other half. A form that asks every question
// every time is why people stop reading catalog forms; "show the manager
// field only when this is for somebody else" is the difference between four
// questions and fourteen.
import { db } from '../db.js';

export class CatalogError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const FIELD_TYPES = {
  text: { label: 'Short text' },
  textarea: { label: 'Long text' },
  number: { label: 'Number' },
  select: { label: 'Choose one', needsOptions: true },
  multiselect: { label: 'Choose several', needsOptions: true },
  checkbox: { label: 'Yes / no' },
  date: { label: 'Date' },
  email: { label: 'Email address' },
  user: { label: 'Person', dynamic: true },
  group: { label: 'Team', dynamic: true },
  asset: { label: 'Asset / CI', dynamic: true },
};

export const CONDITION_OPS = {
  equals: { label: 'is' },
  not_equals: { label: 'is not' },
  gt: { label: 'is more than' },
  lt: { label: 'is less than' },
  contains: { label: 'contains' },
  is_empty: { label: 'is empty', unary: true },
  is_not_empty: { label: 'is not empty', unary: true },
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseSchema(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Validate a form definition before it is saved.
 *
 * Catching a broken schema here rather than at request time matters: an item
 * with a select that has no options is not discovered until a requester tries
 * to order it and cannot.
 */
export function validateSchema(schema) {
  const fields = parseSchema(schema);
  const errors = [];
  const seen = new Set();

  fields.forEach((f, i) => {
    const where = f.label || f.key || `field ${i + 1}`;
    if (!f.key || !/^[a-z][a-z0-9_]{0,48}$/.test(f.key)) {
      errors.push(`${where}: the key must be lowercase letters, numbers and underscores`);
    } else if (seen.has(f.key)) {
      errors.push(`${where}: the key "${f.key}" is used more than once`);
    } else {
      seen.add(f.key);
    }
    if (!f.label) errors.push(`${where}: a label is required`);
    if (!FIELD_TYPES[f.type]) errors.push(`${where}: unknown field type "${f.type}"`);
    if (FIELD_TYPES[f.type]?.needsOptions && (!Array.isArray(f.options) || !f.options.length)) {
      errors.push(`${where}: a choice field needs at least one option`);
    }
    if (f.min !== undefined && f.max !== undefined && f.min !== null && f.max !== null && Number(f.min) > Number(f.max)) {
      errors.push(`${where}: the minimum cannot be more than the maximum`);
    }
    if (f.pattern) {
      try { new RegExp(f.pattern); } catch { errors.push(`${where}: the validation pattern is not a valid regular expression`); }
    }
    if (f.show_when?.field) {
      const op = f.show_when.op || 'equals';
      if (!CONDITION_OPS[op]) errors.push(`${where}: unknown condition "${op}"`);
      if (f.show_when.field === f.key) errors.push(`${where}: a field cannot depend on itself`);
      // Forward references are allowed -- a form can legitimately be laid out
      // with the controlling question lower down -- but a reference to a
      // field that does not exist at all is a mistake.
      if (!fields.some((other) => other.key === f.show_when.field)) {
        errors.push(`${where}: it depends on "${f.show_when.field}", which is not a field on this form`);
      }
    }
  });

  return errors;
}

// ------------------------------------------------------------- conditions

export function evaluateCondition({ field, op = 'equals', value }, values) {
  if (!field) return true;
  const actual = values?.[field];
  const empty = actual === undefined || actual === null || actual === ''
    || (Array.isArray(actual) && actual.length === 0);

  switch (op) {
    case 'is_empty': return empty;
    case 'is_not_empty': return !empty;
    case 'not_equals': return String(actual ?? '') !== String(value ?? '');
    case 'gt': return Number(actual) > Number(value);
    case 'lt': return Number(actual) < Number(value);
    case 'contains':
      return Array.isArray(actual)
        ? actual.map(String).includes(String(value))
        : String(actual ?? '').toLowerCase().includes(String(value ?? '').toLowerCase());
    case 'equals':
    default:
      // A checkbox arrives as a boolean but the condition is configured as a
      // string, so both are compared in string form.
      return String(actual ?? '') === String(value ?? '');
  }
}

/**
 * Which fields are actually on screen, given the answers so far.
 *
 * Resolved iteratively because a field can be revealed by another field that
 * is itself conditional. Bounded, so a circular pair cannot spin.
 */
export function visibleFields(schema, values) {
  const fields = parseSchema(schema);
  let visible = fields;
  for (let pass = 0; pass < 5; pass += 1) {
    const next = fields.filter((f) => {
      if (!f.show_when?.field) return true;
      // A field whose controller is itself hidden is hidden too, otherwise
      // hiding a question leaves its follow-ups stranded on screen.
      const controller = fields.find((c) => c.key === f.show_when.field);
      if (controller && !visible.includes(controller)) return false;
      return evaluateCondition(f.show_when, values);
    });
    if (next.length === visible.length && next.every((f, i) => f === visible[i])) return next;
    visible = next;
  }
  return visible;
}

// ------------------------------------------------------------- validation

function coerce(field, raw) {
  const empty = raw === undefined || raw === null || raw === ''
    || (Array.isArray(raw) && raw.length === 0);
  if (empty) return { value: null };

  switch (field.type) {
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { error: `${field.label} must be a number` };
      if (field.min !== undefined && field.min !== null && n < Number(field.min)) {
        return { error: `${field.label} must be at least ${field.min}` };
      }
      if (field.max !== undefined && field.max !== null && n > Number(field.max)) {
        return { error: `${field.label} must be at most ${field.max}` };
      }
      return { value: n };
    }
    case 'checkbox': {
      const s = String(raw).toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(s)) return { value: true };
      if (['false', '0', 'no', 'off'].includes(s)) return { value: false };
      return { error: `${field.label} must be yes or no` };
    }
    case 'select': {
      const s = String(raw);
      if (!(field.options || []).map(String).includes(s)) {
        return { error: `${field.label}: "${s}" is not one of the options` };
      }
      return { value: s };
    }
    case 'multiselect': {
      const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map((v) => String(v).trim()).filter(Boolean);
      const allowed = (field.options || []).map(String);
      const unknown = list.filter((v) => !allowed.includes(v));
      if (unknown.length) return { error: `${field.label}: ${unknown.join(', ')} is not an option` };
      return { value: [...new Set(list)] };
    }
    case 'date': {
      const s = String(raw).slice(0, 10);
      if (!DATE_ONLY.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
        return { error: `${field.label} must be a date` };
      }
      return { value: s };
    }
    case 'email': {
      const s = String(raw).trim();
      if (!EMAIL.test(s)) return { error: `${field.label} must be an email address` };
      return { value: s };
    }
    default: {
      const s = String(raw).trim();
      if (field.max_length && s.length > Number(field.max_length)) {
        return { error: `${field.label} must be ${field.max_length} characters or fewer` };
      }
      if (field.pattern) {
        let re = null;
        try { re = new RegExp(field.pattern); } catch { re = null; }
        // A pattern that does not compile is an admin mistake, not a reason
        // to block the requester.
        if (re && !re.test(s)) return { error: field.help_text || `${field.label} is not in the expected format` };
      }
      return { value: s };
    }
  }
}

// A person, team or asset field has to point at something that exists and is
// in this workspace, or the ticket carries a dangling id nobody can resolve.
function checkReference(workspaceId, field, value) {
  if (field.type === 'user') {
    const row = db.prepare(
      `SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id
       WHERE u.id = ? AND wm.workspace_id = ?`
    ).get(value, workspaceId);
    return row ? null : `${field.label}: that person is not in this workspace`;
  }
  if (field.type === 'group') {
    const row = db.prepare('SELECT id FROM groups WHERE id = ? AND workspace_id = ?').get(value, workspaceId);
    return row ? null : `${field.label}: that team does not exist`;
  }
  if (field.type === 'asset') {
    const row = db.prepare('SELECT id FROM assets WHERE id = ? AND workspace_id = ?').get(value, workspaceId);
    return row ? null : `${field.label}: that asset does not exist`;
  }
  return null;
}

/**
 * Validate what the requester submitted.
 *
 * Only fields that were actually on screen are considered. A required field
 * inside a branch the requester never saw must not block them, and a value
 * for a hidden field is discarded rather than trusted -- otherwise hiding a
 * question is cosmetic and anybody can post around it.
 */
export function validateSubmission(workspaceId, schema, submitted = {}) {
  const fields = parseSchema(schema);
  const shown = visibleFields(schema, submitted);
  const shownKeys = new Set(shown.map((f) => f.key));
  const errors = [];
  const values = {};

  for (const key of Object.keys(submitted)) {
    if (!fields.some((f) => f.key === key)) {
      errors.push({ field: key, message: `"${key}" is not a field on this form` });
    }
  }

  for (const field of shown) {
    const { value, error } = coerce(field, submitted[field.key]);
    if (error) { errors.push({ field: field.key, message: error }); continue; }

    if (value === null) {
      if (field.required) errors.push({ field: field.key, message: `${field.label} is required` });
      else if (field.default !== undefined && field.default !== '') values[field.key] = field.default;
      continue;
    }

    if (FIELD_TYPES[field.type]?.dynamic) {
      const refError = checkReference(workspaceId, field, value);
      if (refError) { errors.push({ field: field.key, message: refError }); continue; }
    }
    values[field.key] = value;
  }

  return {
    ok: errors.length === 0,
    errors,
    values,
    // Named so a caller can tell "you did not answer" from "we ignored that".
    discarded: Object.keys(submitted).filter((k) => fields.some((f) => f.key === k) && !shownKeys.has(k)),
  };
}

/**
 * The submitted form as readable lines for the ticket description.
 *
 * Labels rather than keys, and references resolved to names -- a ticket
 * saying "manager_id: usr_abc123" is useless to the person fulfilling it.
 */
export function describeSubmission(workspaceId, schema, values) {
  const fields = parseSchema(schema);
  const lines = [];
  for (const field of fields) {
    if (!(field.key in values)) continue;
    let v = values[field.key];
    if (Array.isArray(v)) v = v.join(', ');
    else if (typeof v === 'boolean') v = v ? 'Yes' : 'No';
    else if (field.type === 'user') v = db.prepare('SELECT name FROM users WHERE id = ?').get(v)?.name || v;
    else if (field.type === 'group') v = db.prepare('SELECT name FROM groups WHERE id = ?').get(v)?.name || v;
    else if (field.type === 'asset') {
      const a = db.prepare('SELECT name, tag FROM assets WHERE id = ?').get(v);
      v = a ? `${a.name} (${a.tag})` : v;
    }
    if (v === '' || v === null || v === undefined) continue;
    lines.push(`${field.label}: ${v}`);
  }
  return lines.join('\n');
}
