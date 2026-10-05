// Business Rule Logic Engine: named IF/THEN rules, evaluated in priority
// order against a ticket's current field values (built-in + Field Manager
// custom fields + the synthetic Service Item field). Replaces the old
// single-condition/single-field ticket_field_rules engine.
//
// Rule shape (as stored):
//   conditions: { logic: 'AND'|'OR', rules: [{ field, operator, value }] }
//   actions:    [{ type, field, options?, value? }]
//   priority:   lower runs first
//   status:     'active' | 'inactive' -- inactive rules never evaluate
//
// Actions:
//   show_field / hide_field   -- field visibility
//   mandate_field             -- field becomes required
//   set_options                -- restrict a dropdown field to exactly these options
//   remove_options              -- remove specific options from a dropdown field's current set
//   set_value                  -- auto-populate a field's value (and feeds later rules' conditions)
//   validate_field              -- format check (regex/min_length/max_length/number_range) -- an addition
//                                   beyond the 6 requested actions, carried forward from the
//                                   previous engine rather than dropped
//   block                       -- refuses the whole save with a custom message when this rule's
//                                   conditions match, regardless of which field(s) they check --
//                                   e.g. "IF status=resolved AND all_tasks_completed=false THEN
//                                   block: Complete all tasks before resolving." Unlike every other
//                                   action, it doesn't target a field (fieldStates has no natural
//                                   home for "stop the whole record"), so it's tracked as a
//                                   record-level flag instead of a per-field one.
import { db, uid } from '../db.js';
import { fieldOptionValues } from './ticketFields.js';
import { categoryNames } from './ticketCategories.js';

// Status is still a literal here: its values are process buckets the whole
// app queries by name, owned by Lifecycles rather than by Field Manager.
// Priority, impact and risk now come from ticket_field_options, and
// category from the taxonomy, so a rule's option list is whatever the admin
// actually configured rather than a second hardcoded copy of it.
const STATUS_OPTIONS = ['open', 'pending_approval', 'in_progress', 'on_hold', 'resolved', 'closed'];

// Every field's base (unfiltered) option list for a type -- built-in enums,
// Field Manager's select/multiselect custom fields, and (Request only) the
// live Service Catalog. This is what set_options/remove_options work against
// when no earlier action already narrowed a field's options.
export function buildFieldOptionsMap(workspaceId, ticketType) {
  const map = {
    status: [...STATUS_OPTIONS],
    priority: fieldOptionValues(workspaceId, 'priority'),
    impact: fieldOptionValues(workspaceId, 'impact'),
    risk: fieldOptionValues(workspaceId, 'risk'),
    category: categoryNames(workspaceId),
  };
  const customFields = db.prepare(
    'SELECT field_key, field_type, options FROM ticket_custom_fields WHERE workspace_id = ? AND ticket_type = ?'
  ).all(workspaceId, ticketType);
  for (const f of customFields) {
    if (f.field_type === 'select' || f.field_type === 'multiselect') {
      map[f.field_key] = JSON.parse(f.options || '[]');
    }
  }
  if (ticketType === 'request') {
    const items = db.prepare('SELECT name FROM catalog_items WHERE workspace_id = ? AND enabled = 1').all(workspaceId);
    map.catalog_item_name = items.map((i) => i.name);
  }
  return map;
}

export function listBusinessRules(workspaceId, ticketType) {
  const rows = db.prepare(
    'SELECT * FROM business_rules WHERE workspace_id = ? AND ticket_type = ? ORDER BY priority ASC, created_at ASC'
  ).all(workspaceId, ticketType);
  return rows.map(parseRule);
}

export function listAllBusinessRules(workspaceId) {
  const rows = db.prepare('SELECT * FROM business_rules WHERE workspace_id = ? ORDER BY ticket_type, priority ASC').all(workspaceId);
  return rows.map(parseRule);
}

function parseRule(row) {
  return { ...row, conditions: JSON.parse(row.conditions), actions: JSON.parse(row.actions) };
}

function matchCondition(actual, operator, expected) {
  const a = actual === undefined || actual === null ? '' : actual;
  switch (operator) {
    case 'equals':
      return String(a) === String(expected ?? '');
    case 'not_equals':
      return String(a) !== String(expected ?? '');
    case 'contains':
      return String(a).toLowerCase().includes(String(expected || '').toLowerCase());
    case 'greater_than': {
      const n1 = Number(a); const n2 = Number(expected);
      return !Number.isNaN(n1) && !Number.isNaN(n2) && n1 > n2;
    }
    case 'less_than': {
      const n1 = Number(a); const n2 = Number(expected);
      return !Number.isNaN(n1) && !Number.isNaN(n2) && n1 < n2;
    }
    case 'is_empty':
      return Array.isArray(a) ? a.length === 0 : String(a).trim() === '';
    case 'is_not_empty':
      return Array.isArray(a) ? a.length > 0 : String(a).trim() !== '';
    case 'in': // legacy-only operator, kept for rows migrated from the old engine
      return String(expected || '').split(',').map((s) => s.trim().toLowerCase()).includes(String(a).toLowerCase());
    default:
      return false;
  }
}

function conditionsMet(conditions, values) {
  const rules = conditions?.rules || [];
  if (!rules.length) return true;
  const results = rules.map((c) => matchCondition(values[c.field], c.operator, c.value));
  return conditions.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

function validateFormat(action, value) {
  const type = action.validation_type;
  if (!type || type === 'none' || value === undefined || value === null || value === '') return null;
  const str = String(value);
  switch (type) {
    case 'regex': {
      try {
        return new RegExp(action.validation_value).test(str) ? null : action.validation_message || `Field "${action.field}" does not match the required format.`;
      } catch { return null; }
    }
    case 'min_length':
      return str.length < Number(action.validation_value) ? action.validation_message || `Field "${action.field}" must be at least ${action.validation_value} characters.` : null;
    case 'max_length':
      return str.length > Number(action.validation_value) ? action.validation_message || `Field "${action.field}" must be at most ${action.validation_value} characters.` : null;
    case 'number_range': {
      const [min, max] = String(action.validation_value).split(',').map(Number);
      const num = Number(value);
      if (Number.isNaN(num) || (!Number.isNaN(min) && num < min) || (!Number.isNaN(max) && num > max)) {
        return action.validation_message || `Field "${action.field}" must be between ${min} and ${max}.`;
      }
      return null;
    }
    default:
      return null;
  }
}

// Runs every active rule (priority order) against `values`, applying actions
// as they match. `values` is mutated in place: set_value writes through so
// later (lower-priority-number... i.e. later-evaluated) rules can react to
// it, and the returned fieldStates reflect the final visible/required/
// options/autoValue per field touched by any rule.
export function evaluateBusinessRules(workspaceId, ticketType, values, fieldOptionsMap = {}) {
  const rules = listBusinessRules(workspaceId, ticketType).filter((r) => r.status === 'active');
  const fieldStates = {};
  // A field's `options` starts as its real base option list (Field Manager's
  // dropdown options, or a built-in enum) so remove_options has something
  // real to subtract from even if no set_options ran first.
  const stateFor = (field) => (fieldStates[field] ||= {
    visible: true, required: false,
    options: fieldOptionsMap[field] ? [...fieldOptionsMap[field]] : null,
  });

  // A field that any active rule conditionally shows is "governed" -- an
  // admin writing "IF category is not empty -> show subcategory" means
  // subcategory is hidden until that's true, not visible-by-default with an
  // optional extra show on top. So any field targeted by a show_field action
  // starts hidden here, *before* rules run, regardless of whether that
  // rule's condition currently matches -- only a rule that actually matches
  // can flip it back to visible. A field only ever hidden conditionally
  // (hide_field, no show_field) is unaffected and keeps defaulting visible,
  // same as a field with no rules at all.
  for (const rule of rules) {
    for (const action of rule.actions) {
      if (action.type === 'show_field') stateFor(action.field).visible = false;
    }
  }

  for (const rule of rules) {
    if (!conditionsMet(rule.conditions, values)) continue;
    for (const action of rule.actions) {
      if (action.type === 'block') {
        // First match wins, same as every other validation error this
        // function's caller surfaces -- record-level, not field-level, so it
        // lives on fieldStates itself rather than inside stateFor(field).
        if (!fieldStates.__blocked) fieldStates.__blocked = action.message || 'This change is not allowed right now.';
        continue;
      }
      const state = stateFor(action.field);
      switch (action.type) {
        case 'show_field':
          state.visible = true;
          break;
        case 'hide_field':
          state.visible = false;
          break;
        case 'mandate_field':
          state.required = true;
          break;
        case 'set_options':
          state.options = [...(action.options || [])];
          break;
        case 'remove_options': {
          const current = state.options !== null ? state.options : (fieldOptionsMap[action.field] || []);
          state.options = current.filter((o) => !(action.options || []).includes(o));
          break;
        }
        case 'set_value':
          state.autoValue = action.value;
          values[action.field] = action.value;
          break;
        case 'validate_field':
          state.validationError = validateFormat(action, values[action.field]);
          break;
        default:
          break;
      }
    }
  }
  return fieldStates;
}

// Server-side enforcement for ticket create/update. Mutates `values`
// in place (hides -> deletes the key, set_value -> writes through) and
// returns an error string or null. `partial: true` (PATCH) skips required
// checks since not every field is resubmitted.
export function applyBusinessRules(workspaceId, ticketType, values, fieldOptionsMap = {}, { partial = false } = {}) {
  const fieldStates = evaluateBusinessRules(workspaceId, ticketType, values, fieldOptionsMap);
  if (fieldStates.__blocked) return fieldStates.__blocked;
  for (const [field, state] of Object.entries(fieldStates)) {
    if (state.autoValue !== undefined) {
      values[field] = state.autoValue;
      continue; // an auto-populated field is always present -- no need for the checks below
    }
    if (!state.visible) {
      delete values[field];
      continue;
    }
    if (!partial && state.required) {
      const v = values[field];
      const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
      if (empty) return `Field "${field}" is required.`;
    }
    if (state.options && values[field] !== undefined && values[field] !== null && values[field] !== '') {
      const submitted = Array.isArray(values[field]) ? values[field] : [values[field]];
      const invalid = submitted.find((v) => !state.options.includes(v));
      if (invalid) return `"${invalid}" is not a valid option for "${field}".`;
    }
    if (state.validationError) return state.validationError;
  }
  return null;
}

export function createBusinessRule(workspaceId, ticketType, body) {
  const id = uid('brl');
  const { name, conditions = { logic: 'AND', rules: [] }, actions = [], priority = 100, status = 'active' } = body;
  db.prepare(
    'INSERT INTO business_rules (id, workspace_id, ticket_type, name, conditions, actions, priority, status) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, workspaceId, ticketType, name, JSON.stringify(conditions), JSON.stringify(actions), priority, status);
  return id;
}
