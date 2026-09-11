import { db } from '../db.js';

export const SEVERITIES = ['sev1', 'sev2', 'sev3'];
export const STATUSES = ['active', 'monitoring', 'resolved', 'closed'];

// Its own sequence (MI-1, MI-2...), independent of ticket numbers -- reuses
// the existing ticket_counters table with a distinct 'major_incident' type
// key rather than a whole new table, same atomic increment as
// services/ticketNumbering.js (safe here for the same reason: node:sqlite
// calls are synchronous and Node is single-threaded, so no other request
// can interleave between the UPDATE and the SELECT).
export function nextMajorIncidentNumber(workspaceId) {
  db.prepare("INSERT OR IGNORE INTO ticket_counters (workspace_id, type, seq) VALUES (?,'major_incident',0)").run(workspaceId);
  db.prepare("UPDATE ticket_counters SET seq = seq + 1 WHERE workspace_id = ? AND type = 'major_incident'").run(workspaceId);
  const { seq } = db.prepare("SELECT seq FROM ticket_counters WHERE workspace_id = ? AND type = 'major_incident'").get(workspaceId);
  return `MI-${seq}`;
}

// No scheduler exists anywhere in this app by design -- "is the next update
// overdue" is computed at read time from next_update_due_at, exactly like
// SLA breach and escalation-threshold checks already are elsewhere.
export function withComputed(mi) {
  const updateOverdue = !!(mi.next_update_due_at && ['active', 'monitoring'].includes(mi.status) && new Date(mi.next_update_due_at) < new Date());
  const pirOverdue = !!(mi.pir_due_at && mi.pir_status !== 'completed' && new Date(mi.pir_due_at) < new Date());
  return { ...mi, updateOverdue, pirOverdue };
}

export function getMajorIncident(id, workspaceId) {
  const row = db.prepare('SELECT * FROM major_incidents WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  return row ? withComputed(row) : null;
}

export function serializeList(rows) {
  return rows.map(withComputed);
}
