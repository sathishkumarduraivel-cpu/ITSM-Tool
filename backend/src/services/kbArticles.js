// Knowledge articles: who may read them, how they move from a draft to
// something people rely on, and what the text said before somebody edited it.
//
// Three ideas carry this module.
//
// 1. VISIBILITY is enforced here, not in the UI. The previous route let any
//    authenticated user list every article, so a requester could read an
//    internal runbook by calling the API directly. Every read path in this
//    file goes through the same predicate.
// 2. A LIFECYCLE, because knowledge that nobody approved and nobody revisits
//    is how a knowledge base becomes a liability -- people follow it, it is
//    wrong, and they stop trusting all of it.
// 3. VERSIONS, because a runbook edited badly at 2am is otherwise
//    unrecoverable.
import { db, uid } from '../db.js';

export class KbError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const STATUSES = {
  draft: { label: 'Draft', description: 'Being written. Only the author and knowledge managers can see it.' },
  in_review: { label: 'In review', description: 'Waiting for someone to check it before it goes out.' },
  published: { label: 'Published', description: 'Live, subject to its audience.' },
  retired: { label: 'Retired', description: 'Withdrawn, kept for the record.' },
};

// Who an article is for. Deliberately three levels, not a boolean: the useful
// distinction is not "public or not" but "customers / all staff / the people
// who run the systems".
export const VISIBILITIES = {
  portal: { label: 'Everyone', description: 'Visible to requesters in the portal and to all staff.', rank: 0 },
  agents: { label: 'Agents only', description: 'Staff working tickets. Not shown to requesters.', rank: 1 },
  internal: { label: 'Knowledge team only', description: 'Runbooks and sensitive procedures. Authors, owners and knowledge managers.', rank: 2 },
};

export const ARTICLE_TYPES = {
  how_to: { label: 'How-to', hint: 'Step-by-step instructions for a task somebody wants to do.' },
  troubleshooting: { label: 'Troubleshooting', hint: 'Symptom, cause, fix. For something that has gone wrong.' },
  known_error: { label: 'Known error', hint: 'A documented fault with a workaround, usually linked to a problem record.' },
  faq: { label: 'FAQ', hint: 'A short answer to a question that keeps being asked.' },
  policy: { label: 'Policy', hint: 'What the organisation requires, rather than how to do something.' },
  runbook: { label: 'Runbook', hint: 'Operational procedure for the team who run a service.' },
};

// Articles go stale silently. A default review interval means every published
// article has a date by which somebody has to look at it again.
export const DEFAULT_REVIEW_DAYS = 180;

// ------------------------------------------------------------- permissions

export function canManage(user) {
  return ['agent', 'admin'].includes(user?.role) || !!user?.permissions?.includes('kb.manage');
}

// Publishing, approving and retiring are a narrower right than authoring:
// anyone who can raise a draft should not automatically be able to put it in
// front of customers.
export function canPublish(user) {
  return user?.role === 'admin' || !!user?.permissions?.includes('kb.manage');
}

const isStaff = (user) => ['agent', 'admin'].includes(user?.role);

/**
 * Can this user read this article.
 *
 * Unpublished work is visible only to the people responsible for it. A
 * published article is then filtered by audience.
 */
export function canRead(user, article) {
  if (!article) return false;
  if (canPublish(user)) return true;

  const mine = article.author_id === user?.id || article.owner_id === user?.id;
  if (article.status !== 'published') {
    // A reviewer needs to see what they have been asked to review.
    return mine || (article.status === 'in_review' && article.reviewer_id === user?.id);
  }
  if (article.visibility === 'internal') return mine;
  if (article.visibility === 'agents') return isStaff(user);
  return true;
}

/**
 * The same rule as SQL, for list queries.
 *
 * Kept next to canRead so the two cannot drift: a list that shows what the
 * detail view then refuses to open is worse than either being wrong alone.
 */
export function readableClause(user, alias = '') {
  if (canPublish(user)) return { sql: '1=1', params: [] };

  // The alias is passed in rather than patched into the SQL afterwards: the
  // search query joins kb_fts to kb_articles, so every column here has to be
  // qualified, and rewriting column names with a regex is the kind of thing
  // that breaks silently the moment a column is renamed.
  const c = alias ? `${alias}.` : '';
  const uid_ = user?.id || '';
  if (isStaff(user)) {
    return {
      sql: `(
        (${c}status = 'published' AND ${c}visibility IN ('portal','agents'))
        OR (${c}status = 'published' AND ${c}visibility = 'internal' AND (${c}author_id = ? OR ${c}owner_id = ?))
        OR (${c}status != 'published' AND (${c}author_id = ? OR ${c}owner_id = ? OR ${c}reviewer_id = ?))
      )`,
      params: [uid_, uid_, uid_, uid_, uid_],
    };
  }
  // Requesters: published, portal-visible, and nothing else. Their own drafts
  // are not a case that exists -- they cannot author.
  return { sql: `(${c}status = 'published' AND ${c}visibility = 'portal')`, params: [] };
}

// ------------------------------------------------------------------- slugs

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'article';
}

function uniqueSlug(workspaceId, title, excludeId = null) {
  const base = slugify(title);
  let candidate = base;
  let n = 2;
  for (;;) {
    const clash = db.prepare(
      'SELECT id FROM kb_articles WHERE workspace_id = ? AND slug = ? AND id IS NOT ?'
    ).get(workspaceId, candidate, excludeId);
    if (!clash) return candidate;
    candidate = `${base}-${n}`;
    n += 1;
  }
}

// --------------------------------------------------------------- full text

// The index carries every article, drafts included; who may see what is
// decided at query time. Called on every write.
export function reindex(articleId) {
  const a = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(articleId);
  db.prepare('DELETE FROM kb_fts WHERE article_id = ?').run(articleId);
  if (!a) return;
  db.prepare(
    'INSERT INTO kb_fts (article_id, workspace_id, title, summary, body, tags) VALUES (?,?,?,?,?,?)'
  ).run(a.id, a.workspace_id, a.title || '', a.summary || '', a.body || '', a.tags || '');
}

// Backfills the index for articles that predate it, and repairs it if it ever
// drifts. Cheap enough to call on first search rather than needing a job.
export function ensureIndexed(workspaceId) {
  const { missing } = db.prepare(
    `SELECT COUNT(*) missing FROM kb_articles a
     WHERE a.workspace_id = ? AND NOT EXISTS (SELECT 1 FROM kb_fts f WHERE f.article_id = a.id)`
  ).get(workspaceId);
  if (!missing) return 0;

  const rows = db.prepare(
    `SELECT a.* FROM kb_articles a
     WHERE a.workspace_id = ? AND NOT EXISTS (SELECT 1 FROM kb_fts f WHERE f.article_id = a.id)`
  ).all(workspaceId);
  db.exec('BEGIN');
  try {
    for (const a of rows) {
      db.prepare('INSERT INTO kb_fts (article_id, workspace_id, title, summary, body, tags) VALUES (?,?,?,?,?,?)')
        .run(a.id, a.workspace_id, a.title || '', a.summary || '', a.body || '', a.tags || '');
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows.length;
}

// ------------------------------------------------------------------- reads

export function getArticle(workspaceId, idOrSlug) {
  return db.prepare('SELECT * FROM kb_articles WHERE workspace_id = ? AND (id = ? OR slug = ?)')
    .get(workspaceId, idOrSlug, idOrSlug) || null;
}

export function hydrate(workspaceId, article) {
  if (!article) return null;
  const category = article.category_id
    ? db.prepare('SELECT id, name, slug FROM kb_categories WHERE id = ?').get(article.category_id)
    : null;
  return {
    ...article,
    tag_list: parseTags(article.tags),
    category: category || (article.category ? { id: null, name: article.category, slug: null } : null),
    status_meta: STATUSES[article.status] || null,
    visibility_meta: VISIBILITIES[article.visibility] || null,
    type_meta: ARTICLE_TYPES[article.article_type] || null,
    // Stale is a fact about the article, not a separate state to maintain.
    is_stale: !!(article.review_due_at && String(article.review_due_at).slice(0, 10) < today()),
    linked_tickets: db.prepare(
      `SELECT lt.relation, t.id, t.number, t.title, t.status FROM kb_article_tickets lt
       JOIN tickets t ON t.id = lt.ticket_id WHERE lt.article_id = ? ORDER BY lt.created_at DESC`
    ).all(article.id),
    version_count: db.prepare('SELECT COUNT(*) c FROM kb_article_versions WHERE article_id = ?').get(article.id).c,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

export function parseTags(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((t) => t.trim()).filter(Boolean);
}

export function serializeTags(tags) {
  if (!tags) return null;
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  const clean = [...new Set(list.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
  return clean.length ? clean.join(', ') : null;
}

export function listArticles(workspaceId, user, {
  status = null, visibility = null, categoryId = null, type = null, tag = null,
  stale = false, mine = false, limit = 200,
} = {}) {
  const { sql: readable, params: readableParams } = readableClause(user);
  let sql = `SELECT * FROM kb_articles WHERE workspace_id = ? AND ${readable}`;
  const params = [workspaceId, ...readableParams];

  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (visibility) { sql += ' AND visibility = ?'; params.push(visibility); }
  if (categoryId) { sql += ' AND category_id = ?'; params.push(categoryId); }
  if (type) { sql += ' AND article_type = ?'; params.push(type); }
  if (tag) { sql += ' AND tags LIKE ?'; params.push(`%${tag}%`); }
  if (stale) { sql += " AND review_due_at IS NOT NULL AND substr(review_due_at,1,10) < ?"; params.push(today()); }
  if (mine && user?.id) { sql += ' AND (author_id = ? OR owner_id = ?)'; params.push(user.id, user.id); }

  sql += ' ORDER BY updated_at DESC LIMIT ?';
  params.push(Math.min(500, Math.max(1, limit)));
  return db.prepare(sql).all(...params).map((a) => hydrate(workspaceId, a));
}

// ------------------------------------------------------------------ writes

const EDITABLE = ['title', 'summary', 'body', 'tags', 'category_id', 'article_type', 'visibility', 'owner_id', 'reviewer_id', 'review_interval_days', 'problem_ticket_id'];

function validate(workspaceId, body, { partial = false } = {}) {
  const errors = [];
  if (!partial || body.title !== undefined) {
    if (!String(body.title || '').trim()) errors.push({ field: 'title', message: 'A title is required' });
  }
  if (!partial || body.body !== undefined) {
    if (!String(body.body || '').trim()) errors.push({ field: 'body', message: 'The article needs some content' });
  }
  if (body.visibility !== undefined && !VISIBILITIES[body.visibility]) {
    errors.push({ field: 'visibility', message: `Unknown audience: ${body.visibility}` });
  }
  if (body.article_type !== undefined && !ARTICLE_TYPES[body.article_type]) {
    errors.push({ field: 'article_type', message: `Unknown article type: ${body.article_type}` });
  }
  if (body.category_id) {
    const cat = db.prepare('SELECT id FROM kb_categories WHERE id = ? AND workspace_id = ?').get(body.category_id, workspaceId);
    if (!cat) errors.push({ field: 'category_id', message: 'That category does not exist' });
  }
  if (body.problem_ticket_id) {
    const t = db.prepare("SELECT id, type FROM tickets WHERE id = ? AND workspace_id = ?").get(body.problem_ticket_id, workspaceId);
    if (!t) errors.push({ field: 'problem_ticket_id', message: 'That ticket does not exist' });
  }
  if (body.review_interval_days !== undefined && body.review_interval_days !== null && body.review_interval_days !== '') {
    const n = Number(body.review_interval_days);
    if (!Number.isInteger(n) || n < 1) errors.push({ field: 'review_interval_days', message: 'Review interval must be a whole number of days' });
  }
  return errors;
}

export function createArticle(workspaceId, user, body) {
  const errors = validate(workspaceId, body);
  if (errors.length) throw Object.assign(new KbError('Some fields need attention'), { field_errors: errors });

  const id = uid('kb');
  // A new article starts as a draft unless somebody who can publish says
  // otherwise -- the safe default is "not yet in front of anyone".
  //
  // Written as an explicit downgrade rather than a ternary: the obvious
  // `requested === 'published' && canPublish ? 'published' : requested` reads
  // correctly and is wrong, because the else branch hands back the very
  // status that was just refused. An agent asking to publish would get it.
  let status = body.status || 'draft';
  if (!STATUSES[status]) throw new KbError(`Unknown status: ${status}`);
  if (status === 'retired') throw new KbError('An article cannot be created retired');
  if (status === 'published' && !canPublish(user)) status = 'draft';

  db.prepare(
    `INSERT INTO kb_articles (id, workspace_id, title, summary, body, tags, category_id, category, article_type,
                              visibility, status, slug, author_id, owner_id, reviewer_id, review_interval_days,
                              problem_ticket_id, version)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
  ).run(
    id, workspaceId, body.title.trim(), body.summary || null, body.body, serializeTags(body.tags),
    body.category_id || null,
    // The legacy free-text column is kept in step so older readers and the
    // AI self-service path, which still select it, do not suddenly see null.
    body.category_id ? db.prepare('SELECT name FROM kb_categories WHERE id = ?').get(body.category_id)?.name || null : (body.category || null),
    body.article_type || 'how_to', body.visibility || 'portal', status,
    uniqueSlug(workspaceId, body.title), user?.id || null, body.owner_id || user?.id || null,
    body.reviewer_id || null, body.review_interval_days ?? null, body.problem_ticket_id || null,
  );

  if (status === 'published') applyPublish(workspaceId, id, user, 'Created');
  reindex(id);
  return hydrate(workspaceId, getArticle(workspaceId, id));
}

export function updateArticle(workspaceId, user, id, body) {
  const article = getArticle(workspaceId, id);
  if (!article) throw new KbError('Article not found', 404);
  if (!canManage(user)) throw new KbError('Insufficient permissions', 403);

  const errors = validate(workspaceId, body, { partial: true });
  if (errors.length) throw Object.assign(new KbError('Some fields need attention'), { field_errors: errors });

  // Changing who an article is for is a publishing decision, not an edit.
  if (body.visibility !== undefined && body.visibility !== article.visibility && !canPublish(user)) {
    throw new KbError('Changing the audience of an article needs knowledge-manager rights', 403);
  }

  const sets = []; const params = [];
  for (const field of EDITABLE) {
    if (body[field] === undefined) continue;
    let v = body[field];
    if (field === 'tags') v = serializeTags(v);
    if (field === 'title') v = String(v).trim();
    if (v === '') v = null;
    sets.push(`${field} = ?`); params.push(v);
  }
  if (body.category_id !== undefined) {
    sets.push('category = ?');
    params.push(body.category_id ? db.prepare('SELECT name FROM kb_categories WHERE id = ?').get(body.category_id)?.name || null : null);
  }
  if (!sets.length) return hydrate(workspaceId, article);

  sets.push("updated_at = datetime('now')");
  params.push(article.id);
  db.prepare(`UPDATE kb_articles SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  reindex(article.id);
  return hydrate(workspaceId, getArticle(workspaceId, article.id));
}

export function deleteArticle(workspaceId, user, id) {
  const article = getArticle(workspaceId, id);
  if (!article) throw new KbError('Article not found', 404);
  // Deleting published knowledge loses the record of what people were told.
  // Retiring keeps it; deletion is reserved for drafts and for admins.
  if (article.status === 'published' && !canPublish(user)) {
    throw new KbError('Retire a published article rather than deleting it, or ask a knowledge manager', 403);
  }
  db.prepare('DELETE FROM kb_articles WHERE id = ?').run(article.id);
  db.prepare('DELETE FROM kb_fts WHERE article_id = ?').run(article.id);
  return { ok: true };
}

// --------------------------------------------------------------- lifecycle

const TRANSITIONS = {
  draft: ['in_review', 'published'],
  in_review: ['published', 'draft'],
  published: ['retired', 'draft'],
  retired: ['draft', 'published'],
};

export function availableTransitions(user, article) {
  const allowed = TRANSITIONS[article.status] || [];
  return allowed.map((to) => {
    const needsPublish = ['published', 'retired'].includes(to);
    return {
      to,
      label: to === 'in_review' ? 'Send for review'
        : to === 'published' ? (article.status === 'in_review' ? 'Approve & publish' : 'Publish')
          : to === 'retired' ? 'Retire'
            : article.status === 'in_review' ? 'Send back to draft' : 'Move to draft',
      allowed: !needsPublish || canPublish(user),
      blocker: needsPublish && !canPublish(user) ? 'Needs knowledge-manager rights' : null,
      ...STATUSES[to],
    };
  });
}

function publishBlockers(article) {
  const missing = [];
  if (!String(article.title || '').trim()) missing.push('a title');
  if (!String(article.body || '').trim()) missing.push('some content');
  // A summary is what the search results and the portal list actually show.
  // Publishing without one produces a result nobody can judge.
  if (!String(article.summary || '').trim()) missing.push('a summary');
  return missing;
}

function applyPublish(workspaceId, articleId, user, changeNote) {
  const article = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(articleId);
  const nextVersion = (db.prepare('SELECT MAX(version) m FROM kb_article_versions WHERE article_id = ?').get(articleId).m || 0) + 1;

  db.prepare(
    `INSERT INTO kb_article_versions (id, workspace_id, article_id, version, title, summary, body, tags, change_note, author_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(uid('kbv'), workspaceId, articleId, nextVersion, article.title, article.summary, article.body, article.tags,
    changeNote || null, user?.id || null);

  const days = article.review_interval_days || DEFAULT_REVIEW_DAYS;
  const due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

  db.prepare(
    `UPDATE kb_articles SET status = 'published', version = ?, published_at = datetime('now'), published_by = ?,
                            last_reviewed_at = datetime('now'), review_due_at = ?, retired_at = NULL,
                            updated_at = datetime('now')
     WHERE id = ?`
  ).run(nextVersion, user?.id || null, due, articleId);
}

export function transition(workspaceId, user, id, to, { note = null } = {}) {
  const article = getArticle(workspaceId, id);
  if (!article) throw new KbError('Article not found', 404);
  if (!canManage(user)) throw new KbError('Insufficient permissions', 403);
  if (!STATUSES[to]) throw new KbError(`Unknown status: ${to}`);

  const from = article.status || 'draft';
  if (from === to) return hydrate(workspaceId, article);
  if (!(TRANSITIONS[from] || []).includes(to)) {
    throw new KbError(`An article cannot go from ${STATUSES[from].label} to ${STATUSES[to].label}`);
  }
  if (['published', 'retired'].includes(to) && !canPublish(user)) {
    throw new KbError('Publishing and retiring need knowledge-manager rights', 403);
  }

  if (to === 'published') {
    const missing = publishBlockers(article);
    if (missing.length) throw new KbError(`This article still needs ${missing.join(', ')} before it can be published`);
    applyPublish(workspaceId, article.id, user, note);
  } else if (to === 'retired') {
    db.prepare("UPDATE kb_articles SET status = 'retired', retired_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(article.id);
  } else if (to === 'in_review') {
    db.prepare("UPDATE kb_articles SET status = 'in_review', submitted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(article.id);
  } else {
    db.prepare("UPDATE kb_articles SET status = 'draft', updated_at = datetime('now') WHERE id = ?").run(article.id);
  }

  reindex(article.id);
  return hydrate(workspaceId, getArticle(workspaceId, article.id));
}

// Confirming an article is still correct, without changing a word of it.
// Without this the only way to clear a review is to make a pointless edit.
export function markReviewed(workspaceId, user, id) {
  const article = getArticle(workspaceId, id);
  if (!article) throw new KbError('Article not found', 404);
  if (!canManage(user)) throw new KbError('Insufficient permissions', 403);

  const days = article.review_interval_days || DEFAULT_REVIEW_DAYS;
  const due = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  db.prepare("UPDATE kb_articles SET last_reviewed_at = datetime('now'), review_due_at = ? WHERE id = ?").run(due, article.id);
  return hydrate(workspaceId, getArticle(workspaceId, article.id));
}

// ---------------------------------------------------------------- versions

export function listVersions(workspaceId, id) {
  return db.prepare(
    `SELECT v.id, v.version, v.title, v.summary, v.change_note, v.author_id, v.created_at, u.name AS author_name
     FROM kb_article_versions v LEFT JOIN users u ON u.id = v.author_id
     WHERE v.article_id = ? AND v.workspace_id = ? ORDER BY v.version DESC`
  ).all(id, workspaceId);
}

export function getVersion(workspaceId, id, version) {
  return db.prepare('SELECT * FROM kb_article_versions WHERE article_id = ? AND workspace_id = ? AND version = ?')
    .get(id, workspaceId, version) || null;
}

export function restoreVersion(workspaceId, user, id, version) {
  const article = getArticle(workspaceId, id);
  if (!article) throw new KbError('Article not found', 404);
  if (!canManage(user)) throw new KbError('Insufficient permissions', 403);
  const snapshot = getVersion(workspaceId, id, version);
  if (!snapshot) throw new KbError('That version does not exist', 404);

  // Restoring writes the old text back as a DRAFT rather than republishing it
  // outright: putting a previous revision straight in front of customers is a
  // decision somebody should make deliberately.
  db.prepare(
    `UPDATE kb_articles SET title = ?, summary = ?, body = ?, tags = ?, status = 'draft', updated_at = datetime('now')
     WHERE id = ?`
  ).run(snapshot.title, snapshot.summary, snapshot.body, snapshot.tags, article.id);
  reindex(article.id);
  return hydrate(workspaceId, getArticle(workspaceId, article.id));
}

// ---------------------------------------------------------------- feedback

export function recordView(workspaceId, articleId, userId, source = 'kb') {
  db.prepare('INSERT INTO kb_article_views (id, workspace_id, article_id, user_id, source) VALUES (?,?,?,?,?)')
    .run(uid('kbw'), workspaceId, articleId, userId || null, source);
  db.prepare('UPDATE kb_articles SET views = COALESCE(views,0) + 1 WHERE id = ?').run(articleId);
}

/**
 * Was this useful. One row per person, so changing your mind corrects the
 * count rather than adding to it -- the old helpful_count column was never
 * written at all, which is its own kind of wrong.
 */
export function recordFeedback(workspaceId, user, articleId, { helpful, comment = null, context = 'kb' }) {
  const article = getArticle(workspaceId, articleId);
  if (!article) throw new KbError('Article not found', 404);
  if (!canRead(user, article)) throw new KbError('Article not found', 404);
  if (helpful !== true && helpful !== false) throw new KbError('Say whether it was helpful');

  const value = helpful ? 1 : 0;
  const existing = user?.id
    ? db.prepare('SELECT id FROM kb_feedback WHERE article_id = ? AND user_id = ?').get(articleId, user.id)
    : null;

  db.exec('BEGIN');
  try {
    if (existing) {
      db.prepare("UPDATE kb_feedback SET helpful = ?, comment = ?, context = ?, created_at = datetime('now') WHERE id = ?")
        .run(value, comment, context, existing.id);
    } else {
      db.prepare('INSERT INTO kb_feedback (id, workspace_id, article_id, user_id, helpful, comment, context) VALUES (?,?,?,?,?,?,?)')
        .run(uid('kbf'), workspaceId, articleId, user?.id || null, value, comment, context);
    }
    // Counters recomputed from the rows rather than incremented, so they can
    // never drift from the feedback that justifies them.
    const agg = db.prepare(
      'SELECT SUM(helpful) yes, SUM(CASE WHEN helpful = 0 THEN 1 ELSE 0 END) no FROM kb_feedback WHERE article_id = ?'
    ).get(articleId);
    db.prepare('UPDATE kb_articles SET helpful_count = ?, not_helpful_count = ? WHERE id = ?')
      .run(agg.yes || 0, agg.no || 0, articleId);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return hydrate(workspaceId, getArticle(workspaceId, articleId));
}

// ---------------------------------------------------------- ticket linkage

export function linkTicket(workspaceId, user, articleId, ticketId, relation = 'resolved_with') {
  const article = getArticle(workspaceId, articleId);
  if (!article) throw new KbError('Article not found', 404);
  const ticket = db.prepare('SELECT id FROM tickets WHERE id = ? AND workspace_id = ?').get(ticketId, workspaceId);
  if (!ticket) throw new KbError('Ticket not found', 404);
  if (!['resolved_with', 'source', 'related'].includes(relation)) throw new KbError(`Unknown relation: ${relation}`);

  const existing = db.prepare('SELECT id FROM kb_article_tickets WHERE article_id = ? AND ticket_id = ? AND relation = ?')
    .get(articleId, ticketId, relation);
  if (existing) return { ok: true, already_linked: true };

  db.prepare('INSERT INTO kb_article_tickets (id, workspace_id, article_id, ticket_id, relation, created_by) VALUES (?,?,?,?,?,?)')
    .run(uid('kbt'), workspaceId, articleId, ticketId, relation, user?.id || null);
  return { ok: true };
}

export function unlinkTicket(workspaceId, articleId, ticketId, relation = 'resolved_with') {
  db.prepare('DELETE FROM kb_article_tickets WHERE article_id = ? AND ticket_id = ? AND relation = ?')
    .run(articleId, ticketId, relation);
  return { ok: true };
}

/**
 * A draft article prefilled from a resolved ticket.
 *
 * This is how knowledge bases actually get written: somebody solves something
 * once and the answer is already typed out in the ticket. Asking them to
 * start from a blank page is why most ITSM knowledge bases stay empty.
 *
 * Deliberately NOT AI-dependent -- it structures what is already there, and
 * the AI draft endpoint is a separate, optional improvement on top.
 */
export function draftFromTicket(workspaceId, user, ticketId) {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ?').get(ticketId, workspaceId);
  if (!ticket) throw new KbError('Ticket not found', 404);

  // There is no resolution field on a ticket in this schema, so the last
  // public reply is the best available stand-in -- which is usually exactly
  // where the answer was typed. Private notes are skipped: they routinely
  // contain things that should not end up in an article.
  const resolution = db.prepare(
    `SELECT body FROM ticket_comments
     WHERE ticket_id = ? AND COALESCE(is_private, 0) = 0 AND COALESCE(is_ai, 0) = 0
     ORDER BY created_at DESC LIMIT 1`
  ).get(ticketId)?.body || '';

  const body = [
    '## Symptom', '', ticket.description || ticket.title, '',
    '## Resolution', '', resolution || '_Describe the steps that fixed it._', '',
    '## Applies to', '', ticket.category ? `Category: ${ticket.category}` : '_Add the systems or users this applies to._',
  ].join('\n');

  const article = createArticle(workspaceId, user, {
    title: ticket.title,
    summary: `How ${ticket.number} was resolved.`,
    body,
    category_id: null,
    category: ticket.category || null,
    article_type: ticket.type === 'problem' ? 'known_error' : 'troubleshooting',
    // A draft, and agent-visible: something written straight off a ticket has
    // not been checked for anything that should not reach a customer.
    visibility: 'agents',
    status: 'draft',
    problem_ticket_id: ticket.type === 'problem' ? ticket.id : null,
  });

  // Record where it came from, so the article can always be traced back to
  // the case that justified it.
  linkTicket(workspaceId, user, article.id, ticket.id, 'source');
  return hydrate(workspaceId, getArticle(workspaceId, article.id));
}
