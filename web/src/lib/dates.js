// Timestamp parsing for values that come back from the API.
//
// The server stores two different timestamp shapes, and they must not be fed
// to `new Date()` the same way:
//
//   * SQLite's datetime('now')  -> "2026-09-22 07:44:00"   (UTC, no zone marker)
//   * JavaScript toISOString()  -> "2026-09-22T07:44:00.000Z" (explicit UTC)
//
// Per ECMA-262, a date-time string *without* a zone designator is interpreted
// as LOCAL time, while a date-only string is interpreted as UTC. So
// `new Date("2026-09-22 07:44:00")` in a UTC+5:30 browser yields 02:14 UTC --
// every comment, history entry and "updated" column rendered that way was
// showing 5.5 hours in the past, and sorting a mixed feed by it interleaved
// the two shapes incorrectly.
//
// parseDate() normalizes the SQLite shape by appending the 'Z' that was
// always implied, and passes everything else through untouched.

const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;

export function parseDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const raw = String(value).trim();
  const normalized = SQLITE_DATETIME.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw;
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Milliseconds, for sorting. Returns 0 for unparseable values so a bad row
// sorts to the start rather than throwing or landing at NaN (which would
// make the comparator non-deterministic).
export function dateValue(value) {
  const d = parseDate(value);
  return d ? d.getTime() : 0;
}

export function fmtDateTime(value, fallback = '—') {
  const d = parseDate(value);
  return d ? d.toLocaleString() : fallback;
}

export function fmtDate(value, fallback = '—') {
  const d = parseDate(value);
  return d ? d.toLocaleDateString() : fallback;
}

export function fmtTime(value, fallback = '—') {
  const d = parseDate(value);
  return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : fallback;
}

// "3 minutes ago" / "in 2 hours". Uses Intl.RelativeTimeFormat so it follows
// the browser locale rather than hardcoding English.
const rtf = typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
  ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  : null;

const UNITS = [
  ['year', 365 * 24 * 3600 * 1000],
  ['month', 30 * 24 * 3600 * 1000],
  ['week', 7 * 24 * 3600 * 1000],
  ['day', 24 * 3600 * 1000],
  ['hour', 3600 * 1000],
  ['minute', 60 * 1000],
];

export function fmtRelative(value, fallback = '—') {
  const d = parseDate(value);
  if (!d) return fallback;
  if (!rtf) return d.toLocaleString();

  const diff = d.getTime() - Date.now();
  const abs = Math.abs(diff);
  if (abs < 45 * 1000) return 'just now';
  for (const [unit, ms] of UNITS) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return rtf.format(Math.round(diff / 1000), 'second');
}
