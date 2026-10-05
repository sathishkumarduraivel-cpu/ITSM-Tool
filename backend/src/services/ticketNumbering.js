// Per-type, per-workspace ticket numbering (INC-/REQ-/PRB-/CHG- by default,
// admin-customizable per workspace) backed by the ticket_counters table plus
// a workspace_settings row for prefix overrides. node:sqlite calls are
// synchronous and Node is single-threaded, so there's no await between the
// UPDATE and the SELECT below — this sequence can't interleave with another
// request within one process. (Multi-process/multi-instance deployment would
// need a real transaction or a DB-level sequence instead — not a concern for
// this single-server setup.)
import { db } from '../db.js';

const DEFAULT_PREFIX = { incident: 'INC', request: 'REQ', problem: 'PRB', change: 'CHG' };
const SETTINGS_KEY = 'ticket_number_prefixes';

// Effective prefixes for a workspace: defaults, overridden by whatever an
// admin has customized via PATCH /api/ticket-numbering. Changing a prefix
// only affects *new* tickets going forward — existing ticket numbers are
// never rewritten, since they may already be referenced in emails, external
// system links, or audit trails.
export function getTicketNumberPrefixes(workspaceId) {
  const row = db.prepare('SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ?').get(workspaceId, SETTINGS_KEY);
  let overrides = {};
  if (row?.value) {
    try { overrides = JSON.parse(row.value); } catch { /* corrupt/legacy value -- ignore, fall back to defaults */ }
  }
  return { ...DEFAULT_PREFIX, ...overrides };
}

export function setTicketNumberPrefix(workspaceId, type, prefix) {
  if (!DEFAULT_PREFIX[type]) throw new Error(`Unknown ticket type: ${type}`);
  const clean = String(prefix || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!clean) throw new Error('Prefix cannot be empty');
  if (clean.length > 10) throw new Error('Prefix must be 10 characters or fewer');
  const next = { ...getTicketNumberPrefixes(workspaceId), [type]: clean };
  db.prepare(
    `INSERT INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(workspaceId, SETTINGS_KEY, JSON.stringify(next));
  return next;
}

export function nextTicketNumber(workspaceId, type) {
  const prefixes = getTicketNumberPrefixes(workspaceId);
  db.prepare('INSERT OR IGNORE INTO ticket_counters (workspace_id, type, seq) VALUES (?,?,999)').run(workspaceId, type);
  db.prepare('UPDATE ticket_counters SET seq = seq + 1 WHERE workspace_id = ? AND type = ?').run(workspaceId, type);
  const { seq } = db.prepare('SELECT seq FROM ticket_counters WHERE workspace_id = ? AND type = ?').get(workspaceId, type);
  return `${prefixes[type] || 'TKT'}-${seq}`;
}
