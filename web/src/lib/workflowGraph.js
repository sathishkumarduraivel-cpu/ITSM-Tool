import dagre from '@dagrejs/dagre';

let counter = 0;
function nodeId(prefix) {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

// Converts a Sona AI draft (or any legacy {trigger, conditions, actions}
// shape) into an equivalent straight-line graph: trigger -> optional single
// AND condition -> action chain. autoLayout() is expected to be run on the
// result before it's shown, since positions here are just a vertical stack.
export function legacyToGraph(trigger, conditions, actions) {
  const nodes = [];
  const edges = [];
  const triggerId = nodeId('trigger');
  nodes.push({ id: triggerId, type: 'trigger', position: { x: 0, y: 0 }, data: { event: trigger?.event || 'ticket_created' } });

  let prevId = triggerId;
  let prevHandle;
  let y = 140;

  if (conditions && conditions.length) {
    const condId = nodeId('cond');
    nodes.push({ id: condId, type: 'condition', position: { x: 0, y }, data: { match: 'all', rules: conditions } });
    edges.push({ id: nodeId('e'), source: prevId, target: condId, ...(prevHandle ? { sourceHandle: prevHandle } : {}) });
    prevId = condId;
    prevHandle = 'yes';
    y += 140;
  }

  for (const action of actions || []) {
    const actId = nodeId('act');
    nodes.push({ id: actId, type: 'action', position: { x: 0, y }, data: { ...action } });
    edges.push({ id: nodeId('e'), source: prevId, target: actId, ...(prevHandle ? { sourceHandle: prevHandle } : {}) });
    prevId = actId;
    prevHandle = undefined;
    y += 140;
  }

  return { nodes, edges };
}

export function newTriggerScaffold() {
  return { nodes: [{ id: nodeId('trigger'), type: 'trigger', position: { x: 0, y: 0 }, data: { event: 'ticket_created' } }], edges: [] };
}

export function newNode(type, position, data) {
  return { id: nodeId(type), type, position, data };
}

const NODE_SIZE = { trigger: { w: 220, h: 76 }, condition: { w: 240, h: 92 }, action: { w: 240, h: 88 }, approval: { w: 240, h: 104 } };

// Auto-arranges nodes top-to-bottom by graph distance from the trigger,
// using dagre for x/y assignment. Returns new node objects (same ids/data,
// new positions) — caller is responsible for calling setNodes with the result.
export function autoLayout(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: 'TB', nodesep: 80, ranksep: 100 });

  for (const n of nodes) {
    const size = NODE_SIZE[n.type] || NODE_SIZE.action;
    g.setNode(n.id, { width: size.w, height: size.h });
  }
  for (const e of edges) {
    if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    const size = NODE_SIZE[n.type] || NODE_SIZE.action;
    if (!pos) return n;
    return { ...n, position: { x: pos.x - size.w / 2, y: pos.y - size.h / 2 } };
  });
}

const REQUIRED_ACTION_FIELDS = {
  set_priority: ['priority'],
  set_status: ['status'],
  assign_team: ['team'],
  assign_agent: ['agent_id'],
  tag_category: ['category'],
  add_comment: ['body'],
  create_task: ['title'],
  api_call: ['url'],
};

// Validates a graph before it can be saved. `errors` block saving (shown as
// a summary + inline node badges); `warnings` don't (surfaced but ignorable
// — e.g. a branch nobody wired up yet while still sketching a workflow).
export function validateGraph(nodes, edges) {
  const errors = [];
  const warnings = [];

  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) errors.push({ nodeId: null, message: 'Add a trigger node to start the workflow.' });
  if (triggers.length > 1) {
    for (const t of triggers.slice(1)) errors.push({ nodeId: t.id, message: 'Only one trigger node is allowed per workflow.' });
  }

  const incomingCount = new Map();
  for (const e of edges) incomingCount.set(e.target, (incomingCount.get(e.target) || 0) + 1);
  for (const t of triggers) {
    if (incomingCount.get(t.id)) errors.push({ nodeId: t.id, message: 'A trigger node cannot have an incoming connection.' });
  }

  const adjacency = new Map();
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source).push(e.target);
  }

  // Cycle detection (DFS, 3-color).
  const color = new Map(nodes.map((n) => [n.id, 0]));
  let hasCycle = false;
  const visit = (id) => {
    color.set(id, 1);
    for (const next of adjacency.get(id) || []) {
      if (color.get(next) === 1) hasCycle = true;
      else if (color.get(next) === 0) visit(next);
    }
    color.set(id, 2);
  };
  for (const n of nodes) if (color.get(n.id) === 0) visit(n.id);
  if (hasCycle) errors.push({ nodeId: null, message: 'The graph has a loop — a workflow must be a one-way flow from the trigger.' });

  // Reachability from the trigger — unreachable nodes are just a warning
  // (common mid-edit state, not necessarily wrong).
  const reachable = new Set();
  if (triggers[0]) {
    const queue = [triggers[0].id];
    while (queue.length) {
      const id = queue.shift();
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const next of adjacency.get(id) || []) queue.push(next);
    }
  }
  for (const n of nodes) {
    if (n.type !== 'trigger' && !reachable.has(n.id)) {
      warnings.push({ nodeId: n.id, message: 'Not connected to the trigger — this node will never run.' });
    }
  }

  for (const n of nodes) {
    if (n.type === 'condition') {
      const rules = n.data?.rules || [];
      if (rules.length === 0) errors.push({ nodeId: n.id, message: 'Add at least one condition rule.' });
      for (const r of rules) {
        if (!r.field || !r.op || r.value === undefined || r.value === '') {
          errors.push({ nodeId: n.id, message: 'Every condition rule needs a field, operator, and value.' });
          break;
        }
      }
      const wiredHandles = new Set((adjacency.get(n.id) ? edges.filter((e) => e.source === n.id) : []).map((e) => e.sourceHandle || 'yes'));
      if (wiredHandles.size === 0) warnings.push({ nodeId: n.id, message: 'Neither branch is connected to anything yet.' });
    }
    if (n.type === 'action') {
      const required = REQUIRED_ACTION_FIELDS[n.data?.type] || [];
      for (const field of required) {
        if (!n.data?.[field]) {
          errors.push({ nodeId: n.id, message: 'Fill in this action’s required fields.' });
          break;
        }
      }
    }
    if (n.type === 'approval') {
      if (!n.data?.title?.trim()) errors.push({ nodeId: n.id, message: 'Give this approval step a title.' });
      if (n.data?.approver_type === 'user' ? !n.data?.approver_id : !n.data?.approver_role) {
        errors.push({ nodeId: n.id, message: 'Choose who this approval goes to.' });
      }
      const wiredHandles = new Set(edges.filter((e) => e.source === n.id).map((e) => e.sourceHandle || 'approved'));
      if (wiredHandles.size === 0) warnings.push({ nodeId: n.id, message: 'Neither branch is connected to anything yet.' });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
