import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Looks up admin-configured field visibility/requirement rules for a ticket
// type/category. When no rule exists for a given field, `isVisible`/`isRequired`
// fall back to the provided default so existing hardcoded form behavior is
// unaffected until an admin actually configures something.
export function useFieldRules(ticketType, category) {
  const [rules, setRules] = useState([]);

  useEffect(() => {
    if (!ticketType) return;
    const params = new URLSearchParams({ ticket_type: ticketType });
    if (category) params.set('category', category);
    api.get(`/field-rules?${params.toString()}`).then(({ rules }) => setRules(rules)).catch(() => setRules([]));
  }, [ticketType, category]);

  const ruleFor = (fieldName) => rules.find((r) => r.field_name === fieldName);

  return {
    isVisible: (fieldName, defaultVisible = true) => {
      const rule = ruleFor(fieldName);
      return rule ? !!rule.visible : defaultVisible;
    },
    isRequired: (fieldName, defaultRequired = false) => {
      const rule = ruleFor(fieldName);
      return rule ? !!rule.required : defaultRequired;
    },
  };
}
