// Admin-configurable per-ticket-type/category business rules for form
// fields. Each rule always carries the original visibility/requirement
// flags, and may optionally add two more layers:
//  - a CONDITION that gates whether the rule applies at all, based on
//    another field's live value (e.g. only require "Asset Tag" when
//    category = "Hardware") — rules with no condition_field always apply,
//    matching the original static behavior.
//  - a VALIDATION format check (regex / length / numeric range) enforced
//    once the field is visible and filled in.
// When no rules exist for a type/category, everything is a no-op so the
// app's existing hardcoded field behavior (e.g. the `isChange` branches in
// the frontend) keeps working unchanged until an admin configures rules.
import { db } from '../db.js';

export function listFieldRules(workspaceId, ticketType, category) {
  return db.prepare(
    `SELECT * FROM ticket_field_rules
     WHERE workspace_id = ? AND ticket_type = ? AND (category IS NULL OR category = ?)
     ORDER BY sort_order, field_name`
  ).all(workspaceId, ticketType, category || null);
}

// A rule with no condition_field always applies (the original behavior).
// Otherwise it only applies when the referenced field's current value on
// the ticket/form being evaluated satisfies the configured comparison.
function conditionMet(rule, values) {
  if (!rule.condition_field) return true;
  const actual = values ? values[rule.condition_field] : undefined;
  const expected = rule.condition_value;
  switch (rule.condition_op) {
    case 'equals':
      return String(actual ?? '') === String(expected ?? '');
    case 'not_equals':
      return String(actual ?? '') !== String(expected ?? '');
    case 'contains':
      return String(actual || '').toLowerCase().includes(String(expected || '').toLowerCase());
    case 'in':
      return String(expected || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .includes(String(actual || '').toLowerCase());
    default:
      return true;
  }
}

// Returns an error string if `value` fails the rule's validation, or null.
// An unset/empty value is never a validation failure here — that's the
// required-field check's job, so a field can be optional but still
// format-checked when the user does fill it in.
function validateValue(rule, value) {
  const type = rule.validation_type;
  if (!type || type === 'none' || value === undefined || value === null || value === '') return null;
  const str = String(value);
  switch (type) {
    case 'regex': {
      let re;
      try {
        re = new RegExp(rule.validation_value);
      } catch {
        return null; // misconfigured pattern — don't block submissions over it
      }
      return re.test(str) ? null : rule.validation_message || `Field "${rule.field_name}" does not match the required format.`;
    }
    case 'min_length':
      return str.length < Number(rule.validation_value)
        ? rule.validation_message || `Field "${rule.field_name}" must be at least ${rule.validation_value} characters.`
        : null;
    case 'max_length':
      return str.length > Number(rule.validation_value)
        ? rule.validation_message || `Field "${rule.field_name}" must be at most ${rule.validation_value} characters.`
        : null;
    case 'number_range': {
      const [min, max] = String(rule.validation_value).split(',').map(Number);
      const num = Number(value);
      if (Number.isNaN(num) || (!Number.isNaN(min) && num < min) || (!Number.isNaN(max) && num > max)) {
        return rule.validation_message || `Field "${rule.field_name}" must be between ${min} and ${max}.`;
      }
      return null;
    }
    default:
      return null;
  }
}

// Mutates `body` to drop values for hidden fields; returns an error string if
// a required field is missing or fails validation (null if valid). Rules
// gated by a condition that isn't met against `body` are skipped entirely.
// `partial: true` (used on PATCH) skips the required-field check since not
// every field is resubmitted.
export function applyFieldRules(workspaceId, ticketType, category, body, { partial = false } = {}) {
  const rules = listFieldRules(workspaceId, ticketType, category);
  if (!rules.length) return null;
  // Conditions always evaluate against what was actually submitted, not
  // against `body` as it's progressively edited below — otherwise an earlier
  // rule hiding field A would blind a later rule's condition on field A.
  const submitted = { ...body };
  for (const rule of rules) {
    if (!conditionMet(rule, submitted)) continue;
    if (!rule.visible && body[rule.field_name] !== undefined) {
      delete body[rule.field_name];
      continue;
    }
    if (!rule.visible) continue;
    const val = body[rule.field_name];
    if (!partial && rule.required) {
      if (val === undefined || val === null || val === '') {
        return `Field "${rule.field_name}" is required for this ticket type/category.`;
      }
    }
    const validationError = validateValue(rule, val);
    if (validationError) return validationError;
  }
  return null;
}
