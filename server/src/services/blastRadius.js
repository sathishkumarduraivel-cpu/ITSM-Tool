import { impactOf, DEFAULT_MAX_DEPTH } from './cmdbGraph.js';

// Blast radius is change risk's view of the CMDB graph: given the CIs a
// change touches, how much of the estate sits downstream of them.
//
// The traversal itself now lives in cmdbGraph.js so that impact analysis,
// service maps and this scoring all read the same graph the same way. The
// shape returned here is unchanged, because changeRisk.js consumes it.
//
// One deliberate behavioural change came with that move. The old walk was
// depth-first with a depth cut-off, which could mark a CI visited at depth 4
// by way of a long path and then refuse to expand it, even when a two-hop
// route existed -- everything past that point was missing from the count.
// The breadth-first walk reaches every CI at its true shortest distance, so
// the affected set is a superset of what the old one produced and a score can
// only move up, never down. Under-stating blast radius was the bug; a change
// that touches more than it looked like it did is the thing worth catching.
//
// Every relationship type is followed, not just the ones flagged as
// dependencies. For scoring, "connected to the thing being changed" is
// information worth having even when failure would not strictly propagate
// along that edge.

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
// none (nothing to compute), otherwise everything downstream of any of them,
// deduplicated, plus a 0-100 staged score.
export function computeBlastRadius(assetIds, workspaceId) {
  if (!assetIds || assetIds.length === 0) return null;

  const { nodes } = impactOf(assetIds, workspaceId, { maxDepth: DEFAULT_MAX_DEPTH });
  const affectedCount = nodes.length;

  return {
    score: scoreFromCount(affectedCount),
    affectedCount,
    // Callers render this list, so it stays capped; affectedCount above is
    // the number to reason about.
    affected: nodes
      .map((n) => ({ id: n.id, name: n.name, tag: n.tag, type: n.type, relationship: n.relationship, depth: n.depth }))
      .sort((a, b) => a.depth - b.depth)
      .slice(0, 25),
  };
}
