// Knowledge categories.
//
// Articles carried a free-text `category` string, which meant "Network",
// "network" and "Networking" were three different categories and nothing
// could be browsed -- only searched. These are real rows with a parent, so
// the portal can show a structure and an article can be filed rather than
// labelled.
//
// The old string column is kept in step on write (see kbArticles.js) because
// the AI self-service path and a couple of reports still read it.
import { db, uid } from '../db.js';
import { KbError } from './kbArticles.js';

const MAX_DEPTH = 4;

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'category';
}

function uniqueSlug(workspaceId, name, excludeId = null) {
  const base = slugify(name);
  let candidate = base;
  let n = 2;
  for (;;) {
    const clash = db.prepare('SELECT id FROM kb_categories WHERE workspace_id = ? AND slug = ? AND id IS NOT ?')
      .get(workspaceId, candidate, excludeId);
    if (!clash) return candidate;
    candidate = `${base}-${n}`;
    n += 1;
  }
}

export function listCategories(workspaceId) {
  const counts = new Map(
    db.prepare(
      `SELECT category_id, COUNT(*) c FROM kb_articles
       WHERE workspace_id = ? AND category_id IS NOT NULL AND status = 'published' GROUP BY category_id`
    ).all(workspaceId).map((r) => [r.category_id, r.c])
  );
  return db.prepare('SELECT * FROM kb_categories WHERE workspace_id = ? ORDER BY sort_order, name')
    .all(workspaceId)
    .map((c) => ({ ...c, article_count: counts.get(c.id) || 0 }));
}

export function categoryTree(workspaceId) {
  const all = listCategories(workspaceId);
  const nodes = new Map(all.map((c) => [c.id, { ...c, children: [] }]));
  const roots = [];
  for (const c of all) {
    const node = nodes.get(c.id);
    const parent = c.parent_id ? nodes.get(c.parent_id) : null;
    if (parent && parent !== node) parent.children.push(node); else roots.push(node);
  }
  return roots;
}

function descendantIds(workspaceId, categoryId) {
  const all = db.prepare('SELECT id, parent_id FROM kb_categories WHERE workspace_id = ?').all(workspaceId);
  const out = new Set([categoryId]);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    let grew = false;
    for (const c of all) {
      if (c.parent_id && out.has(c.parent_id) && !out.has(c.id)) { out.add(c.id); grew = true; }
    }
    if (!grew) break;
  }
  return out;
}

export function createCategory(workspaceId, body) {
  const name = String(body.name || '').trim();
  if (!name) throw new KbError('A name is required');
  if (body.parent_id) {
    const parent = db.prepare('SELECT id FROM kb_categories WHERE id = ? AND workspace_id = ?').get(body.parent_id, workspaceId);
    if (!parent) throw new KbError('Parent category not found', 404);
  }
  const { max } = db.prepare('SELECT COALESCE(MAX(sort_order),0) max FROM kb_categories WHERE workspace_id = ?').get(workspaceId);
  const id = uid('kbc');
  db.prepare(
    'INSERT INTO kb_categories (id, workspace_id, name, slug, description, parent_id, icon, sort_order) VALUES (?,?,?,?,?,?,?,?)'
  ).run(id, workspaceId, name, uniqueSlug(workspaceId, name), body.description || null, body.parent_id || null, body.icon || null, max + 10);
  return db.prepare('SELECT * FROM kb_categories WHERE id = ?').get(id);
}

export function updateCategory(workspaceId, id, body) {
  const category = db.prepare('SELECT * FROM kb_categories WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!category) throw new KbError('Category not found', 404);

  if (body.parent_id !== undefined && body.parent_id) {
    if (body.parent_id === id) throw new KbError('A category cannot be its own parent');
    // Re-parenting under one of its own descendants would make the tree a
    // ring, and every walk would then depend on the depth guard rather than
    // on the data being sane.
    if (descendantIds(workspaceId, id).has(body.parent_id)) {
      throw new KbError('That would put the category underneath itself');
    }
    const parent = db.prepare('SELECT id FROM kb_categories WHERE id = ? AND workspace_id = ?').get(body.parent_id, workspaceId);
    if (!parent) throw new KbError('Parent category not found', 404);
  }

  const sets = []; const params = [];
  for (const field of ['name', 'description', 'parent_id', 'icon', 'sort_order']) {
    if (body[field] === undefined) continue;
    sets.push(`${field} = ?`);
    params.push(field === 'parent_id' && !body[field] ? null : body[field]);
  }
  if (body.name !== undefined) { sets.push('slug = ?'); params.push(uniqueSlug(workspaceId, body.name, id)); }
  if (!sets.length) return category;
  params.push(id);
  db.prepare(`UPDATE kb_categories SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return db.prepare('SELECT * FROM kb_categories WHERE id = ?').get(id);
}

export function deleteCategory(workspaceId, id) {
  const category = db.prepare('SELECT * FROM kb_categories WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!category) throw new KbError('Category not found', 404);

  const children = db.prepare('SELECT COUNT(*) c FROM kb_categories WHERE parent_id = ?').get(id).c;
  if (children) throw new KbError(`${children} sub-categor${children === 1 ? 'y sits' : 'ies sit'} under this one`);

  const articles = db.prepare('SELECT COUNT(*) c FROM kb_articles WHERE category_id = ?').get(id).c;
  // Articles are unfiled rather than deleted: losing knowledge because
  // somebody tidied the categories would be an appalling trade.
  if (articles) db.prepare('UPDATE kb_articles SET category_id = NULL WHERE category_id = ?').run(id);

  db.prepare('DELETE FROM kb_categories WHERE id = ?').run(id);
  return { ok: true, articles_unfiled: articles };
}
