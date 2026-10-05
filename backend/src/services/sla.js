import { db } from '../db.js';

// Same condition vocabulary as services/businessRules.js -- one condition
// language across the app rather than an SLA-specific one. Each engine
// keeps its own copy of this small matcher (automationEngine.js,
// lifecycleEngine.js, catalog.js and businessRules.js all do too) rather
// than sharing one, which is this codebase's established convention.
function matchCondition(actual, operator, expected) {
  const a = actual === undefined || actual === null ? '' : actual;
  switch (operator) {
    case 'equals': return String(a) === String(expected ?? '');
    case 'not_equals': return String(a) !== String(expected ?? '');
    case 'contains': return String(a).toLowerCase().includes(String(expected || '').toLowerCase());
    case 'greater_than': { const n1 = Number(a); const n2 = Number(expected); return !Number.isNaN(n1) && !Number.isNaN(n2) && n1 > n2; }
    case 'less_than': { const n1 = Number(a); const n2 = Number(expected); return !Number.isNaN(n1) && !Number.isNaN(n2) && n1 < n2; }
    case 'is_empty': return String(a).trim() === '';
    case 'is_not_empty': return String(a).trim() !== '';
    default: return false;
  }
}

// Empty rule list = always matches -- this is what lets an admin define a
// catch-all/default policy (no conditions at all) and put it last in the
// evaluation order, same "no conditions -> always applies" semantic
// Business Rules already uses.
function conditionsMet(conditions, context) {
  const rules = conditions?.rules || [];
  if (!rules.length) return true;
  const results = rules.map((r) => matchCondition(context[r.field], r.operator, r.value));
  return conditions.logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

// A policy saved before the condition builder existed (or never re-saved
// since) has real values only in the legacy priority/category/team columns
// -- synthesize an equivalent conditions object from them on the fly so it
// evaluates identically and shows up pre-filled if an admin opens it in the
// new builder, without a migration script rewriting old rows.
function synthesizeConditionsFromLegacy(policy) {
  const rules = [];
  if (policy.priority) rules.push({ field: 'priority', operator: 'equals', value: policy.priority });
  if (policy.category) rules.push({ field: 'category', operator: 'equals', value: policy.category });
  if (policy.team) rules.push({ field: 'team', operator: 'equals', value: policy.team });
  return { logic: 'AND', rules };
}

export function resolveConditions(policy) {
  if (policy.conditions) {
    try { return JSON.parse(policy.conditions); } catch { /* fall through to legacy synthesis below */ }
  }
  return synthesizeConditionsFromLegacy(policy);
}

// Evaluated in explicit admin-controlled order (sort_order, then
// created_at as a stable tiebreak for policies nobody has reordered yet) --
// the FIRST policy whose conditions match wins, same "ordered rule list"
// mental model as an inbox filter, replacing the old "most specific field
// count wins" scoring. `context` is whatever ticket-shaped fields the
// caller has on hand (type/priority/category/subcategory/team/impact/risk/
// source/title/description) -- a condition referencing a field the caller
// didn't provide simply won't match on it, same as any other missing field.
export function findSlaPolicy(context) {
  const policies = db.prepare(
    'SELECT * FROM sla_policies WHERE workspace_id = ? AND enabled = 1 ORDER BY sort_order ASC, created_at ASC'
  ).all(context.workspaceId);
  for (const p of policies) {
    if (conditionsMet(resolveConditions(p), context)) return p;
  }
  return null;
}

// Persists whether a ticket has breached its resolution SLA. This app has no
// background scheduler, so -- same self-healing-on-read pattern already used
// by evaluateEscalationsSafely() -- this recomputes and (only if changed)
// writes sla_breached every time a ticket is fetched, rather than trying to
// catch the exact moment a still-open ticket crosses its due date. A ticket
// with no sla_due_at configured is never "breached" (nothing to measure
// against). A resolved/closed ticket is judged against when it actually
// finished; a still-open ticket already past its due date is breached right
// now, matching what the live /sla/at-risk view already computes on the fly
// -- this was previously never written anywhere, so every report/dashboard
// metric reading the stored column silently saw 0% breach rate always.
export function stampSlaBreach(ticket) {
  if (!ticket || !ticket.sla_due_at) return;
  const finished = ['resolved', 'closed'].includes(ticket.status) && (ticket.resolved_at || ticket.closed_at);
  const compareAt = finished || new Date().toISOString();
  const breached = new Date(compareAt) > new Date(ticket.sla_due_at) ? 1 : 0;
  if (breached !== ticket.sla_breached) {
    db.prepare('UPDATE tickets SET sla_breached = ? WHERE id = ?').run(breached, ticket.id);
    ticket.sla_breached = breached;
  }
}

function getBusinessHours(workspaceId) {
  const rows = db.prepare('SELECT * FROM business_hours WHERE workspace_id = ?').all(workspaceId);
  if (rows.length) return rows;
  // Default: Mon-Fri 09:00-17:00 if nothing configured
  return [1, 2, 3, 4, 5].map((d) => ({ day_of_week: d, start_time: '09:00', end_time: '17:00' }));
}

function parseTime(t) {
  const [h, m] = t.split(':').map(Number);
  return { h, m };
}

// Adds `minutes` of business time to `from`, honoring configured business_hours.
// Falls back to plain calendar-time addition when businessHoursOnly is false.
export function computeSlaDueDate(minutes, businessHoursOnly, from = new Date(), workspaceId = null) {
  if (!businessHoursOnly) {
    return new Date(from.getTime() + minutes * 60000).toISOString();
  }
  const hours = getBusinessHours(workspaceId);
  const byDay = new Map(hours.map((h) => [h.day_of_week, h]));
  let cursor = new Date(from);
  let remaining = minutes;
  let guard = 0;
  while (remaining > 0 && guard < 10000) {
    guard += 1;
    const day = cursor.getDay();
    const window = byDay.get(day);
    if (!window) {
      // non-business day — jump to next day 00:00
      cursor = new Date(cursor);
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const start = parseTime(window.start_time);
    const end = parseTime(window.end_time);
    const dayStart = new Date(cursor); dayStart.setHours(start.h, start.m, 0, 0);
    const dayEnd = new Date(cursor); dayEnd.setHours(end.h, end.m, 0, 0);

    if (cursor < dayStart) cursor = dayStart;
    if (cursor >= dayEnd) {
      cursor = new Date(cursor);
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const availableMinutesToday = (dayEnd.getTime() - cursor.getTime()) / 60000;
    if (remaining <= availableMinutesToday) {
      cursor = new Date(cursor.getTime() + remaining * 60000);
      remaining = 0;
    } else {
      remaining -= availableMinutesToday;
      cursor = new Date(cursor);
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
    }
  }
  return cursor.toISOString();
}
