// The public developer API -- deliberately a separate router/namespace
// (/api/v1/*) from the internal app API the SPA itself calls (/api/*),
// authenticated with API keys (see middleware/auth.js's requireApiKey) not
// session JWTs, and exposing a curated, reviewed subset of what the
// internal API can do -- not a mirror of every internal route. Real ITSM
// platforms (ServiceNow, Freshservice) draw exactly this line between
// "what the product's own UI calls" and "what we support external systems
// calling", and version it (v1) so future breaking changes don't disturb
// integrations already built against it.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { db, uid } from '../db.js';
import { requireApiKey } from '../middleware/auth.js';
import { computeSlaDueDate, findSlaPolicy } from '../services/sla.js';
import { nextTicketNumber } from '../services/ticketNumbering.js';
import { initialStageFor } from '../services/lifecycleEngine.js';
import { evaluateAutomations } from '../services/automationEngine.js';
import { broadcastToWorkspace } from '../services/realtime.js';

const router = Router();

// Keyed by the API key itself (set after requireApiKey runs), not by IP --
// a company's whole integration shares one key regardless of how many of
// their servers call from behind a shared NAT/proxy IP.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.apiKey?.id || req.ip,
  message: { error: 'Rate limit exceeded — 120 requests per minute per API key.' },
});
router.use(apiLimiter);

const TICKET_FIELDS = 'id, number, type, title, description, status, priority, category, subcategory, team, requester_id, assignee_id, sla_due_at, sla_breached, source, created_at, updated_at, resolved_at, closed_at';

function ticketOut(row) {
  const requester = row.requester_id ? db.prepare('SELECT name, email FROM users WHERE id = ?').get(row.requester_id) : null;
  const assignee = row.assignee_id ? db.prepare('SELECT name, email FROM users WHERE id = ?').get(row.assignee_id) : null;
  return { ...row, requester: requester ? { name: requester.name, email: requester.email } : null, assignee: assignee ? { name: assignee.name, email: assignee.email } : null };
}

// ---- Tickets ----
router.get('/tickets', requireApiKey('tickets:read'), (req, res) => {
  const { status, priority, type, limit = 50, offset = 0 } = req.query;
  let sql = `SELECT ${TICKET_FIELDS} FROM tickets WHERE workspace_id = ? AND is_spam = 0`;
  const params = [req.workspaceId];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (priority) { sql += ' AND priority = ?'; params.push(priority); }
  if (type) { sql += ' AND type = ?'; params.push(type); }
  const total = db.prepare(sql.replace(`SELECT ${TICKET_FIELDS}`, 'SELECT COUNT(*) c')).get(...params).c;
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  const rows = db.prepare(sql).all(...params, Math.min(Number(limit) || 50, 200), Number(offset) || 0);
  res.json({ data: rows.map(ticketOut), total, limit: Number(limit) || 50, offset: Number(offset) || 0 });
});

router.get('/tickets/:id', requireApiKey('tickets:read'), (req, res) => {
  const row = db.prepare(`SELECT ${TICKET_FIELDS} FROM tickets WHERE id = ? AND workspace_id = ?`).get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ data: ticketOut(row) });
});

router.post('/tickets', requireApiKey('tickets:write'), (req, res) => {
  const { title, description, type = 'incident', priority = 'medium', category, requester_email } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!['incident', 'request', 'problem', 'change'].includes(type)) return res.status(400).json({ error: 'type must be incident, request, problem, or change' });
  let requesterId = null;
  if (requester_email) {
    const member = db.prepare(
      `SELECT u.id FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND u.email = ? AND wm.active = 1`
    ).get(req.workspaceId, requester_email);
    if (!member) return res.status(400).json({ error: `No active member of this workspace has the email ${requester_email}` });
    requesterId = member.id;
  }

  const id = uid('tkt');
  const number = nextTicketNumber(req.workspaceId, type);
  const policy = findSlaPolicy({ workspaceId: req.workspaceId, type, priority, category, team: null, title, description, source: 'api' });
  const sla_due_at = computeSlaDueDate(policy?.resolution_minutes ?? { critical: 240, high: 480, medium: 1440, low: 4320 }[priority] ?? 1440, policy?.business_hours_only, new Date(), req.workspaceId);
  const response_due_at = computeSlaDueDate(policy?.response_minutes ?? 60, policy?.business_hours_only, new Date(), req.workspaceId);
  const initialStage = initialStageFor(req.workspaceId, type);

  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, priority, category, requester_id, sla_due_at, response_due_at, sla_policy_id, source, cab_status, lifecycle_stage, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'api','not_required',?,?)`
  ).run(id, req.workspaceId, number, type, title, description || '', priority, category || null, requesterId, sla_due_at, response_due_at, policy?.id || null, initialStage?.key || null, initialStage?.bucket || 'open');
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), id, 'created', `Ticket created via API key "${req.apiKey.name}"`);

  const ticket = db.prepare(`SELECT ${TICKET_FIELDS} FROM tickets WHERE id = ?`).get(id);
  evaluateAutomations('ticket_created', ticket).catch((e) => console.error('automation error', e));
  broadcastToWorkspace(req.workspaceId, 'ticket.created', { ticketId: id });
  res.status(201).json({ data: ticketOut(ticket) });
});

router.patch('/tickets/:id', requireApiKey('tickets:write'), (req, res) => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const allowed = ['status', 'priority', 'category', 'team'];
  const fields = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: `No valid fields to update (allowed: ${allowed.join(', ')})` });
  if (req.body.status === 'resolved' && ticket.status !== 'resolved') fields.push("resolved_at = datetime('now')");
  if (req.body.status === 'closed' && ticket.status !== 'closed') fields.push("closed_at = datetime('now')");
  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), req.params.id, 'updated', `Updated via API key "${req.apiKey.name}": ${Object.keys(req.body).join(', ')}`);

  const updated = db.prepare(`SELECT ${TICKET_FIELDS} FROM tickets WHERE id = ?`).get(req.params.id);
  evaluateAutomations('ticket_updated', updated).catch((e) => console.error('automation error', e));
  broadcastToWorkspace(req.workspaceId, 'ticket.updated', { ticketId: req.params.id });
  res.json({ data: ticketOut(updated) });
});

router.post('/tickets/:id/comments', requireApiKey('tickets:write'), (req, res) => {
  const ticket = db.prepare('SELECT id FROM tickets WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const { body, author_name } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  const id = uid('cmt');
  const attributedName = author_name ? `${author_name} (via ${req.apiKey.name})` : `API (${req.apiKey.name})`;
  db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_id, author_name, body, is_private) VALUES (?,?,?,?,?,0)').run(id, req.params.id, null, attributedName, body);
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  broadcastToWorkspace(req.workspaceId, 'ticket.comment', { ticketId: req.params.id });
  res.status(201).json({ data: db.prepare('SELECT * FROM ticket_comments WHERE id = ?').get(id) });
});

// ---- Assets ----
router.get('/assets', requireApiKey('assets:read'), (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const rows = db.prepare('SELECT id, tag, name, type, status, location, vendor, purchase_date, warranty_expiry FROM assets WHERE workspace_id = ? ORDER BY name LIMIT ? OFFSET ?')
    .all(req.workspaceId, Math.min(Number(limit) || 50, 200), Number(offset) || 0);
  res.json({ data: rows });
});

// ---- Knowledge base ----
router.get('/kb', requireApiKey('kb:read'), (req, res) => {
  const { q, limit = 20 } = req.query;
  // An API key is not a person, so there is no "own drafts" case: this is the
  // external surface and it sees what a customer would -- published,
  // portal-visible articles. It previously returned drafts and internal
  // runbooks to anything holding a kb:read key.
  let sql = `SELECT id, title, category, body, tags, views FROM kb_articles
             WHERE workspace_id = ? AND status = 'published' AND visibility = 'portal'`;
  const params = [req.workspaceId];
  if (q) { sql += ' AND (title LIKE ? OR body LIKE ?)'; params.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY updated_at DESC LIMIT ?';
  const rows = db.prepare(sql).all(...params, Math.min(Number(limit) || 20, 100));
  res.json({ data: rows });
});

// ---- Users ----
router.get('/users', requireApiKey('users:read'), (req, res) => {
  const { email } = req.query;
  let sql = `SELECT u.id, u.name, u.email, wm.role, wm.team FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND wm.active = 1`;
  const params = [req.workspaceId];
  if (email) { sql += ' AND u.email = ?'; params.push(email); }
  sql += ' ORDER BY u.name LIMIT 100';
  res.json({ data: db.prepare(sql).all(...params) });
});

export default router;
