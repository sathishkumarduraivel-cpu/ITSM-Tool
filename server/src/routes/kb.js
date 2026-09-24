// Knowledge base API.
//
// The previous version was six unguarded CRUD routes: any authenticated user
// could list every article, including internal runbooks, by calling the API
// directly -- only the frontend hid them. Every read here goes through the
// same visibility predicate as the service layer, so there is one answer to
// "who can see this" rather than one per endpoint.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import {
  KbError, STATUSES, VISIBILITIES, ARTICLE_TYPES, DEFAULT_REVIEW_DAYS,
  canManage, canPublish, canRead, getArticle, hydrate, listArticles,
  createArticle, updateArticle, deleteArticle, transition, availableTransitions,
  markReviewed, listVersions, getVersion, restoreVersion,
  recordView, recordFeedback, linkTicket, unlinkTicket, draftFromTicket, ensureIndexed,
} from '../services/kbArticles.js';
import { search, logSearch, recordSearchClick, relatedArticles, suggestForTicket } from '../services/kbSearch.js';
import {
  contentGaps, unhelpfulSearches, failingArticles, reviewQueue, deflection, overview, articleStats,
} from '../services/kbAnalytics.js';
import {
  listCategories, categoryTree, createCategory, updateCategory, deleteCategory,
} from '../services/kbCategories.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

function handle(req, res, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof KbError) {
      return res.status(err.status).json({ error: err.message, ...(err.field_errors ? { field_errors: err.field_errors } : {}) });
    }
    console.error('[kb]', err);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

function requireManage(req, res, next) {
  if (canManage(req.user)) return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
}

// ------------------------------------------------------------------- meta

router.get('/meta', (req, res) => {
  res.json({
    statuses: Object.entries(STATUSES).map(([key, v]) => ({ key, ...v })),
    visibilities: Object.entries(VISIBILITIES).map(([key, v]) => ({ key, ...v })),
    article_types: Object.entries(ARTICLE_TYPES).map(([key, v]) => ({ key, ...v })),
    default_review_days: DEFAULT_REVIEW_DAYS,
    can_manage: canManage(req.user),
    can_publish: canPublish(req.user),
  });
});

// ------------------------------------------------------------- categories

router.get('/categories', (req, res) => {
  res.json({ categories: listCategories(req.workspaceId), tree: categoryTree(req.workspaceId) });
});

router.post('/categories', requireManage, (req, res) => handle(req, res, () => {
  const category = createCategory(req.workspaceId, req.body || {});
  logAudit(req, { action: 'kb_category.create', entityType: 'kb_category', entityId: category.id, entityLabel: category.name });
  return res.status(201).json({ category });
}));

router.patch('/categories/:id', requireManage, (req, res) => handle(req, res, () => (
  res.json({ category: updateCategory(req.workspaceId, req.params.id, req.body || {}) })
)));

router.delete('/categories/:id', requireManage, (req, res) => handle(req, res, () => (
  res.json(deleteCategory(req.workspaceId, req.params.id))
)));

// ----------------------------------------------------------------- search

// Mounted before /:id so a search never gets read as an article id.
router.get('/search', (req, res) => handle(req, res, () => {
  const q = req.query.q || '';
  const result = search(req.workspaceId, req.user, q, {
    limit: parseInt(req.query.limit, 10) || 20,
    categoryId: req.query.category_id || null,
    type: req.query.type || null,
    status: req.query.status || null,
  });
  // The STRICT count is what gets logged, not what was displayed. A query
  // that only produced results after widening is one the knowledge base did
  // not actually answer, and it belongs in the content-gap report.
  const searchId = logSearch(req.workspaceId, req.user, q, result.strict_total ?? result.total, req.query.source || 'kb');
  return res.json({ ...result, search_id: searchId });
}));

// Which result was opened, so a search that returned junk is distinguishable
// from one that worked.
router.post('/search/:searchId/click', (req, res) => handle(req, res, () => {
  recordSearchClick(req.workspaceId, req.params.searchId, req.body?.article_id || null);
  return res.json({ ok: true });
}));

// ------------------------------------------------------------- analytics
// Reporting is staff-only: search queries are users' own words and can be
// personal, and the review queue is a work list, not public information.

router.get('/analytics/overview', requireManage, (req, res) => {
  res.json(overview(req.workspaceId, req.user, { days: clampDays(req.query.days) }));
});

router.get('/analytics/gaps', requireManage, (req, res) => {
  res.json({
    ...contentGaps(req.workspaceId, { days: clampDays(req.query.days), limit: 25 }),
    unhelpful_searches: unhelpfulSearches(req.workspaceId, { days: clampDays(req.query.days) }),
  });
});

router.get('/analytics/failing', requireManage, (req, res) => {
  res.json({ articles: failingArticles(req.workspaceId, {}) });
});

router.get('/analytics/review-queue', requireManage, (req, res) => {
  res.json(reviewQueue(req.workspaceId, {}));
});

router.get('/analytics/deflection', requireManage, (req, res) => {
  res.json(deflection(req.workspaceId, { days: clampDays(req.query.days) }));
});

function clampDays(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 30;
  return Math.min(365, Math.max(1, n));
}

// ----------------------------------------------------------- ticket links

// What the service desk should read before answering this ticket. Plain
// search, so it works with no AI credentials configured.
router.get('/suggest/:ticketId', (req, res) => handle(req, res, () => {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ?').get(req.params.ticketId, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  return res.json({ articles: suggestForTicket(req.workspaceId, req.user, ticket) });
}));

// Start an article from a ticket that has already been solved. This is how
// knowledge bases actually get written.
router.post('/from-ticket/:ticketId', requireManage, (req, res) => handle(req, res, () => {
  const article = draftFromTicket(req.workspaceId, req.user, req.params.ticketId);
  logAudit(req, { action: 'kb_article.from_ticket', entityType: 'kb_article', entityId: article.id, entityLabel: article.title });
  return res.status(201).json({ article });
}));

// ---------------------------------------------------------------- articles

router.get('/', (req, res) => handle(req, res, () => {
  ensureIndexed(req.workspaceId);
  return res.json({
    articles: listArticles(req.workspaceId, req.user, {
      status: req.query.status || null,
      visibility: req.query.visibility || null,
      categoryId: req.query.category_id || null,
      type: req.query.type || null,
      tag: req.query.tag || null,
      stale: req.query.stale === '1',
      mine: req.query.mine === '1',
      limit: parseInt(req.query.limit, 10) || 200,
    }),
  });
}));

router.post('/', requireManage, (req, res) => handle(req, res, () => {
  const article = createArticle(req.workspaceId, req.user, req.body || {});
  logAudit(req, { action: 'kb_article.create', entityType: 'kb_article', entityId: article.id, entityLabel: article.title });
  return res.status(201).json({ article });
}));

router.get('/:id', (req, res) => handle(req, res, () => {
  const article = getArticle(req.workspaceId, req.params.id);
  // A 404 rather than a 403 for something the reader may not see: a 403 would
  // confirm the article exists, which for an internal runbook is itself a
  // disclosure.
  if (!article || !canRead(req.user, article)) return res.status(404).json({ error: 'Not found' });

  recordView(req.workspaceId, article.id, req.user.id, req.query.source || 'kb');
  if (req.query.search_id) recordSearchClick(req.workspaceId, req.query.search_id, article.id);

  const hydrated = hydrate(req.workspaceId, getArticle(req.workspaceId, article.id));
  return res.json({
    article: hydrated,
    related: relatedArticles(req.workspaceId, req.user, article),
    transitions: canManage(req.user) ? availableTransitions(req.user, article) : [],
    my_feedback: db.prepare('SELECT helpful, comment FROM kb_feedback WHERE article_id = ? AND user_id = ?')
      .get(article.id, req.user.id) || null,
    stats: canManage(req.user) ? articleStats(req.workspaceId, article.id) : null,
  });
}));

router.patch('/:id', requireManage, (req, res) => handle(req, res, () => {
  const article = updateArticle(req.workspaceId, req.user, req.params.id, req.body || {});
  logAudit(req, { action: 'kb_article.update', entityType: 'kb_article', entityId: article.id, entityLabel: article.title });
  return res.json({ article });
}));

router.delete('/:id', requireManage, (req, res) => handle(req, res, () => {
  const article = getArticle(req.workspaceId, req.params.id);
  const result = deleteArticle(req.workspaceId, req.user, req.params.id);
  logAudit(req, { action: 'kb_article.delete', entityType: 'kb_article', entityId: req.params.id, entityLabel: article?.title });
  return res.json(result);
}));

// --------------------------------------------------------------- lifecycle

router.post('/:id/transition', requireManage, (req, res) => handle(req, res, () => {
  const article = transition(req.workspaceId, req.user, req.params.id, req.body?.to, { note: req.body?.note });
  logAudit(req, { action: `kb_article.${article.status}`, entityType: 'kb_article', entityId: article.id, entityLabel: article.title });
  return res.json({ article });
}));

router.post('/:id/reviewed', requireManage, (req, res) => handle(req, res, () => (
  res.json({ article: markReviewed(req.workspaceId, req.user, req.params.id) })
)));

// ---------------------------------------------------------------- versions

router.get('/:id/versions', requireManage, (req, res) => handle(req, res, () => (
  res.json({ versions: listVersions(req.workspaceId, req.params.id) })
)));

router.get('/:id/versions/:version', requireManage, (req, res) => handle(req, res, () => {
  const version = getVersion(req.workspaceId, req.params.id, parseInt(req.params.version, 10));
  if (!version) return res.status(404).json({ error: 'Version not found' });
  return res.json({ version });
}));

router.post('/:id/versions/:version/restore', requireManage, (req, res) => handle(req, res, () => {
  const article = restoreVersion(req.workspaceId, req.user, req.params.id, parseInt(req.params.version, 10));
  logAudit(req, { action: 'kb_article.restore', entityType: 'kb_article', entityId: article.id, entityLabel: article.title });
  return res.json({ article });
}));

// ---------------------------------------------------------------- feedback

// Any reader may say whether an article helped -- that is the whole point,
// and restricting it to staff would measure the wrong population.
router.post('/:id/feedback', (req, res) => handle(req, res, () => (
  res.json({
    article: recordFeedback(req.workspaceId, req.user, req.params.id, {
      helpful: req.body?.helpful,
      comment: req.body?.comment || null,
      context: req.body?.context || 'kb',
    }),
  })
)));

router.post('/:id/tickets', requireManage, (req, res) => handle(req, res, () => (
  res.json(linkTicket(req.workspaceId, req.user, req.params.id, req.body?.ticket_id, req.body?.relation || 'resolved_with'))
)));

router.delete('/:id/tickets/:ticketId', requireManage, (req, res) => handle(req, res, () => (
  res.json(unlinkTicket(req.workspaceId, req.params.id, req.params.ticketId, req.query.relation || 'resolved_with'))
)));

export default router;
