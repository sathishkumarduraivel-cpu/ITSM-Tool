import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

// Every workspace is visible to everyone — there's no data isolation, so this
// is just the list shown in the workspace switcher.
router.get('/', requireAuth, (req, res) => {
  res.json({ workspaces: db.prepare('SELECT id, name, slug FROM workspaces ORDER BY name').all() });
});

router.post('/', requireAuth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const id = uid('ws');
  const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'workspace';
  let slug = slugBase;
  let n = 1;
  while (db.prepare('SELECT id FROM workspaces WHERE slug = ?').get(slug)) {
    slug = `${slugBase}-${++n}`;
  }
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, name, slug);
  res.status(201).json({ id, name, slug });
});

router.patch('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(name, req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', requireAuth, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM workspaces WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

export default router;
