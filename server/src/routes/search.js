import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tickets: [], assets: [], kb: [] });
  const like = `%${q}%`;

  const tickets = db.prepare(
    `SELECT id, number, title, status, priority, type FROM tickets
     WHERE workspace_id = ? AND (title LIKE ? OR number LIKE ? OR description LIKE ?)
     ORDER BY created_at DESC LIMIT 5`
  ).all(req.workspaceId, like, like, like);

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

  res.json({ tickets, assets, kb });
});

export default router;
