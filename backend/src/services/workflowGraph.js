// Pure conversions between the legacy flat automation shape
// (trigger/conditions/actions) and the branching node/edge graph shape.
// No DB access here on purpose -- db.js's one-time backfill and
// automationEngine.js/routes/automations.js all import from this module,
// and db.js must stay import-cycle-free from the engine.

let counter = 0;
function nodeId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

// Converts an old-shape automation row into an equivalent straight-line
// graph: trigger -> (optional single AND condition node) -> action chain.
// Used to backfill rows saved before the graph editor existed.
export function legacyToGraph(trigger, conditions, actions) {
  const nodes = [];
  const edges = [];
  const triggerNodeId = nodeId('trigger');
  nodes.push({ id: triggerNodeId, type: 'trigger', position: { x: 250, y: 0 }, data: { event: trigger?.event || 'ticket_created' } });

  let prevId = triggerNodeId;
  let prevHandle;
  let y = 140;

  if (conditions && conditions.length) {
    const condId = nodeId('cond');
    nodes.push({ id: condId, type: 'condition', position: { x: 250, y }, data: { match: 'all', rules: conditions } });
    edges.push({ id: nodeId('e'), source: prevId, target: condId, ...(prevHandle ? { sourceHandle: prevHandle } : {}) });
    prevId = condId;
    prevHandle = 'yes';
    y += 140;
  }

  for (const action of actions || []) {
    const actId = nodeId('act');
    nodes.push({ id: actId, type: 'action', position: { x: 250, y }, data: { ...action } });
    edges.push({ id: nodeId('e'), source: prevId, target: actId, ...(prevHandle ? { sourceHandle: prevHandle } : {}) });
    prevId = actId;
    prevHandle = undefined;
    y += 140;
  }

  return { nodes, edges };
}

// Derives a best-effort flattened legacy view from a graph, purely so the
// legacy trigger/conditions/actions columns (actions is NOT NULL) stay
// populated. NOT reliable for a branching workflow -- never read this back
// as ground truth for execution; walk nodes/edges instead.
export function deriveLegacyFromGraph(nodes, edges) {
  const triggerNode = nodes.find((n) => n.type === 'trigger');
  const trigger = { event: triggerNode?.data?.event || 'ticket_created' };
  const firstCondition = nodes.find((n) => n.type === 'condition');
  const conditions = firstCondition ? firstCondition.data.rules || [] : [];

  const adjacency = new Map();
  for (const e of edges || []) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source).push(e);
  }
  const visited = new Set();
  const queue = triggerNode ? [triggerNode.id] : [];
  const actions = [];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = nodes.find((n) => n.id === id);
    if (node?.type === 'action') actions.push(node.data);
    for (const e of adjacency.get(id) || []) queue.push(e.target);
  }

  return { trigger, conditions, actions };
}
