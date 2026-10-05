// What the knowledge base is actually doing for you.
//
// Most KB reporting is a view counter, which tells you nothing you can act
// on: an article with 900 views might be the most useful page you have or the
// one everybody lands on and bounces off. The reports here are chosen so that
// every one of them ends in something to do.
//
// Computed on read from the raw event rows. Nothing is precomputed and
// nothing needs a scheduler -- the same reasoning the SLA clock and change
// risk already follow in this codebase.
import { db } from '../db.js';
import { readableClause, DEFAULT_REVIEW_DAYS } from './kbArticles.js';

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * What people searched for and did not find.
 *
 * This is the most directly useful thing in the module: a ranked list, in
 * users' own words, of the articles nobody has written. Grouped on the
 * normalized query so "vpn not working", "VPN not working" and "vpn  not
 * working" are one row rather than three.
 */
export function contentGaps(workspaceId, { days = 30, limit = 25 } = {}) {
  const since = daysAgo(days);
  const rows = db.prepare(
    `SELECT normalized AS query,
            COUNT(*) AS searches,
            COUNT(DISTINCT user_id) AS people,
            MAX(created_at) AS last_searched
     FROM kb_searches
     WHERE workspace_id = ? AND result_count = 0 AND substr(created_at,1,10) >= ?
     GROUP BY normalized
     ORDER BY searches DESC, people DESC
     LIMIT ?`
  ).all(workspaceId, since, limit);

  return {
    days,
    // Searches that found nothing, as a share of all searches. A rising
    // number means the estate is changing faster than the knowledge is.
    miss_rate: missRate(workspaceId, days),
    gaps: rows,
  };
}

function missRate(workspaceId, days) {
  const since = daysAgo(days);
  const { total, misses } = db.prepare(
    `SELECT COUNT(*) total, SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) misses
     FROM kb_searches WHERE workspace_id = ? AND substr(created_at,1,10) >= ?`
  ).get(workspaceId, since);
  if (!total) return null;
  return Math.round(((misses || 0) / total) * 1000) / 10;
}

/**
 * Searches that DID return results but where nobody opened anything.
 *
 * A subtler failure than a zero-result search and usually a worse one: the
 * articles exist, they came back, and they did not look like the answer.
 * That is a titling and summary problem, not a missing-content problem, and
 * the fix is completely different.
 */
export function unhelpfulSearches(workspaceId, { days = 30, limit = 25 } = {}) {
  const since = daysAgo(days);
  return db.prepare(
    `SELECT normalized AS query, COUNT(*) AS searches, AVG(result_count) AS avg_results
     FROM kb_searches
     WHERE workspace_id = ? AND result_count > 0 AND clicked_article_id IS NULL
       AND substr(created_at,1,10) >= ?
     GROUP BY normalized
     HAVING searches > 1
     ORDER BY searches DESC
     LIMIT ?`
  ).all(workspaceId, since, limit)
    .map((r) => ({ ...r, avg_results: Math.round(r.avg_results * 10) / 10 }));
}

/**
 * Articles readers said were NOT helpful.
 *
 * Ranked by the proportion rather than the raw count, so a page read twice
 * and disliked twice outranks one read a thousand times with ten complaints.
 * The comments come with it, because "not helpful" without a reason is not
 * actionable either.
 */
// minVotes is 1, not 2: a single "this did not help" with a written reason
// is real signal, and for a knowledge base that is just starting, waiting for
// a second vote means the report stays empty exactly when it would be most
// useful. The vote count travels with each row so the reader can judge.
export function failingArticles(workspaceId, { limit = 20, minVotes = 1 } = {}) {
  const rows = db.prepare(
    `SELECT a.id, a.title, a.slug, a.status, a.visibility,
            a.helpful_count, a.not_helpful_count,
            (a.helpful_count + a.not_helpful_count) AS votes
     FROM kb_articles a
     WHERE a.workspace_id = ? AND (a.helpful_count + a.not_helpful_count) >= ?
     ORDER BY (CAST(a.not_helpful_count AS REAL) / (a.helpful_count + a.not_helpful_count)) DESC,
              a.not_helpful_count DESC
     LIMIT ?`
  ).all(workspaceId, minVotes, limit);

  return rows
    .map((r) => ({
      ...r,
      unhelpful_rate: Math.round((r.not_helpful_count / r.votes) * 1000) / 10,
      comments: db.prepare(
        `SELECT comment, created_at FROM kb_feedback
         WHERE article_id = ? AND helpful = 0 AND comment IS NOT NULL AND comment != ''
         ORDER BY created_at DESC LIMIT 5`
      ).all(r.id).map((c) => c.comment),
    }))
    .filter((r) => r.not_helpful_count > 0);
}

/**
 * Articles due a look.
 *
 * Two separate things, deliberately not merged: one is past the review date
 * somebody set, the other has simply not been touched in a long time. An
 * article can be overdue without being old, and old without being wrong.
 */
export function reviewQueue(workspaceId, { staleDays = 365, limit = 50 } = {}) {
  const overdue = db.prepare(
    `SELECT id, title, slug, status, visibility, review_due_at, last_reviewed_at, owner_id, author_id
     FROM kb_articles
     WHERE workspace_id = ? AND status = 'published'
       AND review_due_at IS NOT NULL AND substr(review_due_at,1,10) < ?
     ORDER BY review_due_at ASC LIMIT ?`
  ).all(workspaceId, today(), limit);

  const neverReviewed = db.prepare(
    `SELECT id, title, slug, status, visibility, updated_at, owner_id, author_id
     FROM kb_articles
     WHERE workspace_id = ? AND status = 'published'
       AND review_due_at IS NULL AND substr(updated_at,1,10) < ?
     ORDER BY updated_at ASC LIMIT ?`
  ).all(workspaceId, daysAgo(staleDays), limit);

  const awaitingReview = db.prepare(
    `SELECT id, title, slug, submitted_at, author_id, reviewer_id
     FROM kb_articles WHERE workspace_id = ? AND status = 'in_review'
     ORDER BY submitted_at ASC LIMIT ?`
  ).all(workspaceId, limit);

  return {
    overdue,
    never_reviewed: neverReviewed,
    awaiting_review: awaitingReview,
    default_review_days: DEFAULT_REVIEW_DAYS,
  };
}

/**
 * Deflection: how often reading an article appears to have replaced raising a
 * ticket.
 *
 * Stated carefully. This counts self-service and portal article views that
 * were NOT followed by that person raising a ticket within the hour. That is
 * a correlation, not proof, and the number is labelled as an estimate
 * wherever it is shown -- a KB module claiming hard causal deflection is
 * selling something.
 */
export function deflection(workspaceId, { days = 30 } = {}) {
  const since = daysAgo(days);
  const views = db.prepare(
    `SELECT v.id, v.user_id, v.created_at
     FROM kb_article_views v
     WHERE v.workspace_id = ? AND v.source IN ('portal','self_service')
       AND substr(v.created_at,1,10) >= ? AND v.user_id IS NOT NULL`
  ).all(workspaceId, since);

  if (!views.length) return { days, views: 0, estimated_deflections: 0, rate: null, basis: 'No portal or self-service article views in this period.' };

  let deflected = 0;
  const raised = db.prepare(
    `SELECT requester_id, created_at FROM tickets
     WHERE workspace_id = ? AND substr(created_at,1,10) >= ?`
  ).all(workspaceId, since);

  const byUser = new Map();
  for (const t of raised) {
    if (!byUser.has(t.requester_id)) byUser.set(t.requester_id, []);
    byUser.get(t.requester_id).push(Date.parse(String(t.created_at).replace(' ', 'T') + 'Z'));
  }

  for (const v of views) {
    const at = Date.parse(String(v.created_at).replace(' ', 'T') + 'Z');
    const theirs = byUser.get(v.user_id) || [];
    const followedByTicket = theirs.some((t) => t >= at && t - at <= 3600000);
    if (!followedByTicket) deflected += 1;
  }

  return {
    days,
    views: views.length,
    estimated_deflections: deflected,
    rate: Math.round((deflected / views.length) * 1000) / 10,
    basis: 'Portal and self-service article views not followed by that person raising a ticket within an hour. An estimate, not a measurement.',
  };
}

// The headline numbers, plus the few articles worth looking at first.
export function overview(workspaceId, user, { days = 30 } = {}) {
  const since = daysAgo(days);
  const { sql: readable, params: readableParams } = readableClause(user);

  const counts = db.prepare(
    `SELECT
       COUNT(*) total,
       SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) published,
       SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) drafts,
       SUM(CASE WHEN status = 'in_review' THEN 1 ELSE 0 END) in_review,
       SUM(CASE WHEN status = 'retired' THEN 1 ELSE 0 END) retired,
       SUM(CASE WHEN status = 'published' AND review_due_at IS NOT NULL AND substr(review_due_at,1,10) < ? THEN 1 ELSE 0 END) overdue
     FROM kb_articles WHERE workspace_id = ?`
  ).get(today(), workspaceId);

  const searches = db.prepare(
    `SELECT COUNT(*) total, SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) misses
     FROM kb_searches WHERE workspace_id = ? AND substr(created_at,1,10) >= ?`
  ).get(workspaceId, since);

  const topViewed = db.prepare(
    `SELECT a.id, a.title, a.slug, COUNT(v.id) AS period_views
     FROM kb_articles a JOIN kb_article_views v ON v.article_id = a.id
     WHERE a.workspace_id = ? AND substr(v.created_at,1,10) >= ? AND ${readable}
     GROUP BY a.id ORDER BY period_views DESC LIMIT 5`
  ).all(workspaceId, since, ...readableParams);

  return {
    days,
    articles: counts,
    searches: {
      total: searches.total || 0,
      misses: searches.misses || 0,
      miss_rate: searches.total ? Math.round(((searches.misses || 0) / searches.total) * 1000) / 10 : null,
    },
    top_viewed: topViewed,
    deflection: deflection(workspaceId, { days }),
  };
}

// One article's own numbers, for the editor to see what their work is doing.
export function articleStats(workspaceId, articleId, { days = 90 } = {}) {
  const since = daysAgo(days);
  const article = db.prepare('SELECT * FROM kb_articles WHERE id = ? AND workspace_id = ?').get(articleId, workspaceId);
  if (!article) return null;

  const bySource = db.prepare(
    `SELECT source, COUNT(*) c FROM kb_article_views
     WHERE article_id = ? AND substr(created_at,1,10) >= ? GROUP BY source`
  ).all(articleId, since);

  const comments = db.prepare(
    `SELECT helpful, comment, created_at FROM kb_feedback
     WHERE article_id = ? AND comment IS NOT NULL AND comment != '' ORDER BY created_at DESC LIMIT 20`
  ).all(articleId);

  const votes = (article.helpful_count || 0) + (article.not_helpful_count || 0);
  return {
    days,
    lifetime_views: article.views || 0,
    period_views: bySource.reduce((n, r) => n + r.c, 0),
    views_by_source: bySource,
    helpful: article.helpful_count || 0,
    not_helpful: article.not_helpful_count || 0,
    helpful_rate: votes ? Math.round(((article.helpful_count || 0) / votes) * 1000) / 10 : null,
    comments,
    resolved_tickets: db.prepare(
      "SELECT COUNT(*) c FROM kb_article_tickets WHERE article_id = ? AND relation = 'resolved_with'"
    ).get(articleId).c,
  };
}
