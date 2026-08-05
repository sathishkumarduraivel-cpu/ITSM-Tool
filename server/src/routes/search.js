import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, attachWorkspace } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, attachWorkspace);

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ tickets: [], assets: [], kb: [] });
  const like = `%${q}%`;

  const tickets = db.prepare(
    `SELECT id, number, title, status, priority, type FROM tickets
     WHERE title LIKE ? OR number LIKE ? OR description LIKE ?
     ORDER BY created_at DESC LIMIT 5`
  ).all(like, like, like);

  const assets = db.prepare(
    `SELECT id, tag, name, type, status FROM assets
     WHERE name LIKE ? OR tag LIKE ?
     ORDER BY created_at DESC LIMIT 5`
  ).all(like, like);

  const kb = db.prepare(
    `SELECT id, title, category FROM kb_articles
     WHERE title LIKE ? OR body LIKE ? OR tags LIKE ?
     ORDER BY updated_at DESC LIMIT 5`
  ).all(like, like, like);

  res.json({ tickets, assets, kb });
});

export default router;
