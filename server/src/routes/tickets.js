import { Router } from 'express';
import fs from 'node:fs';
import { db, uid } from '../db.js';
import { requireAuth, attachWorkspace } from '../middleware/auth.js';
import { evaluateAutomations } from '../services/automationEngine.js';
import { getProvider, summarizeTicket, suggestResolution, categorizeTicket } from '../services/aiClient.js';
import { notifyUser, notifyRole, renderTemplate } from '../services/notifications.js';
import { computeSlaDueDate, findSlaPolicy } from '../services/sla.js';
import { nextTicketNumber } from '../services/ticketNumbering.js';
import { listFieldRules, applyFieldRules } from '../services/fieldRules.js';
import { upload } from '../services/uploads.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

function getTicket(id) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

router.get('/', (req, res) => {
  const { status, priority, type, assignee_id, team, q } = req.query;
  let sql = 'SELECT * FROM tickets WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (priority) { sql += ' AND priority = ?'; params.push(priority); }
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (assignee_id) { sql += ' AND assignee_id = ?'; params.push(assignee_id); }
  if (team) { sql += ' AND team = ?'; params.push(team); }
  if (q) { sql += ' AND (title LIKE ? OR number LIKE ? OR description LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY created_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params);
  res.json({ tickets: rows });
});

router.get('/teams', (req, res) => {
  const rows = db.prepare("SELECT DISTINCT team FROM tickets WHERE team IS NOT NULL AND team != '' ORDER BY team").all();
  res.json({ teams: rows.map((r) => r.team) });
});

router.get('/:id', (req, res) => {
  const ticket = db.prepare(
    `SELECT t.*, ru.name AS requester_name, ru.email AS requester_email, au.name AS assignee_name, au.email AS assignee_email
     FROM tickets t
     LEFT JOIN users ru ON ru.id = t.requester_id
     LEFT JOIN users au ON au.id = t.assignee_id
     WHERE t.id = ?`
  ).get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
  const history = db.prepare('SELECT * FROM ticket_history WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
  const approvals = db.prepare('SELECT * FROM approvals WHERE ticket_id = ? ORDER BY step_order').all(ticket.id);
  const linkedAssets = db.prepare(
    'SELECT a.* FROM ticket_assets ta JOIN assets a ON a.id = ta.asset_id WHERE ta.ticket_id = ?'
  ).all(ticket.id);
  const csat = db.prepare('SELECT * FROM csat_surveys WHERE ticket_id = ?').get(ticket.id);
  const attachments = db.prepare('SELECT id, filename, mime, size, uploaded_by, created_at FROM attachments WHERE ticket_id = ? ORDER BY created_at DESC').all(ticket.id);
  const fieldRules = listFieldRules(ticket.type, ticket.category);
  res.json({ ticket, comments, history, approvals, linkedAssets, csat: csat || null, attachments, fieldRules });
});

router.post('/', async (req, res) => {
  const {
    title, description, type = 'incident', priority = 'medium', category, subcategory, team, requester_id, source = 'portal',
    risk, planned_start, planned_end, rollback_plan,
  } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });

  const ruleError = applyFieldRules(type, category, req.body);
  if (ruleError) return res.status(400).json({ error: ruleError });

  const id = uid('tkt');
  const number = nextTicketNumber(type);

  const policy = findSlaPolicy({ priority, category, team });
  const sla_due_at = computeSlaDueDate(policy?.resolution_minutes ?? { critical: 240, high: 480, medium: 1440, low: 4320 }[priority] ?? 1440, policy?.business_hours_only);
  const response_due_at = computeSlaDueDate(policy?.response_minutes ?? 60, policy?.business_hours_only);

  const isChange = type === 'change';
  const cab_status = isChange ? 'pending' : 'not_required';

  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, priority, category, subcategory, team, requester_id, sla_due_at, response_due_at, sla_policy_id, source, risk, planned_start, planned_end, rollback_plan, cab_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, req.workspaceId, number, type, title, description || '', priority, category || null, subcategory || null, team || null,
    requester_id || req.user.id, sla_due_at, response_due_at, policy?.id || null, source,
    risk || null, planned_start || null, planned_end || null, rollback_plan || null, cab_status
  );
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), id, 'created', `Ticket created via ${source}`);

  if (isChange) {
    db.prepare('INSERT INTO approvals (id, ticket_id, approver_role, step_order, status) VALUES (?,?,?,?,?)').run(
      uid('apr'), id, 'admin', 1, 'pending'
    );
    notifyRole('admin', 'CAB approval requested', `${number} — ${title}`, `/tickets/${id}`);
  }

  const ticket = getTicket(id);
  evaluateAutomations('ticket_created', ticket).catch((e) => console.error('automation error', e));
  res.status(201).json({ ticket });
});

router.patch('/:id', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });

  // CAB gate: a change cannot move into progress until CAB has approved it.
  if (ticket.type === 'change' && req.body.status === 'in_progress' && ticket.cab_status !== 'approved') {
    return res.status(409).json({ error: 'This change is not yet CAB-approved. It cannot move to in_progress until approval is granted.' });
  }

  const ruleError = applyFieldRules(ticket.type, req.body.category ?? ticket.category, req.body, { partial: true });
  if (ruleError) return res.status(400).json({ error: ruleError });

  const allowed = ['title', 'description', 'status', 'priority', 'category', 'subcategory', 'assignee_id', 'team', 'impact', 'risk', 'planned_start', 'planned_end', 'rollback_plan'];
  const fields = [];
  const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });
  if (req.body.status === 'resolved' && ticket.status !== 'resolved') { fields.push("resolved_at = datetime('now')"); }
  if (req.body.status === 'closed' && ticket.status !== 'closed') { fields.push("closed_at = datetime('now')"); }
  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), req.params.id, 'updated', Object.keys(req.body).join(', ')
  );

  if (req.body.assignee_id && req.body.assignee_id !== ticket.assignee_id) {
    notifyUser(req.body.assignee_id, 'Ticket assigned to you', `${ticket.number} — ${ticket.title}`, `/tickets/${ticket.id}`);
  }
  if (req.body.status === 'resolved') {
    const tpl = renderTemplate('ticket_resolved', { number: ticket.number, title: ticket.title });
    notifyUser(ticket.requester_id, tpl?.subject || 'Your ticket was resolved', tpl?.body || `${ticket.number} — ${ticket.title}. Let us know how we did!`, `/tickets/${ticket.id}`);
  }

  const updated = getTicket(req.params.id);
  evaluateAutomations('ticket_updated', updated).catch((e) => console.error('automation error', e));
  res.json({ ticket: updated });
});

router.post('/:id/comments', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const { body, is_private = false } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  const id = uid('cmt');
  db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_id, author_name, body, is_private) VALUES (?,?,?,?,?,?)').run(
    id, req.params.id, req.user.id, req.user.name, body, is_private ? 1 : 0
  );
  const fields = ["updated_at = datetime('now')"];
  if (!ticket.responded_at && req.user.id !== ticket.requester_id) fields.push("responded_at = datetime('now')");
  db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(req.params.id);
  res.status(201).json({ comment: db.prepare('SELECT * FROM ticket_comments WHERE id = ?').get(id) });
});

// ---- CMDB: link/unlink assets to a ticket ----
router.post('/:id/assets', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const { asset_id } = req.body;
  if (!asset_id) return res.status(400).json({ error: 'asset_id required' });
  const asset = db.prepare('SELECT id FROM assets WHERE id = ?').get(asset_id);
  if (!asset) return res.status(404).json({ error: 'Asset not found' });
  db.prepare('INSERT INTO ticket_assets (id, ticket_id, asset_id) VALUES (?,?,?)').run(uid('ta'), req.params.id, asset_id);
  res.status(201).json({ ok: true });
});

router.delete('/:id/assets/:assetId', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM ticket_assets WHERE ticket_id = ? AND asset_id = ?').run(req.params.id, req.params.assetId);
  res.json({ ok: true });
});

// ---- Attachments ----
router.post('/:id/attachments', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  upload.array('files', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const files = req.files || [];
    for (const f of files) {
      db.prepare(
        'INSERT INTO attachments (id, workspace_id, ticket_id, filename, stored_path, mime, size, uploaded_by) VALUES (?,?,?,?,?,?,?,?)'
      ).run(uid('att'), req.workspaceId, req.params.id, f.originalname, f.path, f.mimetype, f.size, req.user.id);
    }
    if (files.length) {
      db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
        uid('h'), req.params.id, 'attachment_added', files.map((f) => f.originalname).join(', ')
      );
    }
    res.status(201).json({ ok: true, count: files.length });
  });
});

router.get('/:id/attachments', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const rows = db.prepare('SELECT id, filename, mime, size, uploaded_by, created_at FROM attachments WHERE ticket_id = ? ORDER BY created_at DESC').all(req.params.id);
  res.json({ attachments: rows });
});

router.get('/:id/attachments/:attachmentId/download', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND ticket_id = ?').get(req.params.attachmentId, req.params.id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  res.download(att.stored_path, att.filename);
});

router.delete('/:id/attachments/:attachmentId', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND ticket_id = ?').get(req.params.attachmentId, req.params.id);
  if (!att) return res.status(404).json({ error: 'Not found' });
  try { fs.unlinkSync(att.stored_path); } catch { /* file already gone */ }
  db.prepare('DELETE FROM attachments WHERE id = ?').run(att.id);
  res.json({ ok: true });
});

// ---- CSAT ----
router.post('/:id/csat', (req, res) => {
  const ticket = getTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const { rating, comment } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be 1-5' });
  const existing = db.prepare('SELECT id FROM csat_surveys WHERE ticket_id = ?').get(req.params.id);
  if (existing) return res.status(409).json({ error: 'Survey already submitted for this ticket' });
  db.prepare('INSERT INTO csat_surveys (id, ticket_id, rating, comment) VALUES (?,?,?,?)').run(uid('csat'), req.params.id, rating, comment || null);
  res.status(201).json({ ok: true });
});

// ---- AI actions on a specific ticket ----

router.post('/:id/ai/summarize', async (req, res) => {
  try {
    const ticket = getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
    const provider = getProvider(req.body.provider_id);
    const summary = await summarizeTicket(provider, ticket, comments);
    db.prepare("UPDATE tickets SET ai_summary = ?, updated_at = datetime('now') WHERE id = ?").run(summary, ticket.id);
    res.json({ summary });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/ai/suggest-resolution', async (req, res) => {
  try {
    const ticket = getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
    const provider = getProvider(req.body.provider_id);
    const kb = db.prepare('SELECT title, body FROM kb_articles WHERE category = ? LIMIT 3').all(ticket.category || '');
    const kbContext = kb.map((k) => `## ${k.title}\n${k.body.slice(0, 500)}`).join('\n\n');
    const suggestion = await suggestResolution(provider, ticket, comments, kbContext);
    res.json({ suggestion });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/ai/categorize', async (req, res) => {
  try {
    const ticket = getTicket(req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Not found' });
    const provider = getProvider(req.body.provider_id);
    const result = await categorizeTicket(provider, ticket);
    db.prepare(
      "UPDATE tickets SET category = ?, subcategory = ?, ai_sentiment = ?, ai_suggested_category = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(result.category, result.subcategory || null, result.sentiment || null, result.category, ticket.id);
    res.json({ result });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
