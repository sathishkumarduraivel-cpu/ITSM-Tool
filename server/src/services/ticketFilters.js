/**
 * An AND/OR condition tree, compiled to SQL (§21).
 *
 * Everything here exists to make one guarantee: no value a client sends ever
 * reaches the query as SQL. Column names come from the allowlist below and
 * nowhere else; every value goes in as a bound parameter. A filter builder
 * that interpolates is the classic way an "advanced search" becomes an
 * arbitrary read of the database.
 */

export class FilterError extends Error {
  constructor(message, status = 400, field_errors) {
    super(message);
    this.status = status;
    if (field_errors) this.field_errors = field_errors;
  }
}

// A rule can only name a field from here, and only use an operator its type
// allows. `column` is the SQL expression — always a literal from this file.
export const FILTER_FIELDS = {
  number: { label: 'Ticket number', column: 't.number', type: 'text' },
  title: { label: 'Title', column: 't.title', type: 'text' },
  description: { label: 'Description', column: 't.description', type: 'text' },
  status: { label: 'Status', column: 't.status', type: 'enum' },
  priority: { label: 'Priority', column: 't.priority', type: 'enum' },
  type: { label: 'Ticket type', column: 't.type', type: 'enum' },
  impact: { label: 'Impact', column: 't.impact', type: 'enum' },
  urgency: { label: 'Urgency', column: 't.urgency', type: 'enum' },
  category: { label: 'Category', column: 't.category', type: 'enum' },
  subcategory: { label: 'Subcategory', column: 't.subcategory', type: 'text' },
  team: { label: 'Group', column: 't.team', type: 'enum' },
  source: { label: 'Source', column: 't.source', type: 'enum' },
  assignee_id: { label: 'Assignee', column: 't.assignee_id', type: 'user' },
  requester_id: { label: 'Requester', column: 't.requester_id', type: 'user' },
  created_at: { label: 'Created', column: 't.created_at', type: 'date' },
  updated_at: { label: 'Last updated', column: 't.updated_at', type: 'date' },
  resolved_at: { label: 'Resolved', column: 't.resolved_at', type: 'date' },
  sla_due_at: { label: 'SLA due', column: 't.sla_due_at', type: 'date' },
  sla_breached: { label: 'SLA breached', column: 't.sla_breached', type: 'boolean' },
  response_breached: { label: 'Response breached', column: 't.response_breached', type: 'boolean' },
  reopened_count: { label: 'Times reopened', column: 't.reopened_count', type: 'number' },
  pending_reason: { label: 'Pending reason', column: 't.pending_reason', type: 'enum' },
  resolution_code: { label: 'Resolution code', column: 't.resolution_code', type: 'enum' },
  closure_code: { label: 'Closure code', column: 't.closure_code', type: 'enum' },
  problem_state: { label: 'Problem state', column: 't.problem_state', type: 'enum' },
  is_known_error: { label: 'Known error', column: 't.is_known_error', type: 'boolean' },
  change_state: { label: 'Change state', column: 't.change_state', type: 'enum' },
  change_type: { label: 'Change type', column: 't.change_type', type: 'enum' },
  risk_band: { label: 'Risk band', column: 't.risk_band', type: 'enum' },
};

const OPERATORS = {
  text: ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'is_empty', 'is_not_empty'],
  enum: ['equals', 'not_equals', 'in', 'not_in', 'is_empty', 'is_not_empty'],
  user: ['equals', 'not_equals', 'in', 'is_me', 'is_not_me', 'is_empty', 'is_not_empty'],
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'between', 'is_empty', 'is_not_empty'],
  date: ['before', 'after', 'between', 'in_last_days', 'in_next_days', 'is_empty', 'is_not_empty'],
  boolean: ['is_true', 'is_false'],
};

export const OPERATOR_LABELS = {
  equals: 'is', not_equals: 'is not', contains: 'contains', not_contains: 'does not contain',
  starts_with: 'starts with', in: 'is any of', not_in: 'is none of',
  is_empty: 'is empty', is_not_empty: 'is not empty',
  greater_than: 'is more than', less_than: 'is less than', between: 'is between',
  before: 'is before', after: 'is after', in_last_days: 'in the last (days)',
  in_next_days: 'in the next (days)', is_true: 'is yes', is_false: 'is no',
  is_me: 'is me', is_not_me: 'is not me',
};

// Guards against a tree that is expensive to compile or to run. Nobody builds
// a legitimate filter ten groups deep; a malicious one is cheap to send.
const MAX_DEPTH = 5;
const MAX_RULES = 40;

const needsNoValue = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false', 'is_me', 'is_not_me']);

function compileRule(rule, ctx) {
  const field = FILTER_FIELDS[rule.field];
  if (!field) {
    throw new FilterError(`Unknown field: ${rule.field}`, 400, [{ field: 'field', message: 'Not a field you can filter on' }]);
  }
  const allowed = OPERATORS[field.type];
  if (!allowed.includes(rule.op)) {
    throw new FilterError(
      `"${OPERATOR_LABELS[rule.op] || rule.op}" cannot be used with ${field.label}.`,
      400, [{ field: 'op', message: `Try one of: ${allowed.join(', ')}` }]
    );
  }
  const col = field.column;
  const v = rule.value;

  if (!needsNoValue.has(rule.op) && (v === undefined || v === null || v === '')) {
    throw new FilterError(`${field.label} needs a value.`, 400, [{ field: 'value', message: 'Required' }]);
  }

  switch (rule.op) {
    case 'equals': return { sql: `${col} = ?`, params: [v] };
    case 'not_equals':
      // NULL is not "not equal" to anything in SQL, so a row with no value
      // would vanish from a "is not X" filter -- which reads as data loss.
      return { sql: `(${col} IS NULL OR ${col} != ?)`, params: [v] };
    case 'contains': return { sql: `${col} LIKE ?`, params: [`%${v}%`] };
    case 'not_contains': return { sql: `(${col} IS NULL OR ${col} NOT LIKE ?)`, params: [`%${v}%`] };
    case 'starts_with': return { sql: `${col} LIKE ?`, params: [`${v}%`] };
    case 'is_empty': return { sql: `(${col} IS NULL OR ${col} = '')`, params: [] };
    case 'is_not_empty': return { sql: `(${col} IS NOT NULL AND ${col} != '')`, params: [] };
    case 'in':
    case 'not_in': {
      const list = Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined && x !== '') : [v];
      if (!list.length) throw new FilterError(`${field.label} needs at least one value.`, 400, [{ field: 'value', message: 'Pick at least one' }]);
      if (list.length > 50) throw new FilterError(`${field.label} has too many values.`, 400, [{ field: 'value', message: 'At most 50' }]);
      const marks = list.map(() => '?').join(',');
      return rule.op === 'in'
        ? { sql: `${col} IN (${marks})`, params: list }
        : { sql: `(${col} IS NULL OR ${col} NOT IN (${marks}))`, params: list };
    }
    case 'is_me': return { sql: `${col} = ?`, params: [ctx.userId] };
    case 'is_not_me': return { sql: `(${col} IS NULL OR ${col} != ?)`, params: [ctx.userId] };
    case 'greater_than': return { sql: `CAST(${col} AS REAL) > ?`, params: [Number(v)] };
    case 'less_than': return { sql: `CAST(${col} AS REAL) < ?`, params: [Number(v)] };
    case 'between': {
      const [a, b] = Array.isArray(v) ? v : String(v).split(',');
      if (a === undefined || b === undefined || a === '' || b === '') {
        throw new FilterError(`${field.label} needs both ends of the range.`, 400, [{ field: 'value', message: 'Give both values' }]);
      }
      return field.type === 'date'
        // datetime() on both sides: stored timestamps mix ISO ("T") and
        // SQLite ("space") formats, and comparing them as plain strings is
        // wrong for anything on the same day.
        ? { sql: `datetime(${col}) BETWEEN datetime(?) AND datetime(?)`, params: [a, b] }
        : { sql: `CAST(${col} AS REAL) BETWEEN ? AND ?`, params: [Number(a), Number(b)] };
    }
    case 'before': return { sql: `datetime(${col}) < datetime(?)`, params: [v] };
    case 'after': return { sql: `datetime(${col}) > datetime(?)`, params: [v] };
    case 'in_last_days': {
      const days = Math.min(3650, Math.max(1, Number(v) || 1));
      return { sql: `datetime(${col}) >= datetime('now', ?)`, params: [`-${days} days`] };
    }
    case 'in_next_days': {
      const days = Math.min(3650, Math.max(1, Number(v) || 1));
      return { sql: `datetime(${col}) BETWEEN datetime('now') AND datetime('now', ?)`, params: [`+${days} days`] };
    }
    case 'is_true': return { sql: `COALESCE(${col}, 0) = 1`, params: [] };
    case 'is_false': return { sql: `COALESCE(${col}, 0) = 0`, params: [] };
    default:
      throw new FilterError(`Unknown operator: ${rule.op}`, 400);
  }
}

function compileGroup(group, ctx, depth = 0) {
  if (depth > MAX_DEPTH) throw new FilterError('That filter is nested too deeply.', 400);
  const logic = String(group?.logic || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';
  const rules = Array.isArray(group?.rules) ? group.rules : [];
  if (!rules.length) return null;

  const parts = [];
  const params = [];
  for (const rule of rules) {
    ctx.count += 1;
    if (ctx.count > MAX_RULES) throw new FilterError(`A filter can have at most ${MAX_RULES} conditions.`, 400);
    // A nested object with its own rules is a group; anything else is a rule.
    const compiled = Array.isArray(rule?.rules) ? compileGroup(rule, ctx, depth + 1) : compileRule(rule, ctx);
    if (compiled) { parts.push(compiled.sql); params.push(...compiled.params); }
  }
  if (!parts.length) return null;
  return { sql: `(${parts.join(` ${logic} `)})`, params };
}

/**
 * Turn a filter tree into a WHERE fragment.
 *
 * Returns null for an empty filter rather than a clause that matches
 * everything, so the caller can leave its query untouched.
 */
export function compileFilters(tree, { userId } = {}) {
  if (!tree) return null;
  return compileGroup(tree, { userId, count: 0 });
}

// Validated by compiling it: if it produces SQL it is a filter this app can
// actually run, which is a stronger check than inspecting it field by field.
export function validateFilters(tree, { userId } = {}) {
  compileFilters(tree, { userId: userId || 'validation' });
  return tree;
}

const SORTABLE = new Set([
  'created_at', 'updated_at', 'resolved_at', 'sla_due_at', 'priority', 'status', 'number', 'title', 'team',
]);

// Sorting is interpolated, so it comes from the allowlist and nowhere else.
export function compileSort(sortBy, sortDir) {
  const col = SORTABLE.has(sortBy) ? sortBy : 'created_at';
  const dir = String(sortDir || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  // Priority is a word, not a number, so sorting it alphabetically puts
  // "critical" between "medium" and "low" -- which is not an ordering anyone
  // means when they ask for "most urgent first".
  if (col === 'priority') {
    return `CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ${dir === 'DESC' ? 'ASC' : 'DESC'}`;
  }
  return `t.${col} ${dir}`;
}

export function filterMeta() {
  return {
    fields: Object.entries(FILTER_FIELDS).map(([key, f]) => ({
      key, label: f.label, type: f.type, operators: OPERATORS[f.type],
    })),
    operators: OPERATOR_LABELS,
    sortable: [...SORTABLE],
    limits: { max_depth: MAX_DEPTH, max_rules: MAX_RULES },
  };
}
