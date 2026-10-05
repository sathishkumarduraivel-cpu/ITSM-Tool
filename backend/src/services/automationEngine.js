import { db, uid } from './../db.js';
import { getProvider, categorizeTicket, suggestResolution } from './aiClient.js';
import { sendIntegrationMessage, getEnabledIntegrations } from './notify.js';
import { autoApprovePending } from './approvalEngine.js';
import { notifyRole, notifyUser } from './notifications.js';
import { getLifecycle } from './lifecycleEngine.js';
import { decrypt } from './crypto.js';
import { createTask, computeTaskAggregates } from './tasks.js';

// Workflow shape stored in DB (nodes/edges are the source of truth; the
// legacy trigger/conditions/actions columns are a derived, write-only
// mirror kept only because `actions` is NOT NULL -- see
// deriveLegacyFromGraph in workflowGraph.js):
//
// nodes: [{ id, type: 'trigger'|'condition'|'action'|'approval', position, data }]
//   trigger.data:   { event: 'ticket_created'|'ticket_updated' }
//   condition.data: { match: 'all'|'any', rules: [{ field, op, value }] }
//   action.data:    { type, ...params }  -- same action types as before:
//     set_priority, set_status, assign_team, assign_agent, add_comment,
//     notify_integration, ai_categorize, ai_suggest_resolution,
//     tag_category, auto_approve, api_call
//   approval.data:  { approver_type: 'role'|'user', approver_role?, approver_id?,
//                     title, message? } -- a first-class pause point, not an
//     action type, because it needs two named outgoing branches (see below)
//     the way a condition node does, not the single output every action has.
// edges: [{ id, source, target, sourceHandle? }]
//   condition nodes use sourceHandle 'yes'/'no'; approval nodes use
//   'approved'/'rejected'; trigger/action nodes have a single unlabeled
//   output (fan-out/fan-in is just multiple edges sharing a source/target --
//   no extra schema needed).

// ---- Safety Guardrail Matrix ----
// Two axes decide a tier: how sensitive the data/system touched is, and how
// reversible the action is. In this app's current action set almost
// everything is internal ticket metadata and trivially reversible (Tier A).
// The one real outlier is auto_approve: it bypasses a human governance gate
// (the approval/CAB chain) rather than just editing a field, so even though
// its direct effect is "semi-reversible" (the underlying ticket can still be
// re-reviewed), the act of skipping human sign-off is exactly the kind of
// thing this matrix exists to catch. Tier C actions never execute
// unattended -- they land in automation_pending_actions for a human decision,
// and everything downstream of them in the graph waits too (there's no
// scheduler to auto-resume a branch later; approving the action resumes it
// instead -- see decidePendingAction).
export const ACTION_RISK_TIERS = {
  set_priority: { tier: 'A', reason: 'Reversible, internal ticket metadata only.' },
  set_status: { tier: 'A', reason: 'Reversible, internal ticket metadata only.' },
  assign_team: { tier: 'A', reason: 'Reversible routing decision, internal only.' },
  assign_agent: { tier: 'A', reason: 'Reversible routing decision, internal only.' },
  tag_category: { tier: 'A', reason: 'Reversible, internal ticket metadata only.' },
  add_comment: { tier: 'A', reason: 'Reversible (editable), internal by default.' },
  ai_categorize: { tier: 'A', reason: 'Reversible, internal ticket metadata only.' },
  ai_suggest_resolution: { tier: 'A', reason: 'Posts a comment for a human to read and act on.' },
  create_task: { tier: 'A', reason: 'Reversible, internal work item — can be edited or deleted like any other task.' },
  notify_integration: { tier: 'B', reason: "Can't be unsent, but low-consequence if wrong (a chat ping)." },
  api_call: { tier: 'B', reason: "Calls an external system — can't be unsent, and its effect there is outside this app's control." },
  auto_approve: { tier: 'C', reason: 'Bypasses a human governance gate (the approval/CAB chain) -- requires a human decision every time.' },
};
function tierOf(actionType) {
  return ACTION_RISK_TIERS[actionType]?.tier || 'A';
}

function getField(ticket, field) {
  return ticket[field];
}

// Lets an API Call action's URL/headers/body reference the triggering
// ticket, e.g. `https://example.com/tickets/{{ticket.number}}` — the only
// templating this app needs (no nested paths, no other data source), kept
// intentionally simple rather than pulling in a template engine dependency.
function interpolate(str, ticket) {
  return String(str || '').replace(/\{\{\s*ticket\.(\w+)\s*\}\}/g, (_, key) => (
    ticket[key] !== undefined && ticket[key] !== null ? String(ticket[key]) : ''
  ));
}

function matchCondition(ticket, cond) {
  const val = getField(ticket, cond.field);
  switch (cond.op) {
    case 'equals':
      return String(val) === String(cond.value);
    case 'not_equals':
      return String(val) !== String(cond.value);
    case 'contains':
      return String(val || '').toLowerCase().includes(String(cond.value).toLowerCase());
    case 'in':
      return String(cond.value)
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .includes(String(val || '').toLowerCase());
    default:
      return true;
  }
}

function logRun(automationId, ticketId, status, detail) {
  db.prepare(
    'INSERT INTO automation_logs (id, automation_id, ticket_id, status, detail) VALUES (?,?,?,?,?)'
  ).run(uid('log'), automationId, ticketId || null, status, detail || '');
}

// Describes what an action WOULD do, without doing it — no DB writes, no AI
// calls, no outbound notifications. Mirrors runAction's return messages so a
// test-mode log reads the same as a real one, just prefixed "would".
export function describeAction(action) {
  switch (action.type) {
    case 'set_priority':
      return `would set priority -> ${action.priority}`;
    case 'set_status':
      return `would set status -> ${action.status}`;
    case 'assign_team':
      return `would set group -> ${action.team}`;
    case 'assign_agent':
      return `would assign to agent ${action.agent_id}`;
    case 'tag_category':
      return `would set category -> ${action.category}`;
    case 'add_comment':
      return 'would add a comment';
    case 'create_task':
      return `would create a task: "${action.title || '(untitled)'}"${action.assignee_id ? ' and assign it' : ''}`;
    case 'notify_integration':
      return `would notify integration${action.integration_id ? '' : '(s)'}: "${action.message || 'Automation triggered'}"`;
    case 'api_call':
      return `would call ${(action.method || 'GET').toUpperCase()} ${action.url || '(no URL set)'}`;
    case 'ai_categorize':
      return 'would ask AI to auto-categorize this ticket';
    case 'ai_suggest_resolution':
      return 'would ask AI to post a suggested resolution';
    case 'auto_approve':
      return 'would auto-approve any pending approvals on this ticket';
    default:
      return `would run unknown action type: ${action.type}`;
  }
}

export async function runAction(action, ticket) {
  const t = () => db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
  switch (action.type) {
    case 'set_priority':
      db.prepare("UPDATE tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(action.priority, ticket.id);
      return `priority -> ${action.priority}`;
    case 'set_status':
      // Hard enforcement: a lifecycle-governed type can only move status
      // through validated stage transitions, not a direct write -- same
      // rule the PATCH /tickets/:id route enforces for humans.
      if (getLifecycle(ticket.workspace_id, ticket.type)) {
        return `blocked: "${ticket.type}" is governed by a configured lifecycle — set_status is disabled for it`;
      }
      db.prepare("UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?").run(action.status, ticket.id);
      return `status -> ${action.status}`;
    case 'assign_team':
      db.prepare("UPDATE tickets SET team = ?, updated_at = datetime('now') WHERE id = ?").run(action.team, ticket.id);
      return `team -> ${action.team}`;
    case 'assign_agent':
      db.prepare("UPDATE tickets SET assignee_id = ?, updated_at = datetime('now') WHERE id = ?").run(action.agent_id, ticket.id);
      return `assignee -> ${action.agent_id}`;
    case 'tag_category':
      db.prepare("UPDATE tickets SET category = ?, subcategory = ?, updated_at = datetime('now') WHERE id = ?").run(
        action.category, action.subcategory || null, ticket.id
      );
      return `category -> ${action.category}`;
    case 'add_comment':
      db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_name, body, is_private, is_ai) VALUES (?,?,?,?,?,1)').run(
        uid('cmt'), ticket.id, 'Automation', action.body, action.is_private ? 1 : 0
      );
      return 'comment added';
    case 'create_task': {
      const due_date = action.due_in_days !== undefined && action.due_in_days !== ''
        ? new Date(Date.now() + Number(action.due_in_days) * 86400000).toISOString().slice(0, 10)
        : null;
      const task = createTask(ticket, {
        title: interpolate(action.title, ticket) || 'Untitled task',
        description: interpolate(action.description, ticket),
        assignee_id: action.assignee_id || null,
        priority: action.priority || 'medium',
        due_date,
      });
      return `task created: "${task.title}"`;
    }
    case 'notify_integration': {
      const integrations = action.integration_id
        ? [db.prepare('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?').get(action.integration_id, ticket.workspace_id)].filter(Boolean)
        : getEnabledIntegrations(ticket.workspace_id, action.integration_type);
      for (const integ of integrations) {
        await sendIntegrationMessage(integ, {
          text: `[${ticket.number}] ${ticket.title} — ${action.message || 'Automation triggered'}`,
        });
      }
      return `notified ${integrations.length} integration(s)`;
    }
    case 'api_call': {
      const method = (action.method || 'GET').toUpperCase();
      const url = interpolate(action.url, ticket);
      if (!url) return 'skipped: no URL configured';
      const headers = { accept: 'application/json' };
      for (const h of action.headers || []) {
        if (h.key) headers[h.key] = interpolate(h.value, ticket);
      }
      // Credentials never live in the node's own config (that JSON blob is
      // stored in plaintext in the automations.nodes column) -- they're
      // pulled from an `http_api` integration, encrypted at rest exactly
      // like every other integration's secrets.
      if (action.integration_id) {
        const integ = db.prepare('SELECT * FROM integrations WHERE id = ? AND workspace_id = ? AND type = ?')
          .get(action.integration_id, ticket.workspace_id, 'http_api');
        if (integ) {
          const auth = JSON.parse(decrypt(integ.config) || '{}');
          if (auth.auth_type === 'bearer' && auth.token) headers.Authorization = `Bearer ${auth.token}`;
          else if (auth.auth_type === 'basic' && auth.username) headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password || ''}`).toString('base64')}`;
          else if (auth.auth_type === 'api_key' && auth.header_name && auth.token) headers[auth.header_name] = auth.token;
        }
      }
      const body = action.body ? interpolate(action.body, ticket) : undefined;
      if (body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
      try {
        const resp = await fetch(url, { method, headers, body });
        const text = await resp.text();
        const preview = text.slice(0, 500);
        if (action.save_response_as_comment) {
          db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_name, body, is_private, is_ai) VALUES (?,?,?,?,1,1)').run(
            uid('cmt'), ticket.id, 'Automation', `API call ${method} ${url} → ${resp.status}\n\n${preview}`
          );
        }
        if (!resp.ok && !action.continue_on_error) throw new Error(`responded ${resp.status}: ${preview.slice(0, 200)}`);
        return `API call ${method} ${url} → ${resp.status}`;
      } catch (e) {
        if (action.continue_on_error) return `API call failed (continuing): ${e.message}`;
        throw new Error(`API call to ${url} failed: ${e.message}`);
      }
    }
    case 'ai_categorize': {
      const provider = getProvider(ticket.workspace_id, action.provider_id);
      const current = t();
      const result = await categorizeTicket(provider, current);
      db.prepare(
        "UPDATE tickets SET category = ?, subcategory = ?, priority = COALESCE(?, priority), ai_sentiment = ?, ai_suggested_category = ?, updated_at = datetime('now') WHERE id = ?"
      ).run(result.category, result.subcategory || null, result.priority || null, result.sentiment || null, result.category, ticket.id);
      return `AI categorized -> ${result.category}`;
    }
    case 'ai_suggest_resolution': {
      const provider = getProvider(ticket.workspace_id, action.provider_id);
      const current = t();
      const comments = db.prepare('SELECT * FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at').all(ticket.id);
      const suggestion = await suggestResolution(provider, current, comments);
      db.prepare('INSERT INTO ticket_comments (id, ticket_id, author_name, body, is_private, is_ai) VALUES (?,?,?,?,1,1)').run(
        uid('cmt'), ticket.id, 'AI Assistant', `Suggested resolution:\n${suggestion}`
      );
      return 'AI resolution suggestion posted';
    }
    case 'auto_approve': {
      const count = autoApprovePending(ticket.id, ticket.workspace_id);
      return count ? `auto-approved ${count} pending approval(s)` : 'no pending approvals to auto-approve';
    }
    default:
      return `unknown action type: ${action.type}`;
  }
}

function buildAdjacency(edges) {
  const adjacency = new Map();
  for (const e of edges || []) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source).push(e);
  }
  return adjacency;
}

// Walks the workflow graph breadth-first from either the trigger node (a
// normal run) or a given node id (resuming a branch after a gated action was
// approved — see decidePendingAction). Each node executes at most once per
// walk even with diamond-shaped fan-in, via the `visited` set.
//
// mode: 'live' actually executes actions and queues Tier C ones for human
// approval, stopping that branch there. 'dry'/'preview' never touch the DB
// or send anything — they describe what each action would do and keep
// walking straight through a Tier C node (tracked in gatedNodeIds) so a
// preview shows the complete illustrative path instead of truncating like a
// live run does.
export async function traverseWorkflow({ ticket, nodes, edges, mode, automationId, automationName, resumeFrom, resumeHandle }) {
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = buildAdjacency(edges);

  const visitedNodeIds = new Set();
  const visitedEdgeIds = new Set();
  const actionResults = [];
  const gatedNodeIds = [];

  let startId = resumeFrom;
  if (!startId) {
    const triggerNode = nodes.find((n) => n.type === 'trigger');
    if (!triggerNode) return { visitedNodeIds: [], visitedEdgeIds: [], actionResults, gatedNodeIds };
    startId = triggerNode.id;
  }
  visitedNodeIds.add(startId);

  const queue = [];
  for (const e of adjacency.get(startId) || []) {
    // Resuming an approval node's branch: only walk the edge matching the
    // human's decision (approved vs rejected), not both — a plain Tier C
    // action gate has no resumeHandle and fans out to every outgoing edge
    // exactly as before.
    if (resumeHandle && e.sourceHandle !== resumeHandle) continue;
    visitedEdgeIds.add(e.id);
    queue.push(e.target);
  }

  while (queue.length) {
    const nodeId = queue.shift();
    if (visitedNodeIds.has(nodeId)) continue;
    visitedNodeIds.add(nodeId);
    const node = nodeById.get(nodeId);
    if (!node) continue;

    if (node.type === 'condition') {
      const rules = node.data.rules || [];
      const matched = node.data.match === 'any' ? rules.some((r) => matchCondition(ticket, r)) : rules.every((r) => matchCondition(ticket, r));
      const wantHandle = matched ? 'yes' : 'no';
      for (const e of adjacency.get(nodeId) || []) {
        if ((e.sourceHandle || 'yes') !== wantHandle) continue;
        visitedEdgeIds.add(e.id);
        queue.push(e.target);
      }
      continue;
    }

    if (node.type === 'approval') {
      const approverLabel = node.data.approver_type === 'user' ? 'a specific person' : `the ${node.data.approver_role || 'admin'} team`;
      const title = node.data.title || 'Approval required';

      if (mode === 'live') {
        const pendingId = uid('pend');
        db.prepare(
          "INSERT INTO automation_pending_actions (id, workspace_id, automation_id, ticket_id, action, tier, node_id, kind) VALUES (?,?,?,?,?,?,?,'approval')"
        ).run(pendingId, ticket.workspace_id, automationId, ticket.id, JSON.stringify(node.data), 'C', nodeId);
        const notifyBody = `"${automationName}" needs approval on ${ticket.number}: ${title}${node.data.message ? ` — ${node.data.message}` : ''}`;
        if (node.data.approver_type === 'user' && node.data.approver_id) {
          notifyUser(node.data.approver_id, 'Approval required', notifyBody, `/tickets/${ticket.id}`, ticket.workspace_id);
        } else {
          notifyRole(node.data.approver_role || 'admin', 'Approval required', notifyBody, `/tickets/${ticket.id}`, ticket.workspace_id);
        }
        logRun(automationId, ticket.id, 'awaiting_approval', `Approval requested (${approverLabel}) — ${title}`);
        gatedNodeIds.push(nodeId);
        continue; // both branches pause here until a human decides — see decidePendingAction
      }

      // preview/dry mode: illustrate the "approved" path so a test-run shows
      // the complete intended flow instead of truncating at the gate.
      actionResults.push(`would request approval (${approverLabel}): ${title}`);
      gatedNodeIds.push(nodeId);
      for (const e of adjacency.get(nodeId) || []) {
        if ((e.sourceHandle || 'approved') !== 'approved') continue;
        visitedEdgeIds.add(e.id);
        queue.push(e.target);
      }
      continue;
    }

    if (node.type === 'action') {
      const tier = tierOf(node.data.type);
      if (mode === 'live' && tier === 'C') {
        const pendingId = uid('pend');
        db.prepare(
          'INSERT INTO automation_pending_actions (id, workspace_id, automation_id, ticket_id, action, tier, node_id) VALUES (?,?,?,?,?,?,?)'
        ).run(pendingId, ticket.workspace_id, automationId, ticket.id, JSON.stringify(node.data), tier, nodeId);
        notifyRole('admin', 'Automation needs your approval', `"${automationName}" wants to: ${describeAction(node.data).replace('would ', '')} on ${ticket.number}`, `/tickets/${ticket.id}`, ticket.workspace_id);
        logRun(automationId, ticket.id, 'awaiting_approval', `Tier ${tier} — ${describeAction(node.data)}`);
        gatedNodeIds.push(nodeId);
        continue; // branch pauses here — nothing downstream runs until a human decides
      }

      if (mode === 'live') {
        // eslint-disable-next-line no-await-in-loop
        actionResults.push(await runAction(node.data, ticket));
      } else {
        actionResults.push(describeAction(node.data));
        if (tier === 'C') gatedNodeIds.push(nodeId);
      }

      for (const e of adjacency.get(nodeId) || []) {
        visitedEdgeIds.add(e.id);
        queue.push(e.target);
      }
      continue;
    }
  }

  return { visitedNodeIds: [...visitedNodeIds], visitedEdgeIds: [...visitedEdgeIds], actionResults, gatedNodeIds };
}

export async function evaluateAutomations(event, ticket) {
  // Merged onto every evaluation's context (not just task_created/
  // task_completed triggers) so a ticket_updated automation can, say, notify
  // a manager if a ticket gets resolved while all_tasks_completed is still
  // "false" -- condition/action fields work the same as any real ticket
  // column since matchCondition/getField just read flat properties off this
  // object without knowing where they came from. A task-triggered event
  // (see routes/tickets.js's task routes) additionally carries task_* keys
  // for the specific task that fired it, merged in by the caller before this
  // runs -- those aren't clobbered here since the key names never collide.
  const ticketCtx = { ...ticket, ...computeTaskAggregates(ticket.id) };
  const rows = db.prepare('SELECT * FROM automations WHERE enabled = 1 AND workspace_id = ?').all(ticketCtx.workspace_id);
  for (const row of rows) {
    let nodes, edges;
    try {
      nodes = JSON.parse(row.nodes || '[]');
      edges = JSON.parse(row.edges || '[]');
    } catch {
      continue;
    }
    const triggerNode = nodes.find((n) => n.type === 'trigger');
    if (!triggerNode || triggerNode.data.event !== event) continue;

    try {
      const { actionResults, gatedNodeIds } = await traverseWorkflow({
        ticket: ticketCtx, nodes, edges, mode: row.test_mode ? 'dry' : 'live', automationId: row.id, automationName: row.name,
      });

      if (row.test_mode) {
        if (actionResults.length || gatedNodeIds.length) {
          logRun(row.id, ticket.id, 'test_match', actionResults.join('; '));
        }
        continue;
      }

      if (actionResults.length === 0) continue; // nothing beyond any gates (already logged) actually ran
      db.prepare("UPDATE automations SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?").run(row.id);
      logRun(row.id, ticket.id, 'success', actionResults.join('; '));
    } catch (e) {
      logRun(row.id, ticket.id, 'error', e.message);
    }
  }
}

// ---- Human decisions on gated nodes: Tier C action gates and Approval nodes ----
//
// Both flavors pause a branch and land a row here (see traverseWorkflow), but
// they resolve differently: a Tier C gate's whole point is that *approving*
// is the only outcome that resumes anything — reject just means the gated
// action itself never ran, dead-ending the branch exactly like before this
// feature existed. An Approval node, by contrast, is a genuine fork — reject
// is a normal, expected outcome with its own wired-up downstream (e.g.
// "notify requester their change was declined"), so it always resumes, just
// down the 'rejected' branch instead of 'approved'.

export async function decidePendingAction(pendingId, workspaceId, approve, decidedByUserId, note) {
  const pending = db.prepare('SELECT * FROM automation_pending_actions WHERE id = ? AND workspace_id = ?').get(pendingId, workspaceId);
  if (!pending) return null;
  if (pending.status !== 'pending') return pending;

  const isApproval = pending.kind === 'approval';
  const noteSuffix = note ? ` — "${note}"` : '';

  if (!approve && !isApproval) {
    // Legacy Tier C action gate, rejected: dead end, nothing resumes.
    db.prepare("UPDATE automation_pending_actions SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), note = ? WHERE id = ?").run(decidedByUserId, note || null, pendingId);
    logRun(pending.automation_id, pending.ticket_id, 'rejected', `Human rejected the pending action.${noteSuffix}`);
    return { ...pending, status: 'rejected' };
  }

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(pending.ticket_id);
  let result = '';
  if (!isApproval) {
    // Tier C action gate, approved: run the action that was held back.
    const action = JSON.parse(pending.action);
    try {
      result = ticket ? await runAction(action, ticket) : 'ticket no longer exists';
    } catch (e) {
      logRun(pending.automation_id, pending.ticket_id, 'error', `Approved but failed to run: ${e.message}`);
      throw e;
    }
  }

  const newStatus = approve ? 'approved' : 'rejected';
  db.prepare("UPDATE automation_pending_actions SET status = ?, decided_by = ?, decided_at = datetime('now'), note = ? WHERE id = ?").run(newStatus, decidedByUserId, note || null, pendingId);
  logRun(
    pending.automation_id, pending.ticket_id, isApproval ? newStatus : 'success',
    isApproval ? `Approval ${newStatus} by human${noteSuffix}` : `Approved by human — ${result}${noteSuffix}`
  );

  // Resume the branch downstream of the gate, if we know which node it was
  // and the ticket still exists — otherwise anything wired after the gate
  // would silently never run. An approval node resumes down whichever
  // branch matches the decision; a Tier C action gate has only one output
  // and always resumes it (reject already returned above without reaching here).
  if (ticket && pending.node_id) {
    const automation = db.prepare('SELECT * FROM automations WHERE id = ?').get(pending.automation_id);
    if (automation) {
      try {
        const nodes = JSON.parse(automation.nodes || '[]');
        const edges = JSON.parse(automation.edges || '[]');
        const resumed = await traverseWorkflow({
          ticket, nodes, edges, mode: 'live', automationId: automation.id, automationName: automation.name,
          resumeFrom: pending.node_id, resumeHandle: isApproval ? newStatus : undefined,
        });
        if (resumed.actionResults.length) {
          logRun(automation.id, ticket.id, 'success', `Resumed after decision — ${resumed.actionResults.join('; ')}`);
        }
      } catch (e) {
        logRun(automation.id, ticket.id, 'error', `Resumed after decision but failed: ${e.message}`);
      }
    }
  }

  return { ...pending, status: newStatus };
}
