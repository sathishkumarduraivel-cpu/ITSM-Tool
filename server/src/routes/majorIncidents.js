import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { notifyUser } from '../services/notifications.js';
import { nextMajorIncidentNumber, withComputed, getMajorIncident, SEVERITIES, STATUSES } from '../services/majorIncidents.js';
import { broadcastToWorkspace } from '../services/realtime.js';

const router = Router();
// Operational coordination work, not admin configuration -- any agent may
// need to declare or run one in the moment, same treatment as ticket bulk
// actions/merge. Requesters have no dedicated view here; they see updates as
// ordinary comments on their own ticket instead (see POST /:id/updates).
router.use(requireAuth, requireWorkspace, requireRole('agent', 'admin'));

const PRIORITY_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

function ticketSummary(ticketId, workspaceId) {
  return db.prepare('SELECT id, number, title, status, priority, type, requester_id, assignee_id FROM tickets WHERE id = ? AND workspace_id = ?').get(ticketId, workspaceId);
}

function withNames(mi) {
  const commander = mi.commander_id ? db.prepare('SELECT name FROM users WHERE id = ?').get(mi.commander_id) : null;
  const declaredBy = mi.declared_by ? db.prepare('SELECT name FROM users WHERE id = ?').get(mi.declared_by) : null;
  const ticket = ticketSummary(mi.ticket_id, mi.workspace_id);
  return { ...mi, commander_name: commander?.name || null, declared_by_name: declaredBy?.name || null, ticket };
}

router.get('/', (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM major_incidents WHERE workspace_id = ?';
  const params = [req.workspaceId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY declared_at DESC';
  const rows = db.prepare(sql).all(...params).map(withComputed).map(withNames);
  res.json({ majorIncidents: rows });
});

router.post('/', (req, res) => {
  const { ticket_id, severity = 'sev2', summary, impact_description, commander_id, update_interval_minutes = 30 } = req.body;
  if (!ticket_id || !summary) return res.status(400).json({ error: 'ticket_id and summary required' });
  if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: `severity must be one of: ${SEVERITIES.join(', ')}` });
  const ticket = ticketSummary(ticket_id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  if (ticket.type !== 'incident') return res.status(400).json({ error: 'A Major Incident can only be declared on an incident ticket' });
  const existing = db.prepare("SELECT id FROM major_incidents WHERE ticket_id = ? AND status NOT IN ('resolved','closed')").get(ticket_id);
  if (existing) return res.status(409).json({ error: 'This ticket already has an active Major Incident' });

  const id = uid('mi');
  const number = nextMajorIncidentNumber(req.workspaceId);
  const nextUpdateDueAt = new Date(Date.now() + update_interval_minutes * 60000).toISOString();
  db.prepare(
    `INSERT INTO major_incidents (id, workspace_id, ticket_id, number, severity, summary, impact_description, commander_id, declared_by, update_interval_minutes, next_update_due_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(id, req.workspaceId, ticket_id, number, severity, summary, impact_description || null, commander_id || null, req.user.id, update_interval_minutes, nextUpdateDueAt);

  // Priority only ever moves up, same safety rule the escalation engine uses --
  // declaring a Major Incident should never silently downgrade urgency someone
  // already set, but critical is the floor for anything declared major.
  if ((PRIORITY_RANK[ticket.priority] ?? -1) < PRIORITY_RANK.critical) {
    db.prepare('UPDATE tickets SET priority = ? WHERE id = ?').run('critical', ticket_id);
  }
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticket_id, 'major_incident_declared', `${number} declared (${severity.toUpperCase()}) by ${req.user.name}`
  );

  const notifyIds = new Set([commander_id, ticket.assignee_id].filter(Boolean));
  for (const uid_ of notifyIds) notifyUser(uid_, `Major Incident ${number} declared`, summary, `/major-incidents/${id}`, req.workspaceId);

  res.status(201).json({ majorIncident: withNames(getMajorIncident(id, req.workspaceId)) });
});

router.get('/:id', (req, res) => {
  const mi = getMajorIncident(req.params.id, req.workspaceId);
  if (!mi) return res.status(404).json({ error: 'Not found' });
  const updates = db.prepare('SELECT * FROM major_incident_updates WHERE major_incident_id = ? ORDER BY created_at DESC').all(mi.id);
  const related = db.prepare('SELECT ticket_id FROM major_incident_related_tickets WHERE major_incident_id = ?').all(mi.id)
    .map((r) => ticketSummary(r.ticket_id, req.workspaceId)).filter(Boolean);
  res.json({ majorIncident: withNames(mi), updates, relatedTickets: related });
});

router.patch('/:id', (req, res) => {
  const mi = getMajorIncident(req.params.id, req.workspaceId);
  if (!mi) return res.status(404).json({ error: 'Not found' });
  const { severity, summary, impact_description, commander_id, update_interval_minutes, status, pir_status } = req.body;

  if (severity !== undefined && !SEVERITIES.includes(severity)) return res.status(400).json({ error: `severity must be one of: ${SEVERITIES.join(', ')}` });
  if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });

  // Closing requires the post-incident review to actually be done -- a
  // real ITIL gate, not just a status label, and the one hard block in this
  // module (everywhere else here only flags "overdue" the way SLA/escalation
  // already do, rather than blocking).
  const effectivePirStatus = pir_status !== undefined ? pir_status : mi.pir_status;
  if (status === 'closed' && effectivePirStatus !== 'completed') {
    return res.status(400).json({ error: 'Complete the post-incident review before closing this Major Incident.' });
  }

  const fields = []; const params = [];
  if (severity !== undefined) { fields.push('severity = ?'); params.push(severity); }
  if (summary !== undefined) { fields.push('summary = ?'); params.push(summary); }
  if (impact_description !== undefined) { fields.push('impact_description = ?'); params.push(impact_description || null); }
  if (commander_id !== undefined) { fields.push('commander_id = ?'); params.push(commander_id || null); }
  if (update_interval_minutes !== undefined) {
    fields.push('update_interval_minutes = ?'); params.push(update_interval_minutes);
    fields.push('next_update_due_at = ?'); params.push(new Date(Date.now() + update_interval_minutes * 60000).toISOString());
  }
  if (status !== undefined) {
    fields.push('status = ?'); params.push(status);
    if (status === 'resolved' && mi.status !== 'resolved') {
      fields.push("resolved_at = datetime('now')");
      fields.push("pir_due_at = datetime('now', '+5 days')");
    }
    if (status === 'closed') fields.push("closed_at = datetime('now')");
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(mi.id);
  db.prepare(`UPDATE major_incidents SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  if (status === 'resolved' && mi.status !== 'resolved') {
    const ticket = ticketSummary(mi.ticket_id, req.workspaceId);
    if (ticket && !['resolved', 'closed'].includes(ticket.status)) {
      db.prepare("UPDATE tickets SET status = 'resolved', resolved_at = COALESCE(resolved_at, datetime('now')) WHERE id = ?").run(ticket.id);
    }
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), mi.ticket_id, 'major_incident_resolved', `${mi.number} marked resolved by ${req.user.name}`);
  }
  if (status === 'closed') {
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), mi.ticket_id, 'major_incident_closed', `${mi.number} closed by ${req.user.name}`);
  }

  broadcastToWorkspace(req.workspaceId, 'major_incident.updated', { majorIncidentId: mi.id });
  res.json({ majorIncident: withNames(getMajorIncident(mi.id, req.workspaceId)) });
});

router.post('/:id/updates', (req, res) => {
  const mi = getMajorIncident(req.params.id, req.workspaceId);
  if (!mi) return res.status(404).json({ error: 'Not found' });
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });

  db.prepare('INSERT INTO major_incident_updates (id, major_incident_id, author_id, author_name, message, status_at_time) VALUES (?,?,?,?,?,?)')
    .run(uid('miu'), mi.id, req.user.id, req.user.name, message.trim(), mi.status);

  if (['active', 'monitoring'].includes(mi.status)) {
    const nextUpdateDueAt = new Date(Date.now() + mi.update_interval_minutes * 60000).toISOString();
    db.prepare('UPDATE major_incidents SET next_update_due_at = ? WHERE id = ?').run(nextUpdateDueAt, mi.id);
  }

  // Mirrored onto the anchor ticket's own comment thread so anyone watching
  // the raw ticket -- not just people who know to check the Major Incident
  // page -- sees the same update, same "visible everywhere relevant"
  // reasoning as bilateral external-platform comment sync.
  db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_id, author_name, body, is_private) VALUES (?,?,?,?,?,0)')
    .run(uid('c'), mi.ticket_id, req.user.id, `${req.user.name} (${mi.number} update)`, message.trim());

  const ticket = ticketSummary(mi.ticket_id, req.workspaceId);
  const notifyIds = new Set([mi.commander_id, ticket?.assignee_id, ticket?.requester_id].filter((u) => u && u !== req.user.id));
  for (const uid_ of notifyIds) notifyUser(uid_, `${mi.number} update`, message.trim(), `/major-incidents/${mi.id}`, req.workspaceId);

  broadcastToWorkspace(req.workspaceId, 'major_incident.updated', { majorIncidentId: mi.id });
  res.status(201).json({ majorIncident: withNames(getMajorIncident(mi.id, req.workspaceId)) });
});

router.post('/:id/related', (req, res) => {
  const mi = getMajorIncident(req.params.id, req.workspaceId);
  if (!mi) return res.status(404).json({ error: 'Not found' });
  const { ticket_id } = req.body;
  if (!ticket_id) return res.status(400).json({ error: 'ticket_id required' });
  if (ticket_id === mi.ticket_id) return res.status(400).json({ error: 'That is already the anchor ticket for this Major Incident' });
  const ticket = ticketSummary(ticket_id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const existing = db.prepare('SELECT id FROM major_incident_related_tickets WHERE major_incident_id = ? AND ticket_id = ?').get(mi.id, ticket_id);
  if (existing) return res.status(409).json({ error: 'Already linked' });

  db.prepare('INSERT INTO major_incident_related_tickets (id, major_incident_id, ticket_id) VALUES (?,?,?)').run(uid('mrt'), mi.id, ticket_id);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), ticket_id, 'linked_major_incident', `Linked to ${mi.number} (${mi.summary})`);
  res.status(201).json({ ok: true });
});

router.delete('/:id/related/:ticketId', (req, res) => {
  const mi = getMajorIncident(req.params.id, req.workspaceId);
  if (!mi) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM major_incident_related_tickets WHERE major_incident_id = ? AND ticket_id = ?').run(mi.id, req.params.ticketId);
  res.json({ ok: true });
});

router.patch('/:id/pir', (req, res) => {
  const mi = getMajorIncident(req.params.id, req.workspaceId);
  if (!mi) return res.status(404).json({ error: 'Not found' });
  const { pir_status, pir_document } = req.body;
  if (pir_status !== undefined && !['not_started', 'in_progress', 'completed'].includes(pir_status)) {
    return res.status(400).json({ error: 'Invalid pir_status' });
  }
  const fields = []; const params = [];
  if (pir_status !== undefined) { fields.push('pir_status = ?'); params.push(pir_status); }
  if (pir_document !== undefined) { fields.push('pir_document = ?'); params.push(pir_document); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(mi.id);
  db.prepare(`UPDATE major_incidents SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ majorIncident: withNames(getMajorIncident(mi.id, req.workspaceId)) });
});

export default router;
