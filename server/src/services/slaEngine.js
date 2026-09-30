import { db, uid } from '../db.js';
import { computeSlaDueDate, findSlaPolicy } from './sla.js';

export class SlaError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_THRESHOLDS = [50, 75, 90];

// States where the clock is not the desk's to answer for. Configurable per
// policy; this is the fallback for policies that say nothing.
const DEFAULT_PAUSE_STATUSES = ['on_hold', 'pending_approval'];

const parseJson = (raw, fallback) => {
  if (!raw) return fallback;
  try { const v = JSON.parse(raw); return v ?? fallback; } catch { return fallback; }
};

export const thresholdsFor = (policy) => {
  const list = parseJson(policy?.warning_thresholds, DEFAULT_THRESHOLDS)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0 && n < 100);
  return [...new Set(list)].sort((a, b) => a - b);
};

export const pauseStatusesFor = (policy) => parseJson(policy?.pause_on_statuses, DEFAULT_PAUSE_STATUSES);

// ---- calendar ------------------------------------------------------------

function holidaySet(workspaceId) {
  const rows = db.prepare('SELECT date, recurs_annually FROM business_holidays WHERE workspace_id = ?').all(workspaceId);
  const exact = new Set();
  const annual = new Set();
  for (const r of rows) {
    exact.add(r.date);
    // A recurring holiday is matched on month-day, so one row covers every
    // year rather than needing a new row each December.
    if (r.recurs_annually) annual.add(String(r.date).slice(5));
  }
  return { exact, annual };
}

const isoDate = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export function isHoliday(workspaceId, date, cache) {
  const { exact, annual } = cache || holidaySet(workspaceId);
  const key = isoDate(date);
  return exact.has(key) || annual.has(key.slice(5));
}

function businessWindows(workspaceId) {
  const rows = db.prepare('SELECT * FROM business_hours WHERE workspace_id = ?').all(workspaceId);
  const list = rows.length ? rows : [1, 2, 3, 4, 5].map((d) => ({ day_of_week: d, start_time: '09:00', end_time: '17:00' }));
  return new Map(list.map((h) => [h.day_of_week, h]));
}

const parseTime = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return { h: h || 0, m: m || 0 };
};

/**
 * Minutes of working time between two instants.
 *
 * This is the primitive the whole engine rests on. "How long has this been
 * open" is a different number from "how long have we had to work on it", and
 * reporting the first while promising against the second is why SLA figures
 * so often fail to match anyone's experience of the week.
 */
export function businessMinutesBetween(from, to, workspaceId, businessHoursOnly = true) {
  const start = from instanceof Date ? from : new Date(from);
  const end = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;
  if (!businessHoursOnly) return Math.round((end - start) / 60000);

  const byDay = businessWindows(workspaceId);
  const holidays = holidaySet(workspaceId);
  let total = 0;
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  let guard = 0;

  while (cursor <= end && guard < 4000) {
    guard += 1;
    const window = byDay.get(cursor.getDay());
    if (window && !isHoliday(workspaceId, cursor, holidays)) {
      const s = parseTime(window.start_time);
      const e = parseTime(window.end_time);
      const dayStart = new Date(cursor); dayStart.setHours(s.h, s.m, 0, 0);
      const dayEnd = new Date(cursor); dayEnd.setHours(e.h, e.m, 0, 0);
      // Only the part of this day's window that falls inside [start, end].
      const from2 = start > dayStart ? start : dayStart;
      const to2 = end < dayEnd ? end : dayEnd;
      if (to2 > from2) total += (to2 - from2) / 60000;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return Math.round(total);
}

// Business-hours-aware date arithmetic that also skips holidays. The older
// computeSlaDueDate honours business hours but not holidays, so it is used
// only when there are none configured -- keeping every existing target
// exactly where it was for workspaces that never set a holiday.
export function addBusinessMinutes(minutes, from, workspaceId, businessHoursOnly = true) {
  if (!businessHoursOnly) return new Date(new Date(from).getTime() + minutes * 60000).toISOString();
  const holidays = holidaySet(workspaceId);
  if (!holidays.exact.size && !holidays.annual.size) {
    return computeSlaDueDate(minutes, true, new Date(from), workspaceId);
  }
  const byDay = businessWindows(workspaceId);
  let cursor = new Date(from);
  let remaining = minutes;
  let guard = 0;
  while (remaining > 0 && guard < 10000) {
    guard += 1;
    const window = byDay.get(cursor.getDay());
    if (!window || isHoliday(workspaceId, cursor, holidays)) {
      cursor = new Date(cursor); cursor.setDate(cursor.getDate() + 1); cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const s = parseTime(window.start_time);
    const e = parseTime(window.end_time);
    const dayStart = new Date(cursor); dayStart.setHours(s.h, s.m, 0, 0);
    const dayEnd = new Date(cursor); dayEnd.setHours(e.h, e.m, 0, 0);
    if (cursor < dayStart) cursor = dayStart;
    if (cursor >= dayEnd) {
      cursor = new Date(cursor); cursor.setDate(cursor.getDate() + 1); cursor.setHours(0, 0, 0, 0);
      continue;
    }
    const available = (dayEnd - cursor) / 60000;
    if (remaining <= available) { cursor = new Date(cursor.getTime() + remaining * 60000); remaining = 0; }
    else { remaining -= available; cursor = new Date(cursor); cursor.setDate(cursor.getDate() + 1); cursor.setHours(0, 0, 0, 0); }
  }
  return cursor.toISOString();
}

const event = (ticket, kind, extra = {}) => db.prepare(
  'INSERT INTO ticket_sla_events (id, workspace_id, ticket_id, kind, target, threshold, reason) VALUES (?,?,?,?,?,?,?)'
).run(uid('sev'), ticket.workspace_id, ticket.id, kind, extra.target || null, extra.threshold ?? null, extra.reason || null);

export const listSlaEvents = (workspaceId, ticketId) => db.prepare(
  'SELECT * FROM ticket_sla_events WHERE ticket_id = ? AND workspace_id = ? ORDER BY at ASC'
).all(ticketId, workspaceId);

const policyFor = (ticket) => (ticket.sla_policy_id
  ? db.prepare('SELECT * FROM sla_policies WHERE id = ?').get(ticket.sla_policy_id)
  : null);

// ---- pause and resume ----------------------------------------------------

export function shouldPause(ticket, policy, status = ticket.status) {
  return pauseStatusesFor(policy).includes(status);
}

/**
 * Stop the clock.
 *
 * Only the moment is recorded here, not an adjustment: how long the pause
 * lasted is not known until it ends, and guessing at it would have to be
 * unwound.
 */
export function pauseSla(ticket, reason) {
  if (ticket.sla_paused_at) return ticket;
  if (['resolved', 'closed'].includes(ticket.status)) return ticket;
  const at = new Date().toISOString();
  db.prepare("UPDATE tickets SET sla_paused_at = ?, sla_pause_reason = ? WHERE id = ?").run(at, reason || null, ticket.id);
  event(ticket, 'paused', { reason });
  return { ...ticket, sla_paused_at: at, sla_pause_reason: reason || null };
}

/**
 * Start it again, and push the targets out by exactly what the wait cost.
 *
 * Shifting the due dates (rather than only accumulating a paused total) is
 * what makes every existing query right without changing: the at-risk view,
 * escalation, breach stamping and reporting all read sla_due_at, and they all
 * become correct for free.
 */
export function resumeSla(ticket) {
  if (!ticket.sla_paused_at) return ticket;
  const policy = policyFor(ticket);
  const businessOnly = policy ? !!policy.business_hours_only : false;
  const pausedMinutes = businessMinutesBetween(ticket.sla_paused_at, new Date(), ticket.workspace_id, businessOnly);

  const shift = (due) => (due && pausedMinutes > 0
    ? addBusinessMinutes(pausedMinutes, new Date(due), ticket.workspace_id, businessOnly)
    : due);

  const next = {
    sla_due_at: shift(ticket.sla_due_at),
    response_due_at: shift(ticket.response_due_at),
    ola_due_at: shift(ticket.ola_due_at),
    ola_response_due_at: shift(ticket.ola_response_due_at),
    sla_paused_minutes: (ticket.sla_paused_minutes || 0) + pausedMinutes,
  };
  db.prepare(
    `UPDATE tickets SET sla_paused_at = NULL, sla_pause_reason = NULL, sla_paused_minutes = ?,
       sla_due_at = ?, response_due_at = ?, ola_due_at = ?, ola_response_due_at = ? WHERE id = ?`
  ).run(next.sla_paused_minutes, next.sla_due_at, next.response_due_at, next.ola_due_at, next.ola_response_due_at, ticket.id);
  event(ticket, 'resumed', { reason: `Paused for ${pausedMinutes} working minute(s); targets moved out by the same` });
  return { ...ticket, ...next, sla_paused_at: null, sla_pause_reason: null };
}

// Applies whichever of the two a status change calls for. Called from the
// ticket update path, so the clock follows the ticket rather than needing
// anyone to remember.
export function syncPauseState(ticket, nextStatus) {
  const policy = policyFor(ticket);
  const wasPaused = !!ticket.sla_paused_at;
  const shouldNow = shouldPause(ticket, policy, nextStatus) && !['resolved', 'closed'].includes(nextStatus);
  if (shouldNow && !wasPaused) return pauseSla(ticket, `Status became ${nextStatus}`);
  if (!shouldNow && wasPaused) return resumeSla(ticket);
  return ticket;
}

// ---- targets -------------------------------------------------------------

// Recomputed from when the ticket was raised, because a ticket regraded to
// critical should have had the critical target all along -- measuring it from
// the moment somebody noticed would reward noticing late.
export function recalculateTargets(ticket, reason) {
  const policy = findSlaPolicy({
    workspaceId: ticket.workspace_id, type: ticket.type, priority: ticket.priority,
    category: ticket.category, subcategory: ticket.subcategory, team: ticket.team,
    impact: ticket.impact, risk: ticket.risk, source: ticket.source,
    title: ticket.title, description: ticket.description,
  });
  if (!policy) return ticket;
  const businessOnly = !!policy.business_hours_only;
  const from = new Date(ticket.created_at);
  const paused = ticket.sla_paused_minutes || 0;

  const target = (minutes) => (minutes == null ? null
    : addBusinessMinutes(Number(minutes) + paused, from, ticket.workspace_id, businessOnly));

  const next = {
    sla_policy_id: policy.id,
    sla_due_at: target(policy.resolution_minutes),
    response_due_at: target(policy.response_minutes),
    ola_due_at: target(policy.ola_resolution_minutes),
    ola_response_due_at: target(policy.ola_response_minutes),
  };
  db.prepare(
    'UPDATE tickets SET sla_policy_id = ?, sla_due_at = ?, response_due_at = ?, ola_due_at = ?, ola_response_due_at = ?, sla_warnings_sent = NULL WHERE id = ?'
  ).run(next.sla_policy_id, next.sla_due_at, next.response_due_at, next.ola_due_at, next.ola_response_due_at, ticket.id);
  event(ticket, 'recalculated', { reason });
  return { ...ticket, ...next, sla_warnings_sent: null };
}

// ---- the live picture ----------------------------------------------------

function targetSnapshot(ticket, dueAt, doneAt, businessOnly, label) {
  if (!dueAt) return null;
  const now = new Date();
  const start = new Date(ticket.created_at);
  const finished = doneAt ? new Date(doneAt) : null;
  const measureAt = finished || now;
  const due = new Date(dueAt);

  const elapsed = businessMinutesBetween(start, measureAt, ticket.workspace_id, businessOnly);
  const total = businessMinutesBetween(start, due, ticket.workspace_id, businessOnly);
  const remaining = businessMinutesBetween(measureAt, due, ticket.workspace_id, businessOnly);
  const breached = measureAt > due;

  return {
    target: label,
    due_at: dueAt,
    done_at: doneAt || null,
    // Percentage of the allowance used. Capped only in the label, never in
    // the number -- a target blown by 300% should read as 300%.
    consumed_pct: total > 0 ? Math.round((elapsed / total) * 100) : null,
    elapsed_minutes: elapsed,
    remaining_minutes: breached ? 0 : remaining,
    over_by_minutes: breached ? businessMinutesBetween(due, measureAt, ticket.workspace_id, businessOnly) : 0,
    state: finished ? (breached ? 'missed' : 'met') : (ticket.sla_paused_at ? 'paused' : (breached ? 'breached' : 'running')),
  };
}

/** Everything the UI and reports need about this ticket's clocks. */
export function slaSnapshot(ticket) {
  const policy = policyFor(ticket);
  const businessOnly = policy ? !!policy.business_hours_only : false;
  const firstResponse = ticket.responded_at || null;
  const resolvedAt = ticket.resolved_at || ticket.closed_at || null;

  return {
    policy_id: policy?.id || null,
    policy_name: policy?.name || null,
    business_hours_only: businessOnly,
    paused: !!ticket.sla_paused_at,
    paused_since: ticket.sla_paused_at || null,
    pause_reason: ticket.sla_pause_reason || null,
    paused_minutes: ticket.sla_paused_minutes || 0,
    thresholds: thresholdsFor(policy),
    breach_reason: ticket.sla_breach_reason || null,
    response: targetSnapshot(ticket, ticket.response_due_at, firstResponse, businessOnly, 'response'),
    resolution: targetSnapshot(ticket, ticket.sla_due_at, resolvedAt, businessOnly, 'resolution'),
    ola_response: targetSnapshot(ticket, ticket.ola_response_due_at, firstResponse, businessOnly, 'ola_response'),
    ola_resolution: targetSnapshot(ticket, ticket.ola_due_at, resolvedAt, businessOnly, 'ola_resolution'),
  };
}

/**
 * Warning and breach stamping, done when a ticket is read.
 *
 * This app runs no scheduler, and the established pattern here is to
 * self-heal on read (see stampSlaBreach and evaluateEscalationsSafely).
 * Each threshold fires once: the percentages already announced are recorded
 * on the ticket, so opening a ticket ten times does not send ten warnings.
 */
export function evaluateSlaSafely(ticket, { notify } = {}) {
  try {
    if (!ticket || ['resolved', 'closed'].includes(ticket.status)) return ticket;
    if (ticket.sla_paused_at) return ticket;
    const policy = policyFor(ticket);
    const businessOnly = policy ? !!policy.business_hours_only : false;
    const already = new Set(parseJson(ticket.sla_warnings_sent, []));
    const fired = [];

    for (const [target, dueAt] of [['resolution', ticket.sla_due_at], ['response', ticket.response_due_at]]) {
      if (!dueAt) continue;
      const snap = targetSnapshot(ticket, dueAt, null, businessOnly, target);
      if (!snap || snap.consumed_pct === null) continue;

      for (const t of thresholdsFor(policy)) {
        const key = `${target}:${t}`;
        if (snap.consumed_pct >= t && !already.has(key)) { already.add(key); fired.push({ target, threshold: t, snap }); }
      }
      if (snap.state === 'breached') {
        const key = `${target}:breached`;
        if (!already.has(key)) {
          already.add(key);
          const reason = `${target === 'response' ? 'First response' : 'Resolution'} target passed at ${new Date().toISOString()}`;
          if (target === 'resolution') {
            db.prepare("UPDATE tickets SET sla_breached = 1, sla_breached_at = COALESCE(sla_breached_at, datetime('now')), sla_breach_reason = ? WHERE id = ?")
              .run(reason, ticket.id);
          } else {
            db.prepare('UPDATE tickets SET response_breached = 1 WHERE id = ?').run(ticket.id);
          }
          event(ticket, 'breached', { target, reason });
        }
      }
    }

    // OLA is measured but never used to mark the customer-facing SLA
    // breached: missing an internal handover is a different fact.
    for (const [dueAt, column] of [[ticket.ola_due_at, 'ola_breached']]) {
      if (dueAt && new Date() > new Date(dueAt) && !ticket[column]) {
        db.prepare(`UPDATE tickets SET ${column} = 1 WHERE id = ?`).run(ticket.id);
        event(ticket, 'breached', { target: 'ola_resolution', reason: 'Internal target passed' });
      }
    }

    if (fired.length) {
      db.prepare('UPDATE tickets SET sla_warnings_sent = ? WHERE id = ?').run(JSON.stringify([...already]), ticket.id);
      for (const f of fired) {
        event(ticket, 'warning', { target: f.target, threshold: f.threshold });
        if (notify && ticket.assignee_id) {
          notify(ticket, f).catch?.(() => {});
        }
      }
    }
    return ticket;
  } catch (e) {
    // A timer must never be the reason a ticket cannot be opened.
    console.error('sla evaluation error', e);
    return ticket;
  }
}

// ---- holidays ------------------------------------------------------------

export function listHolidays(workspaceId) {
  return db.prepare('SELECT * FROM business_holidays WHERE workspace_id = ? ORDER BY date').all(workspaceId);
}

export function addHoliday(workspaceId, { date, name, recurs_annually }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new SlaError('Give the date as YYYY-MM-DD.', 400);
  }
  const existing = db.prepare('SELECT id FROM business_holidays WHERE workspace_id = ? AND date = ?').get(workspaceId, date);
  if (existing) throw new SlaError('That date is already a holiday.', 409);
  const id = uid('hol');
  db.prepare('INSERT INTO business_holidays (id, workspace_id, date, name, recurs_annually) VALUES (?,?,?,?,?)')
    .run(id, workspaceId, date, String(name || '').trim() || null, recurs_annually ? 1 : 0);
  return listHolidays(workspaceId);
}

export function deleteHoliday(workspaceId, id) {
  const row = db.prepare('SELECT id FROM business_holidays WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new SlaError('That holiday no longer exists.', 404);
  db.prepare('DELETE FROM business_holidays WHERE id = ?').run(id);
  return listHolidays(workspaceId);
}
