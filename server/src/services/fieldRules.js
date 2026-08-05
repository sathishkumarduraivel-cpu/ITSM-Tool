// Admin-configurable per-ticket-type/category field visibility & requirement
// rules. When no rules exist for a type/category, everything is a no-op so
// the app's existing hardcoded field behavior (e.g. the `isChange` branches
// in the frontend) keeps working unchanged until an admin configures rules.
import { db } from '../db.js';

export function listFieldRules(ticketType, category) {
  return db.prepare(
    `SELECT * FROM ticket_field_rules
     WHERE ticket_type = ? AND (category IS NULL OR category = ?)
     ORDER BY sort_order, field_name`
  ).all(ticketType, category || null);
}

// Mutates `body` to drop values for hidden fields; returns an error string if
// a required field is missing (null if valid). `partial: true` (used on
// PATCH) skips the required-field check since not every field is resubmitted.
export function applyFieldRules(ticketType, category, body, { partial = false } = {}) {
  const rules = listFieldRules(ticketType, category);
  if (!rules.length) return null;
  for (const rule of rules) {
    if (!rule.visible && body[rule.field_name] !== undefined) {
      delete body[rule.field_name];
    }
    if (!partial && rule.required && rule.visible) {
      const val = body[rule.field_name];
      if (val === undefined || val === null || val === '') {
        return `Field "${rule.field_name}" is required for this ticket type/category.`;
      }
    }
  }
  return null;
}
