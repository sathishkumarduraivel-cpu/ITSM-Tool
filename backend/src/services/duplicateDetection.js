import { db, uid } from '../db.js';

// Words that carry no signal about what is actually broken. Without this,
// "unable to access the printer" and "unable to access the VPN" look like a
// strong match because they share four words, three of which are noise.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'and', 'or', 'but', 'not', 'no', 'my', 'me', 'i', 'we', 'our', 'you', 'your', 'it',
  'this', 'that', 'these', 'those', 'from', 'by', 'as', 'can', 'cannot', 'cant', 'unable', 'issue',
  'problem', 'please', 'help', 'need', 'want', 'have', 'has', 'get', 'got', 'when', 'after', 'again',
  'am', 'pm', 'today', 'yesterday', 'now', 'still', 'also', 'very', 'any', 'all', 'about', 'into',
]);

export function tokenise(text) {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
  )];
}

// Jaccard over the union: shared words as a proportion of everything either
// title mentions. Overlap alone would rate a two-word title against a long
// one far too highly, because a short title can match almost anything.
export function titleSimilarity(a, b) {
  const A = new Set(tokenise(a));
  const B = new Set(tokenise(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared += 1;
  return shared / (A.size + B.size - shared);
}

// Weights are deliberately modest for the contextual signals. Two people on
// the same team reporting different faults share a category and a group, so
// those cannot be allowed to manufacture a match on their own -- the wording
// has to agree too. The same asset is the one strong contextual signal,
// because two reports against one machine usually are the same fault.
const WEIGHTS = {
  title: 0.55,
  same_requester: 0.12,
  same_category: 0.08,
  same_subcategory: 0.05,
  same_team: 0.05,
  same_asset: 0.2,
};

const OPEN_STATES = ['open', 'in_progress', 'on_hold', 'pending_approval'];

/**
 * Active tickets that look like the one described.
 *
 * Suggestion only, never automatic: merging two real faults because their
 * wording agreed is far more damaging than showing an agent two candidates
 * and letting them decide. Nothing here changes a ticket.
 */
export function findDuplicates(workspaceId, candidate, { withinDays = 14, limit = 5, threshold = 0.4 } = {}) {
  const since = new Date(Date.now() - withinDays * 86400000).toISOString();
  const rows = db.prepare(
    `SELECT t.id, t.number, t.title, t.status, t.priority, t.category, t.subcategory, t.team,
            t.requester_id, t.created_at, u.name AS requester_name
     FROM tickets t
     LEFT JOIN users u ON u.id = t.requester_id
     WHERE t.workspace_id = ?
       AND t.type = ?
       AND t.status IN (${OPEN_STATES.map(() => '?').join(',')})
       AND COALESCE(t.is_spam, 0) = 0
       AND t.deleted_at IS NULL
       AND t.created_at >= ?
       AND t.id != ?
     ORDER BY t.created_at DESC
     LIMIT 300`
  ).all(workspaceId, candidate.type || 'incident', ...OPEN_STATES, since, candidate.id || '');

  // Assets are looked up once rather than per row.
  const candidateAssets = candidate.id
    ? new Set(db.prepare('SELECT asset_id FROM ticket_assets WHERE ticket_id = ?').all(candidate.id).map((r) => r.asset_id))
    : new Set(candidate.asset_ids || []);

  const scored = [];
  for (const row of rows) {
    const similarity = titleSimilarity(candidate.title, row.title);
    // Wording is the necessary condition. Everything else only sharpens a
    // match that the words already suggested.
    if (similarity < 0.15) continue;

    const reasons = [];
    let score = similarity * WEIGHTS.title;
    reasons.push({ signal: 'title', detail: `${Math.round(similarity * 100)}% wording overlap` });

    if (candidate.requester_id && candidate.requester_id === row.requester_id) {
      score += WEIGHTS.same_requester;
      reasons.push({ signal: 'requester', detail: 'Same person reported both' });
    }
    if (candidate.category && candidate.category === row.category) {
      score += WEIGHTS.same_category;
      reasons.push({ signal: 'category', detail: `Both in ${row.category}` });
    }
    if (candidate.subcategory && candidate.subcategory === row.subcategory) score += WEIGHTS.same_subcategory;
    if (candidate.team && candidate.team === row.team) score += WEIGHTS.same_team;

    if (candidateAssets.size) {
      const theirs = db.prepare('SELECT asset_id FROM ticket_assets WHERE ticket_id = ?').all(row.id).map((r) => r.asset_id);
      if (theirs.some((a) => candidateAssets.has(a))) {
        score += WEIGHTS.same_asset;
        reasons.push({ signal: 'asset', detail: 'Same configuration item' });
      }
    }

    const final = Math.min(1, score);
    if (final >= threshold) scored.push({ ...row, score: Number(final.toFixed(3)), reasons });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Suggestions are stored so they survive a page refresh, can be dismissed
// once rather than reappearing, and leave a record that the agent was shown
// them -- recomputing on every open would let the advice change under them.
export function recordCandidates(workspaceId, ticketId, candidates) {
  if (!candidates.length) return [];
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO ticket_duplicate_candidates (id, workspace_id, ticket_id, candidate_id, score, reasons)
     VALUES (?,?,?,?,?,?)`
  );
  for (const c of candidates) {
    stmt.run(uid('dup'), workspaceId, ticketId, c.id, c.score, JSON.stringify(c.reasons));
  }
  return listCandidates(workspaceId, ticketId);
}

export function listCandidates(workspaceId, ticketId, { includeDismissed = false } = {}) {
  return db.prepare(
    `SELECT d.*, t.number, t.title, t.status, t.priority, u.name AS requester_name
     FROM ticket_duplicate_candidates d
     JOIN tickets t ON t.id = d.candidate_id
     LEFT JOIN users u ON u.id = t.requester_id
     WHERE d.workspace_id = ? AND d.ticket_id = ?${includeDismissed ? '' : " AND d.status = 'open'"}
     ORDER BY d.score DESC`
  ).all(workspaceId, ticketId).map((r) => ({ ...r, reasons: r.reasons ? JSON.parse(r.reasons) : [] }));
}

export function decideCandidate(workspaceId, id, user, status) {
  if (!['dismissed', 'confirmed'].includes(status)) {
    const e = new Error('A duplicate suggestion can only be dismissed or confirmed.');
    e.status = 400;
    throw e;
  }
  const row = db.prepare('SELECT * FROM ticket_duplicate_candidates WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) {
    const e = new Error('That suggestion no longer exists.');
    e.status = 404;
    throw e;
  }
  db.prepare("UPDATE ticket_duplicate_candidates SET status = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ?")
    .run(status, user.id, id);
  return { ...row, status };
}
