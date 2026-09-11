import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { getProvider, selfServiceTriage } from '../services/aiClient.js';
import { computeSlaDueDate, findSlaPolicy } from '../services/sla.js';
import { nextTicketNumber } from '../services/ticketNumbering.js';
import { initialStageFor } from '../services/lifecycleEngine.js';
import { evaluateAutomations } from '../services/automationEngine.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

const STOPWORDS = new Set(['this', 'that', 'with', 'from', 'have', 'about', 'when', 'what', 'where', 'which', 'there', 'their', 'been', 'were', 'your', 'just', 'cant', "can't", 'wont', "won't", 'the', 'and', 'for', 'are', 'was', 'not', 'but']);

function extractKeywords(text) {
  return [...new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  )].slice(0, 6);
}

function findKbCandidates(workspaceId, text) {
  const keywords = extractKeywords(text);
  if (!keywords.length) return [];
  const clauses = keywords.map(() => '(title LIKE ? OR body LIKE ? OR tags LIKE ?)').join(' OR ');
  const params = keywords.flatMap((k) => [`%${k}%`, `%${k}%`, `%${k}%`]);
  return db.prepare(`SELECT id, title, category, body, tags FROM kb_articles WHERE workspace_id = ? AND (${clauses}) LIMIT 8`)
    .all(workspaceId, ...params);
}

function getOwnedSession(id, req) {
  const session = db.prepare('SELECT * FROM chatbot_sessions WHERE id = ? AND workspace_id = ?').get(id, req.workspaceId);
  if (!session) return null;
  if (session.user_id !== req.user.id && req.user.role !== 'admin') return null;
  return session;
}

router.get('/sessions', (req, res) => {
  const rows = db.prepare('SELECT * FROM chatbot_sessions WHERE workspace_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 20').all(req.workspaceId, req.user.id);
  res.json({ sessions: rows });
});

router.post('/sessions', (req, res) => {
  const id = uid('css');
  db.prepare('INSERT INTO chatbot_sessions (id, workspace_id, user_id) VALUES (?,?,?)').run(id, req.workspaceId, req.user.id);
  res.status(201).json({ session: db.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(id) });
});

router.get('/sessions/:id', (req, res) => {
  const session = getOwnedSession(req.params.id, req);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const messages = db.prepare('SELECT * FROM chatbot_messages WHERE session_id = ? ORDER BY created_at').all(session.id)
    .map((m) => ({ ...m, kb_article_ids: m.kb_article_ids ? JSON.parse(m.kb_article_ids) : [] }));
  res.json({ session, messages });
});

router.post('/sessions/:id/messages', async (req, res) => {
  const session = getOwnedSession(req.params.id, req);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: 'message required' });
  const trimmed = message.trim();

  db.prepare('INSERT INTO chatbot_messages (id, session_id, role, content) VALUES (?,?,?,?)').run(uid('csm'), session.id, 'user', trimmed);

  try {
    const provider = getProvider(req.workspaceId);
    const history = db.prepare('SELECT role, content FROM chatbot_messages WHERE session_id = ? ORDER BY created_at DESC LIMIT 8').all(session.id).reverse();
    const kbCandidates = findKbCandidates(req.workspaceId, trimmed);
    const result = await selfServiceTriage(provider, trimmed, { history, kbCandidates });

    db.prepare('INSERT INTO chatbot_messages (id, session_id, role, content, kb_article_ids) VALUES (?,?,?,?,?)').run(
      uid('csm'), session.id, 'assistant', result.response, JSON.stringify(result.kb_article_ids)
    );

    const newStatus = result.resolved_by_kb ? 'deflected' : session.status === 'deflected' ? 'open' : session.status;
    db.prepare("UPDATE chatbot_sessions SET status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, session.id);

    const kbArticles = result.kb_article_ids.length
      ? db.prepare(`SELECT id, title, category FROM kb_articles WHERE id IN (${result.kb_article_ids.map(() => '?').join(',')})`).all(...result.kb_article_ids)
      : [];

    res.json({
      reply: result.response,
      kbArticles,
      suggestTicket: result.suggest_ticket,
      ticketDraft: result.ticket_draft,
      session: db.prepare('SELECT * FROM chatbot_sessions WHERE id = ?').get(session.id),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/sessions/:id/escalate', (req, res) => {
  const session = getOwnedSession(req.params.id, req);
  if (!session) return res.status(404).json({ error: 'Not found' });
  const { title, description, category, priority = 'medium', type = 'incident' } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  if (!['incident', 'request'].includes(type)) return res.status(400).json({ error: 'type must be incident or request' });

  const id = uid('tkt');
  const number = nextTicketNumber(req.workspaceId, type);
  const policy = findSlaPolicy({ workspaceId: req.workspaceId, type, priority, category, team: null, title, description, source: 'ai-chat' });
  const sla_due_at = computeSlaDueDate(policy?.resolution_minutes ?? { critical: 240, high: 480, medium: 1440, low: 4320 }[priority] ?? 1440, policy?.business_hours_only, new Date(), req.workspaceId);
  const response_due_at = computeSlaDueDate(policy?.response_minutes ?? 60, policy?.business_hours_only, new Date(), req.workspaceId);
  const initialStage = initialStageFor(req.workspaceId, type);

  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, priority, category, requester_id, sla_due_at, response_due_at, sla_policy_id, source, cab_status, lifecycle_stage, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ai-chat','not_required',?,?)`
  ).run(id, req.workspaceId, number, type, title, description || '', priority, category || null, req.user.id, sla_due_at, response_due_at, policy?.id || null, initialStage?.key || null, initialStage?.bucket || 'open');
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), id, 'created', 'Ticket created via Self-Service AI Chatbot');

  db.prepare("UPDATE chatbot_sessions SET status = 'escalated', ticket_id = ?, updated_at = datetime('now') WHERE id = ?").run(id, session.id);

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  evaluateAutomations('ticket_created', ticket).catch((e) => console.error('automation error', e));
  res.status(201).json({ ticket });
});

// Deflection metrics -- the standard KPI for a self-service chatbot: of
// everyone who described a problem, how many were actually resolved by the
// Knowledge Base versus needed a real ticket. Agent/admin only, same
// operational-visibility tier as Reports.
router.get('/stats', requireRole('agent', 'admin'), (req, res) => {
  const totals = db.prepare(
    `SELECT
       COUNT(*) total,
       SUM(CASE WHEN status = 'deflected' THEN 1 ELSE 0 END) deflected,
       SUM(CASE WHEN status = 'escalated' THEN 1 ELSE 0 END) escalated,
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) open
     FROM chatbot_sessions WHERE workspace_id = ?`
  ).get(req.workspaceId);
  const deflectionRate = totals.total > 0 ? Math.round((totals.deflected / totals.total) * 100) : null;
  const byDay = db.prepare(
    `SELECT date(created_at) d, COUNT(*) c, SUM(CASE WHEN status = 'deflected' THEN 1 ELSE 0 END) deflected
     FROM chatbot_sessions WHERE workspace_id = ? AND created_at >= datetime('now', '-30 days') GROUP BY d ORDER BY d`
  ).all(req.workspaceId);
  res.json({ ...totals, deflectionRate, byDay });
});

export default router;
