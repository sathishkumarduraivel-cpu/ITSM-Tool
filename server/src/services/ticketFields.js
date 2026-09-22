// The registry of every field a ticket has, and what an admin is actually
// allowed to change about each one.
//
// This exists because "make the built-in fields editable" is not one
// question but several, with genuinely different answers:
//
//   * Impact and Risk are pure labels. Nothing downstream reads their
//     values, so they can be added to, removed, renamed, recoloured and
//     reordered freely.
//   * Priority looks identical in the UI but is not. Its four values are
//     load-bearing: the SLA fallback targets keyed off them
//     ({critical:240, high:480, ...} in routes/tickets.js and four other
//     call sites), escalationEngine.js's PRIORITY_RANK, and
//     majorIncidents.js's "critical is the floor" promotion rule. Adding
//     "Urgent" would silently get no SLA target and rank below "low". So
//     its value set is locked while its label and colour stay editable.
//   * Category and Subcategory are already real data with their own
//     taxonomy (services/ticketCategories.js).
//   * Status belongs to Lifecycles, whose stages map onto status buckets
//     the whole app queries; Group belongs to Groups. Editing either here
//     would be a second, competing source of truth.
//   * Title, description and the change-window fields have no options at
//     all.
//
// Encoding that as data means the UI can explain the constraint instead of
// silently ignoring an edit, and there is one place to revisit if, say,
// PRIORITY_RANK ever becomes data too.
import { db, uid } from '../db.js';

// Tailwind-ish tokens rather than raw hex, so an admin's choice cannot
// produce an unreadable pill in either light or dark mode -- the frontend
// maps each to a matched background/text pair.
export const COLORS = ['slate', 'sky', 'emerald', 'amber', 'orange', 'red', 'violet', 'cyan'];

const DEFAULT_OPTIONS = {
  priority: [
    { value: 'low', label: 'Low', color: 'sky' },
    { value: 'medium', label: 'Medium', color: 'amber' },
    { value: 'high', label: 'High', color: 'orange' },
    { value: 'critical', label: 'Critical', color: 'red' },
  ],
  impact: [
    { value: 'low', label: 'Low — one person', color: 'sky' },
    { value: 'medium', label: 'Medium — a team', color: 'amber' },
    { value: 'high', label: 'High — whole site', color: 'red' },
  ],
  risk: [
    { value: 'low', label: 'Low', color: 'emerald' },
    { value: 'medium', label: 'Medium', color: 'amber' },
    { value: 'high', label: 'High', color: 'red' },
  ],
};

// manage:
//   options  -- rows in ticket_field_options, edited here
//   taxonomy -- the category/subcategory taxonomy
//   external -- owned by another admin area; we link to it
//   none     -- a plain input, nothing to configure
export const FIELD_REGISTRY = {
  title: { label: 'Title', kind: 'text', manage: 'none', required: true, description: 'The one-line summary. Always present and always required.' },
  description: { label: 'Description', kind: 'textarea', manage: 'none', description: 'The detail box under the title.' },
  priority: {
    label: 'Priority', kind: 'enum', manage: 'options', valuesLocked: true,
    description: 'How urgently this needs attention.',
    lockedReason: 'The four priority values drive SLA targets, escalation ranking and major-incident promotion, so they cannot be added to or removed. You can rename them and change their colours.',
  },
  impact: {
    label: 'Impact', kind: 'enum', manage: 'options',
    description: 'How many people are affected. Fully editable — nothing downstream depends on these values.',
  },
  risk: {
    label: 'Risk', kind: 'enum', manage: 'options', types: ['change'],
    description: 'Change risk, used by the CAB. Fully editable.',
  },
  category: {
    label: 'Category', kind: 'taxonomy', manage: 'taxonomy',
    description: 'The top-level classification. Shared with the AI classifier.',
  },
  subcategory: {
    label: 'Subcategory', kind: 'taxonomy_child', manage: 'taxonomy', multi: true,
    description: 'Multi-select, and dependent on the chosen category.',
  },
  status: {
    label: 'Status', kind: 'enum', manage: 'external', managedBy: 'lifecycles',
    description: 'Where the ticket sits in its process.',
    externalReason: 'Statuses come from the ticket type\'s Lifecycle, whose stages map onto the open/resolved/closed buckets the rest of the app queries. Edit them there so both stay in step.',
  },
  team: {
    label: 'Group', kind: 'reference', manage: 'external', managedBy: 'groups',
    description: 'Which group owns the ticket.',
    externalReason: 'The list comes from your Groups, which also carry membership and permission grants.',
  },
  assignee_id: {
    label: 'Assigned to', kind: 'reference', manage: 'external', managedBy: 'assignmentPolicies',
    description: 'The individual owner.',
    externalReason: 'Who can be assigned comes from your agent roster; how tickets are routed automatically is configured under Assignment Policies.',
  },
  planned_start: { label: 'Planned start', kind: 'datetime', manage: 'none', types: ['change'], description: 'Start of the change window.' },
  planned_end: { label: 'Planned end', kind: 'datetime', manage: 'none', types: ['change'], description: 'End of the change window.' },
  rollback_plan: { label: 'Rollback plan', kind: 'textarea', manage: 'none', types: ['change'], description: 'How the change is backed out.' },
};

// Which built-in fields apply to which ticket type. A field with no `types`
// applies to all of them.
export function builtinFieldsFor(ticketType) {
  return Object.entries(FIELD_REGISTRY)
    .filter(([, meta]) => !meta.types || meta.types.includes(ticketType))
    .map(([key, meta]) => ({ key, ...meta }));
}

export function ensureDefaultFieldOptions(workspaceId) {
  for (const [fieldKey, defaults] of Object.entries(DEFAULT_OPTIONS)) {
    const { c } = db.prepare('SELECT COUNT(*) c FROM ticket_field_options WHERE workspace_id = ? AND field_key = ?')
      .get(workspaceId, fieldKey);
    if (c > 0) continue;
    defaults.forEach((opt, i) => {
      db.prepare(
        'INSERT INTO ticket_field_options (id, workspace_id, field_key, value, label, color, sort_order) VALUES (?,?,?,?,?,?,?)'
      ).run(uid('tfo'), workspaceId, fieldKey, opt.value, opt.label, opt.color, i);
    });
  }
}

export function listFieldOptions(workspaceId, fieldKey, { includeInactive = false } = {}) {
  ensureDefaultFieldOptions(workspaceId);
  return db.prepare(
    `SELECT * FROM ticket_field_options WHERE workspace_id = ? AND field_key = ?${includeInactive ? '' : ' AND active = 1'}
     ORDER BY sort_order ASC, label ASC`
  ).all(workspaceId, fieldKey);
}

// Plain value arrays, for the business-rules option map and for validation.
export function fieldOptionValues(workspaceId, fieldKey) {
  return listFieldOptions(workspaceId, fieldKey).map((o) => o.value);
}

export function allFieldOptions(workspaceId, { includeInactive = false } = {}) {
  ensureDefaultFieldOptions(workspaceId);
  const out = {};
  for (const fieldKey of Object.keys(DEFAULT_OPTIONS)) {
    out[fieldKey] = listFieldOptions(workspaceId, fieldKey, { includeInactive });
  }
  return out;
}

export const isManagedEnum = (fieldKey) => Object.prototype.hasOwnProperty.call(DEFAULT_OPTIONS, fieldKey);
export const valuesAreLocked = (fieldKey) => !!FIELD_REGISTRY[fieldKey]?.valuesLocked;

// A value is derived from the label rather than typed separately: admins
// think in labels, and a hand-entered value is just another thing to get
// wrong. Collisions are resolved by suffixing, so "High" twice cannot
// produce a duplicate key.
export function slugifyValue(label, existing = []) {
  const base = String(label).trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'option';
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}
