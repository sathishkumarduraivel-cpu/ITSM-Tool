import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Mirrors server/src/services/businessRules.js exactly, so the form behaves
// precisely like what will be enforced on submit -- no network round trip
// per keystroke, just the same interpreter run twice (client for live UX,
// server for the authoritative check).
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
      let re;
      try { re = new RegExp(action.validation_value); } catch { return null; }
      return re.test(str) ? null : action.validation_message || 'Does not match the required format.';
    }
    case 'min_length':
      return str.length < Number(action.validation_value) ? action.validation_message || `Must be at least ${action.validation_value} characters.` : null;
    case 'max_length':
      return str.length > Number(action.validation_value) ? action.validation_message || `Must be at most ${action.validation_value} characters.` : null;
    case 'number_range': {
      const [min, max] = String(action.validation_value).split(',').map(Number);
      const num = Number(value);
      if (Number.isNaN(num) || (!Number.isNaN(min) && num < min) || (!Number.isNaN(max) && num > max)) {
        return action.validation_message || `Must be between ${min} and ${max}.`;
      }
      return null;
    }
    default:
      return null;
  }
}

function evaluate(rules, values, fieldOptionsMap) {
  const fieldStates = {};
  const stateFor = (field) => (fieldStates[field] ||= {
    visible: true, required: false,
    options: fieldOptionsMap[field] ? [...fieldOptionsMap[field]] : null,
  });
  const working = { ...values }; // set_value writes here so later (lower-priority) rules can react to it

  for (const rule of rules) {
    if (rule.status !== 'active') continue;
    if (!conditionsMet(rule.conditions, working)) continue;
    for (const action of rule.actions) {
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
          working[action.field] = action.value;
          break;
        case 'validate_field':
          state.validationError = validateFormat(action, working[action.field]);
          break;
        default:
          break;
      }
    }
  }
  return fieldStates;
}

// Looks up admin-configured Business Rules for a ticket type and evaluates
// them against the live form/ticket object, exactly like the server will on
// submit. `formValues` should be the live form/ticket state so conditional
// rules react as the user fills the form in.
export function useBusinessRules(ticketType, formValues) {
  const [rules, setRules] = useState([]);
  const [fieldOptionsMap, setFieldOptionsMap] = useState({});

  useEffect(() => {
    if (!ticketType) { setRules([]); setFieldOptionsMap({}); return; }
    api.get(`/business-rules?ticket_type=${ticketType}`).then(({ rules }) => setRules(rules)).catch(() => setRules([]));
    api.get(`/business-rules/options?ticket_type=${ticketType}`).then(({ options }) => setFieldOptionsMap(options)).catch(() => setFieldOptionsMap({}));
  }, [ticketType]);

  const fieldStates = evaluate(rules, formValues || {}, fieldOptionsMap);
  const stateOf = (field) => fieldStates[field];

  return {
    isVisible: (field, defaultVisible = true) => stateOf(field)?.visible ?? defaultVisible,
    isRequired: (field, defaultRequired = false) => stateOf(field)?.required ?? defaultRequired,
    // Falls back to the field's real base options (fetched, not the caller's
    // guess) when no rule has touched it, so a select always has *something*
    // sensible to render even with zero rules configured.
    getOptions: (field, baseOptions) => stateOf(field)?.options ?? fieldOptionsMap[field] ?? baseOptions ?? null,
    getAutoValue: (field) => stateOf(field)?.autoValue,
    getError: (field) => stateOf(field)?.validationError ?? null,
  };
}
