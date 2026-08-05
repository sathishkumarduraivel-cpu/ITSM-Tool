import { db } from '../db.js';

// Finds the most specific enabled SLA policy matching priority/category/team.
// Specificity = number of non-null match fields that agree with the ticket.
export function findSlaPolicy({ priority, category, team }) {
  const policies = db.prepare('SELECT * FROM sla_policies WHERE enabled = 1').all();
  let best = null;
  let bestScore = -1;
  for (const p of policies) {
    if (p.priority && p.priority !== priority) continue;
    if (p.category && p.category !== category) continue;
    if (p.team && p.team !== team) continue;
    const score = (p.priority ? 1 : 0) + (p.category ? 1 : 0) + (p.team ? 1 : 0);
    if (score > bestScore) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

function getBusinessHours() {
  const rows = db.prepare('SELECT * FROM business_hours').all();
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
export function computeSlaDueDate(minutes, businessHoursOnly, from = new Date()) {
  if (!businessHoursOnly) {
    return new Date(from.getTime() + minutes * 60000).toISOString();
  }
  const hours = getBusinessHours();
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
