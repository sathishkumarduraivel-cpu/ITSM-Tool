import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// A rule with no condition_field always applies. Otherwise it only applies
// when the referenced field's current live value on the form satisfies the
// configured comparison — mirrors the server's applyFieldRules so the form
// behaves exactly like what will actually be enforced on submit.
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

function validationError(rule, value) {
  const type = rule.validation_type;
  if (!type || type === 'none' || value === undefined || value === null || value === '') return null;
  const str = String(value);
  switch (type) {
    case 'regex': {
      let re;
      try {
        re = new RegExp(rule.validation_value);
      } catch {
        return null;
      }
      return re.test(str) ? null : rule.validation_message || 'Does not match the required format.';
    }
    case 'min_length':
      return str.length < Number(rule.validation_value)
        ? rule.validation_message || `Must be at least ${rule.validation_value} characters.`
        : null;
    case 'max_length':
      return str.length > Number(rule.validation_value)
        ? rule.validation_message || `Must be at most ${rule.validation_value} characters.`
        : null;
    case 'number_range': {
      const [min, max] = String(rule.validation_value).split(',').map(Number);
      const num = Number(value);
      if (Number.isNaN(num) || (!Number.isNaN(min) && num < min) || (!Number.isNaN(max) && num > max)) {
        return rule.validation_message || `Must be between ${min} and ${max}.`;
      }
      return null;
    }
    default:
      return null;
  }
}

// Looks up admin-configured business rules for a ticket type/category:
// visibility/requirement, optionally gated by a condition on another live
// field's value, plus optional format validation. When no rule exists (or
// its condition isn't currently met) for a given field, isVisible/isRequired
// fall back to the provided default so existing hardcoded form behavior is
// unaffected until an admin actually configures something. `formValues`
// should be the live form/ticket object so conditional rules can react as
// the user fills the form in.
export function useFieldRules(ticketType, category, formValues) {
  const [rules, setRules] = useState([]);

  useEffect(() => {
    if (!ticketType) return;
    const params = new URLSearchParams({ ticket_type: ticketType });
    if (category) params.set('category', category);
    api.get(`/field-rules?${params.toString()}`).then(({ rules }) => setRules(rules)).catch(() => setRules([]));
  }, [ticketType, category]);

  const ruleFor = (fieldName) => rules.find((r) => r.field_name === fieldName && conditionMet(r, formValues));

  return {
    isVisible: (fieldName, defaultVisible = true) => {
      const rule = ruleFor(fieldName);
      return rule ? !!rule.visible : defaultVisible;
    },
    isRequired: (fieldName, defaultRequired = false) => {
      const rule = ruleFor(fieldName);
      return rule ? !!rule.required : defaultRequired;
    },
    getError: (fieldName, value) => {
      const rule = ruleFor(fieldName);
      return rule ? validationError(rule, value) : null;
    },
  };
}
