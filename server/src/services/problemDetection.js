import { db, uid } from '../db.js';

/**
 * Finding the problems nobody has raised yet.
 *
 * The whole point of problem management is to stop incidents recurring, and
 * the hardest part in practice is noticing that they ARE recurring: each one
 * is handled, closed, and looks like a one-off to whoever took it. This looks
 * across the recent past for clusters that share a cause-shaped signal and
 * proposes them.
 *
 * It proposes, it never creates. A problem record raised automatically has no
 * owner and no analysis, and a queue of those is worse than none.
 */

// Deliberately conservative defaults. A detector that cries wolf gets ignored,
// and then real recurrence hides in the noise.
const DEFAULTS = { withinDays: 30, minIncidents: 4, minAssetIncidents: 3 };

const OPEN_OR_RECENT = "t.deleted_at IS NULL AND COALESCE(t.is_spam, 0) = 0 AND t.type = 'incident'";

// Incidents already explained by a problem are excluded from every count: once
// somebody is investigating, continuing to propose the same cluster is noise.
const NOT_ALREADY_EXPLAINED = `
  t.id NOT IN (SELECT incident_id FROM problem_incidents WHERE workspace_id = t.workspace_id)
`;

function clusters(workspaceId, since, opts) {
  const out = [];

  // 1. The same category and subcategory, over and over. The coarsest signal
  //    and the one most likely to be a genuine systemic fault.
  const byCategory = db.prepare(
    `SELECT COALESCE(t.category, 'Uncategorised') AS category,
            COALESCE(t.subcategory, '') AS subcategory,
            COUNT(*) AS n, MIN(t.created_at) AS first_seen, MAX(t.created_at) AS last_seen
     FROM tickets t
     WHERE t.workspace_id = ? AND ${OPEN_OR_RECENT} AND t.created_at >= ? AND ${NOT_ALREADY_EXPLAINED}
       AND t.category IS NOT NULL AND t.category != ''
     GROUP BY category, subcategory
     HAVING n >= ?`
  ).all(workspaceId, since, opts.minIncidents);
  for (const c of byCategory) {
    out.push({
      basis: c.subcategory ? 'subcategory' : 'category',
      signature: `cat:${c.category}|${c.subcategory}`,
      label: c.subcategory ? `${c.category} — ${c.subcategory}` : c.category,
      incident_count: c.n,
      first_seen: c.first_seen,
      last_seen: c.last_seen,
    });
  }

  // 2. The same configuration item. A weaker threshold is right here: three
  //    incidents against one machine is already a pattern, whereas three in a
  //    category the size of "Network" is a Tuesday.
  const byAsset = db.prepare(
    `SELECT a.id AS asset_id, a.name AS asset_name,
            COUNT(DISTINCT t.id) AS n, MIN(t.created_at) AS first_seen, MAX(t.created_at) AS last_seen
     FROM ticket_assets ta
     JOIN tickets t ON t.id = ta.ticket_id
     JOIN assets a ON a.id = ta.asset_id
     WHERE t.workspace_id = ? AND ${OPEN_OR_RECENT} AND t.created_at >= ? AND ${NOT_ALREADY_EXPLAINED}
     GROUP BY a.id
     HAVING n >= ?`
  ).all(workspaceId, since, opts.minAssetIncidents);
  for (const a of byAsset) {
    out.push({
      basis: 'asset',
      signature: `ci:${a.asset_id}`,
      label: a.asset_name,
      incident_count: a.n,
      first_seen: a.first_seen,
      last_seen: a.last_seen,
    });
  }

  return out;
}

// The incidents behind a cluster, so the suggestion can be judged rather than
// taken on trust.
function samplesFor(workspaceId, since, cluster, limit = 8) {
  if (cluster.basis === 'asset') {
    const assetId = cluster.signature.slice(3);
    return db.prepare(
      `SELECT DISTINCT t.id, t.number, t.title, t.created_at, t.status
       FROM ticket_assets ta JOIN tickets t ON t.id = ta.ticket_id
       WHERE ta.asset_id = ? AND t.workspace_id = ? AND ${OPEN_OR_RECENT} AND t.created_at >= ? AND ${NOT_ALREADY_EXPLAINED}
       ORDER BY t.created_at DESC LIMIT ?`
    ).all(assetId, workspaceId, since, limit);
  }
  const [category, subcategory] = cluster.signature.slice(4).split('|');
  return db.prepare(
    `SELECT t.id, t.number, t.title, t.created_at, t.status
     FROM tickets t
     WHERE t.workspace_id = ? AND ${OPEN_OR_RECENT} AND t.created_at >= ? AND ${NOT_ALREADY_EXPLAINED}
       AND COALESCE(t.category, 'Uncategorised') = ? AND COALESCE(t.subcategory, '') = ?
     ORDER BY t.created_at DESC LIMIT ?`
  ).all(workspaceId, since, category, subcategory, limit);
}

/**
 * Refresh the candidate list.
 *
 * Existing open candidates have their counts updated rather than being
 * replaced, so a cluster that keeps growing keeps its identity. A candidate
 * somebody dismissed stays dismissed unless the cluster has grown
 * substantially since — being told twice about the same thing is why people
 * stop reading these, but a fault that has doubled deserves asking again.
 */
export function refreshCandidates(workspaceId, options = {}) {
  // Undefined entries are dropped rather than spread over the defaults. A
  // caller passing `{ minIncidents: Number(req.body.min) || undefined }` --
  // which is the natural way to write an optional query parameter -- would
  // otherwise replace the default with undefined, and the threshold reached
  // SQLite as NULL, where `HAVING n >= NULL` is never true. The detector then
  // silently found nothing at all, which looks exactly like "no recurrence".
  const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined && !Number.isNaN(v)));
  const opts = { ...DEFAULTS, ...given };
  const since = new Date(Date.now() - opts.withinDays * 86400000).toISOString();
  const found = clusters(workspaceId, since, opts);

  for (const c of found) {
    const samples = samplesFor(workspaceId, since, c);
    const existing = db.prepare('SELECT * FROM problem_candidates WHERE workspace_id = ? AND signature = ?').get(workspaceId, c.signature);
    if (!existing) {
      db.prepare(
        `INSERT INTO problem_candidates (id, workspace_id, signature, basis, label, incident_count, first_seen, last_seen, sample_incident_ids)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(uid('pcd'), workspaceId, c.signature, c.basis, c.label, c.incident_count, c.first_seen, c.last_seen, JSON.stringify(samples.map((s) => s.id)));
      continue;
    }
    if (existing.status === 'promoted') continue;
    const grewSubstantially = c.incident_count >= existing.incident_count * 2;
    db.prepare(
      `UPDATE problem_candidates SET incident_count = ?, last_seen = ?, label = ?, sample_incident_ids = ?
       ${existing.status === 'dismissed' && grewSubstantially ? ", status = 'open', decided_by = NULL, decided_at = NULL" : ''}
       WHERE id = ?`
    ).run(c.incident_count, c.last_seen, c.label, JSON.stringify(samples.map((s) => s.id)), existing.id);
  }

  // A cluster that has fallen back below the threshold stops being proposed.
  const live = new Set(found.map((c) => c.signature));
  const stale = db.prepare("SELECT id, signature FROM problem_candidates WHERE workspace_id = ? AND status = 'open'").all(workspaceId);
  for (const s of stale) {
    if (!live.has(s.signature)) db.prepare('DELETE FROM problem_candidates WHERE id = ?').run(s.id);
  }

  return listCandidates(workspaceId);
}

export function listCandidates(workspaceId, { status = 'open' } = {}) {
  const rows = status === 'all'
    ? db.prepare('SELECT * FROM problem_candidates WHERE workspace_id = ? ORDER BY incident_count DESC').all(workspaceId)
    : db.prepare('SELECT * FROM problem_candidates WHERE workspace_id = ? AND status = ? ORDER BY incident_count DESC').all(workspaceId, status);
  return rows.map((r) => {
    const ids = r.sample_incident_ids ? JSON.parse(r.sample_incident_ids) : [];
    const incidents = ids.length
      ? db.prepare(`SELECT id, number, title, created_at, status FROM tickets WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : [];
    return { ...r, sample_incident_ids: ids, incidents };
  });
}

export function dismissCandidate(workspaceId, id, user) {
  const row = db.prepare('SELECT * FROM problem_candidates WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) { const e = new Error('That suggestion no longer exists.'); e.status = 404; throw e; }
  db.prepare("UPDATE problem_candidates SET status = 'dismissed', decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(user.id, id);
  return listCandidates(workspaceId);
}

export function markPromoted(workspaceId, id, user, problemId) {
  db.prepare("UPDATE problem_candidates SET status = 'promoted', problem_id = ?, decided_by = ?, decided_at = datetime('now') WHERE id = ? AND workspace_id = ?")
    .run(problemId, user.id, id, workspaceId);
}

// ---- trend analysis (§9.2, §18.4) ---------------------------------------

export function problemTrends(workspaceId, { days = 90 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const byRootCause = db.prepare(
    `SELECT COALESCE(root_cause_category, 'not_recorded') AS category, COUNT(*) AS n
     FROM tickets WHERE workspace_id = ? AND type = 'problem' AND deleted_at IS NULL AND created_at >= ?
     GROUP BY category ORDER BY n DESC`
  ).all(workspaceId, since);

  const byState = db.prepare(
    `SELECT COALESCE(problem_state, 'identified') AS state, COUNT(*) AS n
     FROM tickets WHERE workspace_id = ? AND type = 'problem' AND deleted_at IS NULL
     GROUP BY state`
  ).all(workspaceId);

  // The measure that says whether the practice is working: how many incidents
  // each problem accounts for. A problem explaining thirty incidents earned
  // its investigation many times over.
  const topProblems = db.prepare(
    `SELECT t.id, t.number, t.title, t.problem_state, t.is_known_error,
            COUNT(pi.id) AS incident_count
     FROM tickets t
     LEFT JOIN problem_incidents pi ON pi.problem_id = t.id
     WHERE t.workspace_id = ? AND t.type = 'problem' AND t.deleted_at IS NULL
     GROUP BY t.id HAVING incident_count > 0
     ORDER BY incident_count DESC LIMIT 10`
  ).all(workspaceId);

  const overdueActions = db.prepare(
    `SELECT a.id, a.title, a.due_date, a.status, u.name AS owner_name, t.number AS problem_number, t.id AS problem_id
     FROM problem_actions a
     JOIN tickets t ON t.id = a.problem_id
     LEFT JOIN users u ON u.id = a.owner_id
     WHERE a.workspace_id = ? AND a.status IN ('open','in_progress') AND a.due_date IS NOT NULL AND a.due_date < date('now')
     ORDER BY a.due_date ASC LIMIT 20`
  ).all(workspaceId);

  const counts = db.prepare(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN problem_state NOT IN ('resolved','closed') OR problem_state IS NULL THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN is_known_error = 1 THEN 1 ELSE 0 END) AS known_errors,
       SUM(CASE WHEN root_cause_detail IS NOT NULL AND TRIM(root_cause_detail) != '' THEN 1 ELSE 0 END) AS with_root_cause
     FROM tickets WHERE workspace_id = ? AND type = 'problem' AND deleted_at IS NULL`
  ).get(workspaceId);

  // How many incidents are being explained at all. Low coverage means
  // incidents are being closed one by one with nobody asking why.
  const coverage = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tickets WHERE workspace_id = ? AND type = 'incident' AND deleted_at IS NULL AND created_at >= ?) AS incidents,
       (SELECT COUNT(DISTINCT incident_id) FROM problem_incidents WHERE workspace_id = ?) AS explained`
  ).get(workspaceId, since, workspaceId);

  return {
    days,
    counts: {
      ...counts,
      open: counts.open || 0,
      known_errors: counts.known_errors || 0,
      with_root_cause: counts.with_root_cause || 0,
    },
    coverage: {
      ...coverage,
      percent: coverage.incidents > 0 ? Math.round((coverage.explained / coverage.incidents) * 100) : null,
    },
    by_root_cause: byRootCause,
    by_state: byState,
    top_problems: topProblems,
    overdue_actions: overdueActions,
  };
}
