// Per-type ticket numbering (INC-/REQ-/PRB-/CHG-) backed by the
// ticket_counters table. node:sqlite calls are synchronous and Node is
// single-threaded, so there's no await between the UPDATE and the SELECT below
// — this sequence can't interleave with another request within one process.
import { db } from '../db.js';

const PREFIX = { incident: 'INC', request: 'REQ', problem: 'PRB', change: 'CHG' };
const KEY = '_global';

export function nextTicketNumber(type) {
  db.prepare('INSERT OR IGNORE INTO ticket_counters (workspace_id, type, seq) VALUES (?,?,999)').run(KEY, type);
  db.prepare('UPDATE ticket_counters SET seq = seq + 1 WHERE workspace_id = ? AND type = ?').run(KEY, type);
  const { seq } = db.prepare('SELECT seq FROM ticket_counters WHERE workspace_id = ? AND type = ?').get(KEY, type);
  return `${PREFIX[type] || 'TKT'}-${seq}`;
}
