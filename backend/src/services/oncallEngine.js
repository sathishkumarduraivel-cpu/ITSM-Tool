// On-call resolution. Rotations are stored as *rules* (start date, length,
// member order) and who-is-on-call is computed on demand -- the same
// read-time-computation philosophy as sla.js's due dates and
// escalationEngine.js's thresholds. Nothing here materializes shift rows,
// because a generated shift table drifts the instant someone edits a
// layer's member list or rotation length, and then the calendar and the
// paging decision disagree about who is actually responsible.
//
// Timezone handling: handoffs happen at a wall-clock time in the schedule's
// own IANA zone, so a rotation handing off at 09:00 keeps handing off at
// 09:00 local across a DST transition rather than sliding to 08:00 or
// 10:00. Done with Intl.DateTimeFormat rather than a date library, matching
// this project's zero-runtime-dependency approach.
import { db } from '../db.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Wall-clock fields for an instant, as observed in a given IANA zone.
// Intl is the only timezone database available without adding a dependency,
// and it is the same one the platform's own formatting uses.
function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const out = {};
  for (const { type, value } of fmt.formatToParts(date)) {
    if (type !== 'literal') out[type] = value;
  }
  // 'en-CA' with hour12:false renders midnight as 24 in some ICU versions.
  const hour = out.hour === '24' ? '00' : out.hour;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(hour), minute: Number(out.minute), second: Number(out.second),
    dateKey: `${out.year}-${out.month}-${out.day}`,
  };
}

// How far the zone is from UTC at a given instant, in minutes. Derived by
// comparing the zone's own wall clock to UTC's, which is the standard way to
// get a *historically correct* offset (fixed offsets break across DST).
function zoneOffsetMinutes(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

// The instant at which a given wall-clock time occurs in a zone. Resolved by
// guessing with an approximate offset then correcting once -- one correction
// is enough because an offset error can only ever be off by the DST delta,
// and re-measuring at the corrected instant lands in the right regime.
export function zonedTimeToInstant({ year, month, day, hour = 0, minute = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = zoneOffsetMinutes(new Date(naive), timeZone);
  let instant = naive - offset * 60000;
  const corrected = zoneOffsetMinutes(new Date(instant), timeZone);
  if (corrected !== offset) {
    offset = corrected;
    instant = naive - offset * 60000;
  }
  return new Date(instant);
}

function parseHhMm(value, fallbackHour = 9) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!m) return { hour: fallbackHour, minute: 0 };
  const hour = Math.min(23, Math.max(0, Number(m[1])));
  const minute = Math.min(59, Math.max(0, Number(m[2])));
  return { hour, minute };
}

function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim());
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

// A layer's restriction limits *when the layer applies at all* (e.g. a day
// shift that only covers Mon-Fri 09:00-17:00). Outside its restriction the
// layer is simply not active, so a lower layer shows through -- that is what
// makes "business-hours team on top of a 24x7 primary" work with no special
// casing anywhere else.
function layerActiveAt(layer, date, timeZone) {
  if (!layer.restriction) return true;
  let r;
  try {
    r = JSON.parse(layer.restriction);
  } catch {
    return true; // malformed restriction must not silently black out a layer
  }
  if (!r || typeof r !== 'object') return true;

  const parts = zonedParts(date, timeZone);
  if (Array.isArray(r.days) && r.days.length) {
    // Day-of-week in the schedule's zone, 0=Sunday to match business_hours.
    const dow = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
    if (!r.days.map(Number).includes(dow)) return false;
  }
  if (r.start_time && r.end_time) {
    const start = parseHhMm(r.start_time, 0);
    const end = parseHhMm(r.end_time, 24);
    const mins = parts.hour * 60 + parts.minute;
    const startMins = start.hour * 60 + start.minute;
    const endMins = end.hour * 60 + end.minute;
    // An end before the start means the window wraps past midnight
    // (e.g. a 22:00-06:00 night shift).
    if (startMins <= endMins) {
      if (mins < startMins || mins >= endMins) return false;
    } else if (mins < startMins && mins >= endMins) {
      return false;
    }
  }
  return true;
}

// Which member of a layer holds the rotation at `date`.
//
// The rotation epoch is start_date at handoff_time in the schedule's zone.
// Before that instant the layer hasn't started and holds nobody -- returning
// a member for a not-yet-started rotation would page someone for a schedule
// their admin has deliberately dated into the future.
function rotationMemberAt(layer, members, date, timeZone) {
  if (!members.length) return null;
  const startDate = parseIsoDate(layer.start_date);
  if (!startDate) return null;
  const handoff = parseHhMm(layer.handoff_time);
  const epoch = zonedTimeToInstant({ ...startDate, hour: handoff.hour, minute: handoff.minute }, timeZone);
  if (date.getTime() < epoch.getTime()) return null;

  const lengthDays = layer.rotation_type === 'daily'
    ? 1
    : Math.max(1, Number(layer.rotation_length_days) || 7);

  // Elapsed whole rotations. Measured in *local calendar days* rather than
  // raw elapsed milliseconds so a DST shift inside a rotation can't nudge
  // the boundary onto the wrong side: 7 local days is 7 handoffs regardless
  // of whether one of them was 23 or 25 hours long.
  const startOfEpochDay = zonedParts(epoch, timeZone);
  const nowParts = zonedParts(date, timeZone);
  const epochDayUtc = Date.UTC(startOfEpochDay.year, startOfEpochDay.month - 1, startOfEpochDay.day);
  const nowDayUtc = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day);
  let dayDiff = Math.round((nowDayUtc - epochDayUtc) / MS_PER_DAY);
  // Before the handoff hour on a boundary day, the previous holder is still on.
  const nowMins = nowParts.hour * 60 + nowParts.minute;
  const handoffMins = handoff.hour * 60 + handoff.minute;
  if (nowMins < handoffMins) dayDiff -= 1;
  if (dayDiff < 0) return null;

  const index = Math.floor(dayDiff / lengthDays) % members.length;
  return members[index];
}

function scheduleWithLayers(scheduleId) {
  const schedule = db.prepare('SELECT * FROM oncall_schedules WHERE id = ?').get(scheduleId);
  if (!schedule) return null;
  const layers = db.prepare(
    'SELECT * FROM oncall_layers WHERE schedule_id = ? AND enabled = 1 ORDER BY layer_order ASC'
  ).all(scheduleId);
  for (const layer of layers) {
    layer._members = db.prepare(
      `SELECT lm.user_id, u.name, u.email FROM oncall_layer_members lm
       JOIN users u ON u.id = lm.user_id
       WHERE lm.layer_id = ? ORDER BY lm.member_order ASC, lm.id ASC`
    ).all(layer.id);
  }
  return { schedule, layers };
}

// The single source of truth for "who is on call".
//
// Precedence: a manual override beats everything, then the highest-numbered
// active layer wins. Returns the deciding layer/override alongside the user
// so the UI and the alert timeline can explain *why* someone was paged
// rather than just asserting it.
export function resolveOnCall(scheduleId, atDate = new Date()) {
  const loaded = scheduleWithLayers(scheduleId);
  if (!loaded) return null;
  const { schedule, layers } = loaded;
  if (!schedule.enabled) return { schedule, user: null, source: 'disabled', reason: 'Schedule is disabled' };

  const tz = schedule.timezone || 'UTC';
  const iso = atDate.toISOString();

  const override = db.prepare(
    `SELECT o.*, u.name, u.email FROM oncall_overrides o JOIN users u ON u.id = o.user_id
     WHERE o.schedule_id = ? AND o.start_at <= ? AND o.end_at > ?
     ORDER BY o.created_at DESC LIMIT 1`
  ).get(scheduleId, iso, iso);
  if (override) {
    return {
      schedule,
      user: { id: override.user_id, name: override.name, email: override.email },
      source: 'override',
      overrideId: override.id,
      reason: override.reason ? `Override: ${override.reason}` : 'Manual override',
    };
  }

  // Highest layer_order that is both active and actually holds someone.
  for (const layer of [...layers].reverse()) {
    if (!layerActiveAt(layer, atDate, tz)) continue;
    const member = rotationMemberAt(layer, layer._members, atDate, tz);
    if (!member) continue;
    return {
      schedule,
      user: { id: member.user_id, name: member.name, email: member.email },
      source: 'rotation',
      layerId: layer.id,
      layerName: layer.name,
      reason: `${layer.name} rotation`,
    };
  }

  return { schedule, user: null, source: 'none', reason: 'Nobody is on call for this schedule right now' };
}

// Every distinct on-call user across a schedule's escalation steps, in
// paging order. Used by the alert escalation path to page step N without
// re-deriving targets at each tick.
export function resolveEscalationTargets(scheduleId, atDate = new Date()) {
  const steps = db.prepare(
    'SELECT * FROM oncall_escalation_steps WHERE schedule_id = ? ORDER BY step_order ASC'
  ).all(scheduleId);
  const out = [];
  for (const step of steps) {
    const target = { stepId: step.id, stepOrder: step.step_order, delayMinutes: step.delay_minutes, targetType: step.target_type, users: [] };
    if (step.target_type === 'user' && step.target_id) {
      const u = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(step.target_id);
      if (u) target.users.push(u);
    } else if (step.target_type === 'group' && step.target_id) {
      target.users = db.prepare(
        `SELECT u.id, u.name, u.email FROM group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = ?`
      ).all(step.target_id);
    } else if (step.target_type === 'role' && step.target_id) {
      const schedule = db.prepare('SELECT workspace_id FROM oncall_schedules WHERE id = ?').get(scheduleId);
      target.users = db.prepare(
        `SELECT u.id, u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id
         WHERE wm.workspace_id = ? AND wm.role = ? AND wm.active = 1`
      ).all(schedule?.workspace_id, step.target_id);
    } else {
      // oncall_layer: whoever the schedule says is on call right now. A null
      // target_id means "the schedule's current holder" rather than one
      // specific layer, which is the common case.
      const current = resolveOnCall(scheduleId, atDate);
      if (current?.user) target.users.push(current.user);
    }
    out.push(target);
  }
  return out;
}

// Contiguous on-call blocks across a window, for the admin calendar preview.
// Walks resolveOnCall() at a fixed step and coalesces equal neighbours --
// deliberately sampling the same function the paging path uses, so the
// calendar can never show a different answer than the one that would
// actually page. Step is 30 minutes: fine enough to catch a business-hours
// layer's 09:00/17:00 edges without sampling a fortnight minute by minute.
export function resolveShiftRange(scheduleId, from, to, stepMinutes = 30) {
  const start = from instanceof Date ? from : new Date(from);
  const end = to instanceof Date ? to : new Date(to);
  if (!(end > start)) return [];
  const stepMs = Math.max(5, stepMinutes) * 60 * 1000;
  // Guard against a caller asking for a decade at 5-minute resolution.
  const maxSamples = 5000;

  const blocks = [];
  let samples = 0;
  for (let t = start.getTime(); t <= end.getTime() && samples < maxSamples; t += stepMs, samples += 1) {
    const at = new Date(t);
    const res = resolveOnCall(scheduleId, at);
    const userId = res?.user?.id || null;
    const key = `${userId}|${res?.source}|${res?.layerId || res?.overrideId || ''}`;
    const last = blocks[blocks.length - 1];
    if (last && last._key === key) {
      last.end = new Date(Math.min(t + stepMs, end.getTime())).toISOString();
    } else {
      blocks.push({
        _key: key,
        start: at.toISOString(),
        end: new Date(Math.min(t + stepMs, end.getTime())).toISOString(),
        user: res?.user || null,
        source: res?.source || 'none',
        layerName: res?.layerName || null,
        reason: res?.reason || null,
      });
    }
  }
  return blocks.map(({ _key, ...b }) => b);
}

// Is this user on call on ANY enabled schedule in the workspace right now?
// The assignment engine's respect_oncall filter uses this when a policy
// draws candidates from a group rather than one specific schedule.
export function isUserOnCall(workspaceId, userId, atDate = new Date()) {
  const schedules = db.prepare('SELECT id FROM oncall_schedules WHERE workspace_id = ? AND enabled = 1').all(workspaceId);
  for (const s of schedules) {
    const res = resolveOnCall(s.id, atDate);
    if (res?.user?.id === userId) return true;
  }
  return false;
}

export function getOnCallUserIds(workspaceId, atDate = new Date()) {
  const ids = new Set();
  const schedules = db.prepare('SELECT id FROM oncall_schedules WHERE workspace_id = ? AND enabled = 1').all(workspaceId);
  for (const s of schedules) {
    const res = resolveOnCall(s.id, atDate);
    if (res?.user?.id) ids.add(res.user.id);
  }
  return ids;
}
