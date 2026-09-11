import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tickets: [], assets: [], kb: [], catalog: [] });
  const like = `%${q}%`;

  // A requester searching used to see every workspace ticket matching the
  // query text, including other people's -- the same row-leak GET /tickets
  // and GET /tickets/:id were already hardened against, just missed here.
  // Forced server-side, not just filtered by what the UI chooses to show.
  let ticketSql = `SELECT id, number, title, status, priority, type FROM tickets WHERE workspace_id = ? AND deleted_at IS NULL AND (title LIKE ? OR number LIKE ? OR description LIKE ?)`;
  const ticketParams = [req.workspaceId, like, like, like];
  if (req.user.role === 'requester') {
    ticketSql += ' AND requester_id = ?';
    ticketParams.push(req.user.id);
  }
  ticketSql += ' ORDER BY created_at DESC LIMIT 5';
  const tickets = db.prepare(ticketSql).all(...ticketParams);

  const assets = db.prepare(
    `SELECT id, tag, name, type, status FROM assets
     WHERE workspace_id = ? AND (name LIKE ? OR tag LIKE ?)
     ORDER BY created_at DESC LIMIT 5`
  ).all(req.workspaceId, like, like);

  const kb = db.prepare(
    `SELECT id, title, category FROM kb_articles
     WHERE workspace_id = ? AND (title LIKE ? OR body LIKE ? OR tags LIKE ?)
     ORDER BY updated_at DESC LIMIT 5`
  ).all(req.workspaceId, like, like, like);

  // Catalog items so the Requester Portal's home search can span knowledge +
  // catalog from one box (see PortalHome.jsx) -- everyone can browse the
  // catalog today (Catalog.jsx has no role gate either), so no row filter
  // needed here, just the same enabled=1 scoping the catalog list route uses.
  const catalog = db.prepare(
    `SELECT id, name, description, icon FROM catalog_items
     WHERE workspace_id = ? AND enabled = 1 AND (name LIKE ? OR description LIKE ?)
     ORDER BY created_at DESC LIMIT 5`
  ).all(req.workspaceId, like, like);

  res.json({ tickets, assets, kb, catalog });
});

export default router;
