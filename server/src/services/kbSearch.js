// Knowledge search.
//
// The old implementation was `title LIKE %q% OR body LIKE %q%` ordered by
// updated_at, which has two fatal properties: a word appearing once in a
// footnote ranks exactly as high as a word in the title, and results come
// back in the order they were last edited rather than by how well they match.
// For anything past about thirty articles that is indistinguishable from no
// search at all.
//
// This uses SQLite's own FTS5 with BM25 ranking and real snippets. No new
// dependency -- it is compiled into the SQLite that node:sqlite already
// ships, which was checked before this was written.
import { db, uid } from '../db.js';
import { readableClause, ensureIndexed, hydrate, parseTags } from './kbArticles.js';

// Columns are weighted, because where a term appears says a great deal about
// relevance: a match in the title is the article being ABOUT that thing, a
// match in the body might be an aside. bm25() takes one weight per column in
// declaration order (article_id, workspace_id, title, summary, body, tags);
// the two UNINDEXED columns still need a placeholder.
const WEIGHTS = [0.0, 0.0, 10.0, 4.0, 1.0, 6.0];

/**
 * FTS5 MATCH takes a query language, and raw user input is not it. A search
 * for "wi-fi (guest)" or a stray quote is a syntax error, which would surface
 * to the user as a 500 on a perfectly reasonable search.
 *
 * Every term is quoted as a literal and joined, with a prefix match on the
 * last token so results narrow as somebody types. `mode` picks the joiner:
 * 'all' (every term must appear) is the default, 'any' is the widening
 * fallback search() uses when nothing matched everything.
 */
export function buildMatchQuery(raw, { mode = 'all' } = {}) {
  const terms = String(raw || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 1);
  if (!terms.length) return null;

  const parts = terms.map((t, i) => {
    const quoted = `"${t.replace(/"/g, '""')}"`;
    // Prefix-match only the final term: mid-sentence prefixes make
    // everything match everything.
    return i === terms.length - 1 ? `${quoted}*` : quoted;
  });
  return parts.join(mode === 'any' ? ' OR ' : ' AND ');
}

export function termCount(raw) {
  return String(raw || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter((t) => t.length > 1).length;
}

export function normalizeQuery(raw) {
  return String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Search, filtered to what this reader is allowed to see.
 *
 * Visibility is applied as a join condition rather than after the fact, so
 * the result count a requester is shown is the count of what they can
 * actually open.
 */
export function search(workspaceId, user, rawQuery, opts = {}) {
  ensureIndexed(workspaceId);
  if (!buildMatchQuery(rawQuery)) return { query: rawQuery, results: [], total: 0, strict_total: 0, mode: null };

  // A caller can ask for loose matching outright. "Related articles" needs
  // this: its query is another article's own title, so the strict pass finds
  // that article and nothing else, and the widening step below never runs
  // because it only triggers on zero results.
  if (opts.mode === 'any') {
    const r = runSearch(workspaceId, user, rawQuery, opts, 'any');
    return { ...r, mode: 'any', strict_total: r.total };
  }

  // Every term must appear, which is what anyone typing a question expects.
  // OR was the first attempt and it was wrong in two ways at once: against a
  // real corpus "how do i claim expenses" comes back with whatever article
  // happens to contain "do", and because SOMETHING always matched, a search
  // that genuinely found nothing never registered as a content gap.
  const strict = runSearch(workspaceId, user, rawQuery, opts, 'all');
  if (strict.total > 0 || termCount(rawQuery) < 2) {
    return { ...strict, mode: 'all', strict_total: strict.total };
  }

  // Nothing matched every term. Widen rather than give up -- a near miss is
  // more useful than an empty page -- but carry strict_total separately.
  //
  // That distinction matters more than it looks. The gap report is driven by
  // strict_total, not total: a search for "how do i claim expenses" that only
  // came back because some article happens to contain "how" has not been
  // answered, and counting it as a hit would quietly empty the one report
  // that tells you what to write next.
  const loose = runSearch(workspaceId, user, rawQuery, opts, 'any');
  return { ...loose, mode: loose.total > 0 ? 'any' : 'all', strict_total: 0 };
}

function runSearch(workspaceId, user, rawQuery, { limit = 20, categoryId = null, type = null, status = null } = {}, mode) {
  const match = buildMatchQuery(rawQuery, { mode });

  const { sql: readable, params: readableParams } = readableClause(user, 'a');
  const params = [];

  // bm25 returns a negative number where more negative is a better match.
  let sql = `
    SELECT a.*,
           bm25(kb_fts, ${WEIGHTS.join(', ')}) AS rank,
           snippet(kb_fts, 4, '<mark>', '</mark>', '…', 18) AS body_excerpt,
           snippet(kb_fts, 3, '<mark>', '</mark>', '…', 14) AS summary_excerpt,
           snippet(kb_fts, 2, '<mark>', '</mark>', '…', 12) AS title_excerpt
    FROM kb_fts
    JOIN kb_articles a ON a.id = kb_fts.article_id
    WHERE kb_fts MATCH ?
      AND kb_fts.workspace_id = ?
      AND a.workspace_id = ?
      AND ${readable}
  `;
  params.push(match, workspaceId, workspaceId, ...readableParams);

  if (categoryId) { sql += ' AND a.category_id = ?'; params.push(categoryId); }
  if (type) { sql += ' AND a.article_type = ?'; params.push(type); }
  if (status) { sql += ' AND a.status = ?'; params.push(status); }

  // Retired articles are still findable by the people who maintain them, but
  // never float to the top of a search for anyone.
  sql += `
    ORDER BY CASE WHEN a.status = 'retired' THEN 1 ELSE 0 END,
             rank
    LIMIT ?`;
  params.push(Math.min(100, Math.max(1, limit)));

  let rows = [];
  try {
    rows = db.prepare(sql).all(...params);
  } catch (err) {
    // A malformed MATCH should degrade to "no results", never a 500.
    console.error('[kb-search]', err.message);
    return { query: rawQuery, results: [], total: 0, error: 'That search could not be understood' };
  }

  return {
    query: rawQuery,
    total: rows.length,
    results: rows.map((r) => ({
      ...hydrate(workspaceId, r),
      // snippet() only looks at one column, so a term that appears in the
      // title but not the body produced an excerpt with nothing highlighted.
      // Take the first column that actually matched.
      excerpt: [r.body_excerpt, r.summary_excerpt, r.title_excerpt]
        .find((e) => e && e.includes('<mark>')) || r.body_excerpt || null,
      // Flipped and rounded so a higher number means a better match, which is
      // what anyone reading the API would assume.
      score: Math.round(Math.abs(r.rank) * 1000) / 1000,
    })),
  };
}

/**
 * Record what was searched for and how many results came back.
 *
 * The zero-result rows are the point. They are a list, in the user's own
 * words, of the articles nobody has written -- the most directly actionable
 * output a knowledge base produces, and something almost no tool surfaces.
 */
export function logSearch(workspaceId, user, rawQuery, resultCount, source = 'kb') {
  const normalized = normalizeQuery(rawQuery);
  if (!normalized || normalized.length < 2) return null;
  const id = uid('kbs');
  db.prepare(
    'INSERT INTO kb_searches (id, workspace_id, query, normalized, result_count, user_id, source) VALUES (?,?,?,?,?,?,?)'
  ).run(id, workspaceId, String(rawQuery).slice(0, 300), normalized.slice(0, 300), resultCount, user?.id || null, source);
  return id;
}

// Which result the searcher actually opened. Without this, a search that
// returns twenty irrelevant articles looks identical to one that nailed it.
export function recordSearchClick(workspaceId, searchId, articleId) {
  db.prepare('UPDATE kb_searches SET clicked_article_id = ? WHERE id = ? AND workspace_id = ?')
    .run(articleId, searchId, workspaceId);
}

/**
 * Articles related to one you are reading, without needing anybody to curate
 * links by hand: the article's own title and tags, fed back through search.
 */
export function relatedArticles(workspaceId, user, article, limit = 5) {
  const seed = [article.title, parseTags(article.tags).join(' ')].filter(Boolean).join(' ');
  // Loose on purpose: this is a similarity question, not somebody's search.
  const { results } = search(workspaceId, user, seed, { limit: limit + 1, mode: 'any' });
  return results.filter((r) => r.id !== article.id).slice(0, limit);
}

/**
 * Suggestions for a ticket: what the service desk should read before
 * answering, drawn from the ticket's own words.
 *
 * Plain search rather than AI, so it works with no credentials configured --
 * the same rule the rest of this codebase follows.
 */
export function suggestForTicket(workspaceId, user, ticket, limit = 5) {
  const seed = [ticket.title, ticket.category, ticket.subcategory].filter(Boolean).join(' ');
  const { results } = search(workspaceId, user, seed, { limit, status: 'published' });
  return results;
}
