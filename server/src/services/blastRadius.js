import { db } from '../db.js';

// A relationship row (asset_id, related_asset_id) means "asset_id depends on
// / is hosted on / is connected to related_asset_id" -- so if related_asset_id
// goes down, asset_id is affected. To find everything affected by an asset
// going down, we walk the graph in reverse: find rows where related_asset_id
// is the asset in question, then recurse on what THOSE depend on it too
// (a multi-hop cascading failure), up to a depth limit to bound cost and
// guard against relationship cycles.
const MAX_DEPTH = 4;

function downstreamOf(assetId, workspaceId, visited, depth, edges) {
  if (depth > MAX_DEPTH) return;
  const rows = db.prepare(
    `SELECT ar.asset_id, ar.relationship_type, a.name, a.tag, a.type
     FROM asset_relationships ar
     JOIN assets a ON a.id = ar.asset_id
     WHERE ar.related_asset_id = ? AND a.workspace_id = ?`
  ).all(assetId, workspaceId);
  for (const row of rows) {
    if (visited.has(row.asset_id)) continue;
    visited.add(row.asset_id);
    edges.push({ id: row.asset_id, name: row.name, tag: row.tag, type: row.type, relationship: row.relationship_type, depth });
    downstreamOf(row.asset_id, workspaceId, visited, depth + 1, edges);
  }
}

// Staged, not linear -- matches how blast radius actually reads to a human
// ("a handful of things" vs "basically everything").
function scoreFromCount(n) {
  if (n === 0) return 0;
  if (n <= 2) return 20;
  if (n <= 5) return 40;
  if (n <= 10) return 60;
  if (n <= 20) return 80;
  return 100;
}

// assetIds: the ticket's directly linked assets. Returns null if there are
// none (nothing to compute), otherwise the union of everything downstream of
// any of them, deduplicated, plus a 0-100 staged score.
export function computeBlastRadius(assetIds, workspaceId) {
  if (!assetIds || assetIds.length === 0) return null;
  const visited = new Set(assetIds);
  const edges = [];
  for (const id of assetIds) {
    downstreamOf(id, workspaceId, visited, 1, edges);
  }
  const affectedCount = edges.length;
  return {
    score: scoreFromCount(affectedCount),
    affectedCount,
    affected: edges.sort((a, b) => a.depth - b.depth).slice(0, 25),
  };
}
