import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  const { q, category } = req.query;
  let sql = 'SELECT * FROM kb_articles WHERE 1=1';
  const params = [];
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (q) { sql += ' AND (title LIKE ? OR body LIKE ? OR tags LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  sql += ' ORDER BY updated_at DESC';
  res.json({ articles: db.prepare(sql).all(...params) });
});

router.get('/:id', requireAuth, (req, res) => {
  const article = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE kb_articles SET views = views + 1 WHERE id = ?').run(req.params.id);
  res.json({ article });
});

router.post('/', requireAuth, (req, res) => {
  const { title, category, body, tags } = req.body;
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  const id = uid('kb');
  db.prepare('INSERT INTO kb_articles (id, title, category, body, tags, author_id) VALUES (?,?,?,?,?,?)').run(
    id, title, category || null, body, tags || null, req.user.id
  );
  res.status(201).json({ article: db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(id) });
});

router.patch('/:id', requireAuth, (req, res) => {
  const article = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(req.params.id);
  if (!article) return res.status(404).json({ error: 'Not found' });
  const allowed = ['title', 'category', 'body', 'tags'];
  const fields = []; const params = [];
  for (const key of allowed) if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE kb_articles SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ article: db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(req.params.id) });
});

router.delete('/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM kb_articles WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
