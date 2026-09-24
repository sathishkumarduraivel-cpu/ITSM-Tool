// The CMDB graph: impact downstream, dependencies upstream, and service maps.
//
// An edge row (asset_id -> related_asset_id) means "asset_id depends on
// related_asset_id". So:
//
//   downstream / impact       walk target -> source   (what breaks if this breaks)
//   upstream   / dependency   walk source -> target   (what this needs to work)
//
// The walk is breadth-first, one indexed query per hop with the whole
// frontier in an IN clause. That matters for two reasons. It is far fewer
// round trips than a query per node, and -- more importantly -- breadth-first
// assigns every node its true shortest distance. A depth-limited depth-first
// walk can wander down a long path, mark a node visited at depth 4, and then
// refuse to expand it even though a two-hop route to it existed; everything
// beyond is then silently missing from the impact set.
import { db } from '../db.js';
import { listClasses, resolveClass, descendantsOf } from './ciClasses.js';
import { listRelationshipTypes } from './ciRelationshipTypes.js';

export const DEFAULT_MAX_DEPTH = 4;

// SQLite's default host-parameter cap.
const PARAM_CHUNK = 400;

function typeIndex(workspaceId) {
  const byId = new Map();
  const byKey = new Map();
  for (const t of listRelationshipTypes(workspaceId, { includeDisabled: true })) {
    byId.set(t.id, t);
    byKey.set(t.key, t);
  }
  return { byId, byKey };
}

// An edge whose type row was deleted still has its old string, so it degrades
// to a readable label rather than disappearing from the graph.
function describeEdge(row, types) {
  const type = (row.type_id && types.byId.get(row.type_id)) || types.byKey.get(row.relationship_type) || null;
  return {
    rel_id: row.rel_id,
    type_key: type ? type.key : row.relationship_type,
    label: type ? type.label : row.relationship_type,
    inverse_label: type ? type.inverse_label : row.relationship_type,
    is_dependency: type ? !!type.is_dependency : true,
    is_containment: type ? !!type.is_containment : false,
    color: type ? type.color : null,
  };
}

// One hop. `direction` decides which column is matched and which is followed.
function hop(frontier, workspaceId, direction) {
  const matchCol = direction === 'downstream' ? 'r.related_asset_id' : 'r.asset_id';
  const followCol = direction === 'downstream' ? 'r.asset_id' : 'r.related_asset_id';
  const rows = [];
  const ids = [...frontier];
  for (let i = 0; i < ids.length; i += PARAM_CHUNK) {
    const slice = ids.slice(i, i + PARAM_CHUNK);
    rows.push(...db.prepare(
      `SELECT r.id rel_id, r.relationship_type, r.type_id, r.description,
              ${matchCol} AS from_id, ${followCol} AS to_id,
              a.id, a.name, a.tag, a.type, a.status, a.class_id, a.owner_id
       FROM asset_relationships r
       JOIN assets a ON a.id = ${followCol}
       WHERE ${matchCol} IN (${slice.map(() => '?').join(',')}) AND a.workspace_id = ?`
    ).all(...slice, workspaceId));
  }
  return rows;
}

/**
 * Breadth-first walk of the relationship graph.
 *
 * @param startIds      CIs to start from. They are never included in the result.
 * @param direction     'downstream' (impact) or 'upstream' (dependencies).
 * @param maxDepth      Hops to follow. Bounds cost and makes cycles harmless.
 * @param dependencyOnly Follow only edges whose type propagates failure.
 * @param typeKeys      Restrict to these relationship type keys.
 * @returns { nodes, edges } where every node carries the depth it was first
 *          reached at and the CI it was reached from.
 */
export function traverse(startIds, workspaceId, {
  direction = 'downstream', maxDepth = DEFAULT_MAX_DEPTH, dependencyOnly = false, typeKeys = null,
} = {}) {
  const start = [...new Set((startIds || []).filter(Boolean))];
  if (!start.length) return { nodes: [], edges: [] };

  const types = typeIndex(workspaceId);
  const allow = typeKeys ? new Set(typeKeys) : null;
  const visited = new Set(start);
  const nodes = [];
  const edges = [];

  let frontier = new Set(start);
  for (let depth = 1; depth <= maxDepth && frontier.size; depth += 1) {
    const next = new Set();
    for (const row of hop(frontier, workspaceId, direction)) {
      const edge = describeEdge(row, types);
      if (dependencyOnly && !edge.is_dependency) continue;
      if (allow && !allow.has(edge.type_key)) continue;

      // The edge is recorded even when it lands on an already-seen node --
      // that is what makes a cycle or a diamond visible in the explorer
      // instead of silently pruned.
      edges.push({ ...edge, from: row.from_id, to: row.to_id, depth, description: row.description || null });
      if (visited.has(row.to_id)) continue;

      visited.add(row.to_id);
      next.add(row.to_id);
      nodes.push({
        id: row.id, name: row.name, tag: row.tag, type: row.type, status: row.status,
        class_id: row.class_id, owner_id: row.owner_id,
        depth, via: row.from_id, relationship: edge.type_key, relationship_label: edge.label,
      });
    }
    frontier = next;
  }

  return { nodes, edges };
}

// Attaches each node's CI class, in one pass rather than per node.
function withClasses(workspaceId, nodes) {
  if (!nodes.length) return nodes;
  const byId = new Map(listClasses(workspaceId, { includeDisabled: true }).map((c) => [c.id, c]));
  return nodes.map((n) => {
    const cls = (n.class_id && byId.get(n.class_id)) || resolveClass(workspaceId, n);
    return { ...n, ci_class: cls ? { id: cls.id, key: cls.key, label: cls.label, icon: cls.icon, color: cls.color } : null };
  });
}

// What breaks if these CIs break.
export function impactOf(ciIds, workspaceId, opts = {}) {
  const { nodes, edges } = traverse(ciIds, workspaceId, { ...opts, direction: 'downstream' });
  return { nodes: withClasses(workspaceId, nodes), edges };
}

// What these CIs need in order to work.
export function dependenciesOf(ciIds, workspaceId, opts = {}) {
  const { nodes, edges } = traverse(ciIds, workspaceId, { ...opts, direction: 'upstream' });
  return { nodes: withClasses(workspaceId, nodes), edges };
}

// The question a change or a major incident actually turns on: which named
// business services does this reach? Infrastructure counts are a proxy;
// "Customer Payments and Online Banking" is the answer people act on.
export function servicesAffectedBy(ciIds, workspaceId, opts = {}) {
  const serviceClasses = new Set(
    listClasses(workspaceId, { includeDisabled: true })
      .filter((c) => c.key === 'business_service')
      .flatMap((c) => descendantsOf(workspaceId, c.id).map((d) => d.id))
  );
  if (!serviceClasses.size) return [];
  const { nodes } = impactOf(ciIds, workspaceId, opts);
  return nodes
    .filter((n) => n.class_id && serviceClasses.has(n.class_id))
    .sort((a, b) => a.depth - b.depth);
}

// Everything a service is built on, arranged by how far down the stack it
// sits. The layering is what turns a flat dependency list into something a
// person can read at a glance during an incident.
export function serviceMap(serviceId, workspaceId, { maxDepth = 6 } = {}) {
  const root = db.prepare('SELECT * FROM assets WHERE id = ? AND workspace_id = ?').get(serviceId, workspaceId);
  if (!root) return null;

  const { nodes, edges } = dependenciesOf([serviceId], workspaceId, { maxDepth });
  const rootClass = resolveClass(workspaceId, root);

  const layers = [];
  for (const node of nodes) {
    if (!layers[node.depth - 1]) layers[node.depth - 1] = { depth: node.depth, nodes: [] };
    layers[node.depth - 1].nodes.push(node);
  }

  // A count per class is what makes "this service rests on 3 databases and 11
  // servers" possible without the caller regrouping the list itself.
  const byClass = new Map();
  for (const node of nodes) {
    const key = node.ci_class?.key || 'unclassified';
    if (!byClass.has(key)) byClass.set(key, { key, label: node.ci_class?.label || 'Unclassified', count: 0 });
    byClass.get(key).count += 1;
  }

  return {
    root: { ...root, ci_class: rootClass ? { id: rootClass.id, key: rootClass.key, label: rootClass.label, icon: rootClass.icon, color: rootClass.color } : null },
    layers: layers.filter(Boolean),
    nodes,
    edges,
    summary: {
      total: nodes.length,
      by_class: [...byClass.values()].sort((a, b) => b.count - a.count),
      // A service that depends on nothing is either genuinely standalone or,
      // far more often, simply not mapped yet. Saying so is more useful than
      // rendering an empty diagram.
      mapped: nodes.length > 0,
    },
  };
}

// Both directions around one CI, for the explorer view.
export function neighbourhood(ciId, workspaceId, { maxDepth = 2 } = {}) {
  const ci = db.prepare('SELECT * FROM assets WHERE id = ? AND workspace_id = ?').get(ciId, workspaceId);
  if (!ci) return null;
  const down = impactOf([ciId], workspaceId, { maxDepth });
  const up = dependenciesOf([ciId], workspaceId, { maxDepth });
  const cls = resolveClass(workspaceId, ci);

  // A node can legitimately appear in both directions (a cycle, or a diamond).
  // Merge on id, keeping the shortest distance, and record which sides it was
  // seen from so the UI can colour it.
  const merged = new Map();
  const add = (list, side) => {
    for (const n of list) {
      const prior = merged.get(n.id);
      if (!prior) { merged.set(n.id, { ...n, sides: [side] }); continue; }
      if (n.depth < prior.depth) Object.assign(prior, n, { sides: prior.sides });
      if (!prior.sides.includes(side)) prior.sides.push(side);
    }
  };
  add(down.nodes, 'impact');
  add(up.nodes, 'dependency');

  return {
    root: { ...ci, ci_class: cls ? { id: cls.id, key: cls.key, label: cls.label, icon: cls.icon, color: cls.color } : null },
    nodes: [...merged.values()],
    edges: dedupeEdges([...down.edges, ...up.edges]),
  };
}

function dedupeEdges(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (seen.has(e.rel_id)) continue;
    seen.add(e.rel_id);
    out.push(e);
  }
  return out;
}
