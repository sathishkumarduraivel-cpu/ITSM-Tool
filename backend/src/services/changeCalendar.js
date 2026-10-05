// The change calendar: conflict detection, freeze windows, slot reservation
// and the flow diagram's "Suggest Alternate Slot" branch.
//
// Two distinct checks, deliberately not conflated:
//
//   * A **conflict** is another change already holding an overlapping slot.
//     It matters most when both touch the same CI, which this can see via
//     ticket_assets -- two unrelated changes at 22:00 are not a problem, two
//     changes to the same database at 22:00 are.
//   * A **freeze** is policy: a blackout period during which changes are not
//     permitted at all. An Emergency change may pierce one when the window
//     allows it, but only with a recorded reason, which then shows up in
//     metrics as a freeze violation rather than passing silently.
//
// Windows are half-open [start, end) throughout, so a change ending exactly
// as another begins is not a conflict -- back-to-back maintenance slots are
// normal and flagging them would make the calendar useless.
import { db, uid } from '../db.js';
import { allowsFreezeOverride } from './changeTypes.js';

const iso = (value) => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const ms = (value) => new Date(value).getTime();

function validWindow(start, end) {
  const a = ms(start);
  const b = ms(end);
  if (Number.isNaN(a) || Number.isNaN(b)) return 'The window is not a valid pair of dates';
  if (b <= a) return 'The window must end after it starts';
  return null;
}

// Half-open overlap: [aStart, aEnd) intersects [bStart, bEnd).
const overlaps = (aStart, aEnd, bStart, bEnd) => ms(aStart) < ms(bEnd) && ms(bStart) < ms(aEnd);

function assetIdsFor(ticketId) {
  return db.prepare('SELECT asset_id FROM ticket_assets WHERE ticket_id = ?').all(ticketId).map((r) => r.asset_id);
}

// Other changes whose reserved slot overlaps this window. `sharedCiOnly`
// narrows it to the ones that actually collide on a configuration item,
// which is what the UI surfaces as a hard conflict versus a soft one.
export function findConflicts(workspaceId, { start, end, excludeTicketId = null } = {}) {
  const invalid = validWindow(start, end);
  if (invalid) return { error: invalid, conflicts: [] };

  const rows = db.prepare(
    `SELECT s.*, t.number, t.title, t.change_type, t.risk_band, t.change_state
     FROM change_calendar_slots s JOIN tickets t ON t.id = s.ticket_id
     WHERE s.workspace_id = ? AND s.status = 'reserved'
       AND t.change_state NOT IN ('closed','rolled_back')
       ${excludeTicketId ? 'AND s.ticket_id != ?' : ''}`
  ).all(...(excludeTicketId ? [workspaceId, excludeTicketId] : [workspaceId]));

  const myAssets = excludeTicketId ? new Set(assetIdsFor(excludeTicketId)) : new Set();

  const conflicts = rows
    .filter((row) => overlaps(start, end, row.start_at, row.end_at))
    .map((row) => {
      const theirAssets = assetIdsFor(row.ticket_id);
      const shared = theirAssets.filter((a) => myAssets.has(a));
      return {
        ticket_id: row.ticket_id,
        number: row.number,
        title: row.title,
        change_type: row.change_type,
        risk_band: row.risk_band,
        start_at: row.start_at,
        end_at: row.end_at,
        shared_ci_count: shared.length,
        // A shared CI makes it a real collision; otherwise it is only
        // calendar congestion, which a team may well accept.
        severity: shared.length > 0 ? 'blocking' : 'advisory',
      };
    });

  return { conflicts, blocking: conflicts.filter((c) => c.severity === 'blocking') };
}

export function listFreezeWindows(workspaceId, { includeDisabled = false } = {}) {
  return db.prepare(
    `SELECT * FROM change_freeze_windows WHERE workspace_id = ?${includeDisabled ? '' : ' AND enabled = 1'}
     ORDER BY start_at ASC`
  ).all(workspaceId);
}

// Freeze windows that cover any part of this window and apply to this
// change. Scope narrows a freeze to a category or a specific CI, so a
// database freeze does not block a laptop swap.
export function activeFreezes(workspaceId, { start, end, ticket = null } = {}) {
  const windows = listFreezeWindows(workspaceId);
  const assetIds = ticket?.id ? assetIdsFor(ticket.id) : [];

  return windows.filter((w) => {
    if (!overlaps(start, end, w.start_at, w.end_at)) return false;
    if (w.scope === 'category') {
      return String(w.scope_value || '').toLowerCase() === String(ticket?.category || '').toLowerCase();
    }
    if (w.scope === 'asset') {
      return assetIds.includes(w.scope_value);
    }
    return true; // scope 'all'
  });
}

// The scheduling decision for one window: may this change take it, and if
// not, why. Returns everything the UI needs to explain itself rather than
// just a boolean.
export function evaluateWindow(workspaceId, ticket, { start, end } = {}) {
  const invalid = validWindow(start, end);
  if (invalid) return { ok: false, reason: invalid, conflicts: [], freezes: [] };

  const { conflicts, blocking } = findConflicts(workspaceId, { start, end, excludeTicketId: ticket?.id });
  const freezes = activeFreezes(workspaceId, { start, end, ticket });

  // A freeze an Emergency change is allowed to pierce is reported as
  // overridable rather than as a hard stop -- the caller must then supply a
  // reason, which reserveSlot records.
  const typeAllowsOverride = allowsFreezeOverride(workspaceId, ticket?.change_type);
  const hardFreezes = freezes.filter((f) => !(f.allow_emergency && typeAllowsOverride));
  const overridableFreezes = freezes.filter((f) => f.allow_emergency && typeAllowsOverride);

  if (hardFreezes.length) {
    return {
      ok: false,
      reason: `Inside change freeze "${hardFreezes[0].name}"`,
      conflicts, freezes, hardFreezes, overridableFreezes,
      requiresOverride: false,
    };
  }
  if (blocking.length) {
    return {
      ok: false,
      reason: `Conflicts with ${blocking[0].number}, which is scheduled on the same configuration item`,
      conflicts, freezes, hardFreezes, overridableFreezes,
      requiresOverride: false,
    };
  }
  if (overridableFreezes.length) {
    return {
      ok: true,
      requiresOverride: true,
      reason: `Inside change freeze "${overridableFreezes[0].name}" — permitted for this change type with a recorded reason`,
      conflicts, freezes, hardFreezes, overridableFreezes,
    };
  }
  return { ok: true, requiresOverride: false, conflicts, freezes, hardFreezes: [], overridableFreezes: [] };
}

// The diagram's "Suggest Alternate Slot". Walks forward from the requested
// start in fixed steps, keeping the same duration, and returns the first few
// windows that evaluate clean. Bounded by `horizonDays` so one call cannot
// scan indefinitely.
export function suggestAlternateSlots(workspaceId, ticket, { start, end, stepHours = 24, horizonDays = 14, limit = 3 } = {}) {
  const invalid = validWindow(start, end);
  if (invalid) return [];

  const duration = ms(end) - ms(start);
  const stepMs = Math.max(1, stepHours) * 3600000;
  const horizonMs = Math.max(1, horizonDays) * 24 * 3600000;
  const from = ms(start);

  const suggestions = [];
  for (let offset = stepMs; offset <= horizonMs && suggestions.length < limit; offset += stepMs) {
    const candidateStart = new Date(from + offset);
    const candidateEnd = new Date(from + offset + duration);
    const verdict = evaluateWindow(workspaceId, ticket, { start: candidateStart, end: candidateEnd });
    // Only offer slots that need no override -- suggesting "you could break
    // the freeze here instead" is not a helpful alternative.
    if (verdict.ok && !verdict.requiresOverride) {
      suggestions.push({ start_at: iso(candidateStart), end_at: iso(candidateEnd) });
    }
  }
  return suggestions;
}

// Reserves the window. Releases any slot this change already held, so
// re-scheduling never leaves it holding two.
export function reserveSlot(workspaceId, ticket, { start, end, actorId = null, overrideReason = null } = {}) {
  const verdict = evaluateWindow(workspaceId, ticket, { start, end });
  if (!verdict.ok) {
    return { ok: false, error: verdict.reason, verdict, alternates: suggestAlternateSlots(workspaceId, ticket, { start, end }) };
  }
  if (verdict.requiresOverride && !String(overrideReason || '').trim()) {
    return { ok: false, error: verdict.reason, requiresOverride: true, verdict };
  }

  db.prepare("UPDATE change_calendar_slots SET status = 'released' WHERE ticket_id = ? AND status = 'reserved'").run(ticket.id);
  const slotId = uid('ccs');
  db.prepare(
    'INSERT INTO change_calendar_slots (id, workspace_id, ticket_id, start_at, end_at, created_by) VALUES (?,?,?,?,?,?)'
  ).run(slotId, workspaceId, ticket.id, iso(start), iso(end), actorId);

  db.prepare(
    "UPDATE tickets SET scheduled_start = ?, scheduled_end = ?, freeze_override_reason = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(iso(start), iso(end), verdict.requiresOverride ? String(overrideReason).slice(0, 500) : null, ticket.id);

  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticket.id, 'scheduled',
    `Implementation window reserved: ${iso(start)} to ${iso(end)}`
      + (verdict.requiresOverride ? ` — change freeze overridden: ${overrideReason}` : '')
  );

  return { ok: true, slotId, verdict, advisoryConflicts: verdict.conflicts.filter((c) => c.severity === 'advisory') };
}

export function releaseSlot(workspaceId, ticketId) {
  const changed = db.prepare(
    "UPDATE change_calendar_slots SET status = 'released' WHERE ticket_id = ? AND workspace_id = ? AND status = 'reserved'"
  ).run(ticketId, workspaceId);
  db.prepare("UPDATE tickets SET scheduled_start = NULL, scheduled_end = NULL, updated_at = datetime('now') WHERE id = ?").run(ticketId);
  return { released: changed?.changes ?? 0 };
}

// Everything scheduled in a window, for the calendar view. Freeze windows
// come back alongside so the UI can shade them.
export function calendarView(workspaceId, { from, to } = {}) {
  const slots = db.prepare(
    `SELECT s.*, t.number, t.title, t.change_type, t.risk_band, t.change_state, t.assignee_id, u.name AS assignee_name
     FROM change_calendar_slots s
     JOIN tickets t ON t.id = s.ticket_id
     LEFT JOIN users u ON u.id = t.assignee_id
     WHERE s.workspace_id = ? AND s.status = 'reserved'
       AND datetime(s.end_at) >= datetime(?) AND datetime(s.start_at) <= datetime(?)
     ORDER BY s.start_at ASC`
  ).all(workspaceId, iso(from), iso(to));

  const freezes = listFreezeWindows(workspaceId)
    .filter((w) => overlaps(from, to, w.start_at, w.end_at));

  return { slots, freezes };
}
