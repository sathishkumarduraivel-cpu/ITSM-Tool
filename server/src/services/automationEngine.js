import { db, uid } from './../db.js';
import { getProvider, categorizeTicket, suggestResolution } from './aiClient.js';
import { sendIntegrationMessage, getEnabledIntegrations } from './notify.js';
import { autoApprovePending } from './approvalEngine.js';
import { notifyRole } from './notifications.js';

// Workflow shape stored in DB:
// trigger:    { event: 'ticket_created'|'ticket_updated'|'sla_at_risk', filters?: {...} }
// conditions: [{ field, op, value }]   op in: equals, not_equals, contains, in
// actions:    [{ type, ...params }]
//   types: set_priority, set_status, assign_team, assign_agent, add_comment,
//          notify_integration, ai_categorize, ai_suggest_resolution, tag_category, auto_approve

// ---- Safety Guardrail Matrix ----
// Two axes decide a tier: how sensitive the data/system touched is, and how
// reversible the action is. In this app's current action set almost
// everything is internal ticket metadata and trivially reversible (Tier A).
// The one real outlier is auto_approve: it bypasses a human governance gate
// (the approval/CAB chain) rather than just editing a field, so even though
// its direct effect is "semi-reversible" (the underlying ticket can still be
// re-reviewed), the act of skipping human sign-off is exactly the kind of
// thing this matrix exists to catch. Tier C actions never execute
// unattended -- they land in automation_pending_actions for a human decision.
export const ACTION_RISK_TIERS = {
  set_priority: { tier: 'A', reason: 'Reversible, internal ticket metadata only.' },
  set_status: { tier: 'A', reason: 'Reversible, internal ticket metadata only.' },
  assign_team: { tier: 'A', reason: 'Reversible routing decision, internal only.' },
  assign_agent: { tier: 'A', reason: 'Reversible routing decision, internal only.' },
  tag_category: { tier: 'A', reason: 'Reversible, internal ticket metadata only.' },
  add_comment: { tier: 'A', reason: 'Reversible (editable), internal by default.' },
  ai_categorize: { tier: 'A', reason: 'Reversible, internal ticket metadata only.' },
  ai_suggest_resolution: { tier: 'A', reason: 'Posts a comment for a human to read and act on.' },
  notify_integration: { tier: 'B', reason: "Can't be unsent, but low-consequence if wrong (a chat ping)." },
  auto_approve: { tier: 'C', reason: 'Bypasses a human governance gate (the approval/CAB chain) -- requires a human decision every time.' },
};
function tierOf(actionType) {
  return ACTION_RISK_TIERS[actionType]?.tier || 'A';
}

function getField(ticket, field) {
  return ticket[field];
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
    case 'notify_integration':
      return `would notify integration${action.integration_id ? '' : '(s)'}: "${action.message || 'Automation triggered'}"`;
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

// Exported so routes (e.g. the "test against last 30 days" endpoint) can
// check a ticket against a workflow's conditions using the exact same logic
// evaluateAutomations uses live, without duplicating it.
export function ticketMatchesConditions(ticket, conditions) {
  return conditions.every((c) => matchCondition(ticket, c));
}

export async function evaluateAutomations(event, ticket) {
  const rows = db.prepare('SELECT * FROM automations WHERE enabled = 1 AND workspace_id = ?').all(ticket.workspace_id);
  for (const row of rows) {
    let trigger, conditions, actions;
    try {
      trigger = JSON.parse(row.trigger);
      conditions = JSON.parse(row.conditions || '[]');
      actions = JSON.parse(row.actions);
    } catch {
      continue;
    }
    if (trigger.event !== event) continue;
    const allMatch = conditions.every((c) => matchCondition(ticket, c));
    if (!allMatch) {
      continue;
    }

    if (row.test_mode) {
      const results = actions.map(describeAction);
      logRun(row.id, ticket.id, 'test_match', results.join('; '));
      continue;
    }

    // Safety Guardrail Matrix: split by tier before running anything. Tier
    // C actions never execute here -- they queue for a human decision.
    const autoActions = actions.filter((a) => tierOf(a.type) !== 'C');
    const gatedActions = actions.filter((a) => tierOf(a.type) === 'C');

    for (const action of gatedActions) {
      const id = uid('pend');
      db.prepare(
        'INSERT INTO automation_pending_actions (id, workspace_id, automation_id, ticket_id, action, tier) VALUES (?,?,?,?,?,?)'
      ).run(id, ticket.workspace_id, row.id, ticket.id, JSON.stringify(action), tierOf(action.type));
      notifyRole('admin', 'Automation needs your approval', `"${row.name}" wants to: ${describeAction(action).replace('would ', '')} on ${ticket.number}`, `/tickets/${ticket.id}`, ticket.workspace_id);
      logRun(row.id, ticket.id, 'awaiting_approval', `Tier ${tierOf(action.type)} — ${describeAction(action)}`);
    }

    if (autoActions.length === 0) continue;

    try {
      const results = [];
      for (const action of autoActions) {
        // eslint-disable-next-line no-await-in-loop
        results.push(await runAction(action, ticket));
      }
      db.prepare("UPDATE automations SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?").run(row.id);
      logRun(row.id, ticket.id, 'success', results.join('; '));
    } catch (e) {
      logRun(row.id, ticket.id, 'error', e.message);
    }
  }
}

// ---- Human decisions on gated (Tier C) actions ----

export async function decidePendingAction(pendingId, workspaceId, approve, decidedByUserId) {
  const pending = db.prepare('SELECT * FROM automation_pending_actions WHERE id = ? AND workspace_id = ?').get(pendingId, workspaceId);
  if (!pending) return null;
  if (pending.status !== 'pending') return pending;

  if (!approve) {
    db.prepare("UPDATE automation_pending_actions SET status = 'rejected', decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(decidedByUserId, pendingId);
    logRun(pending.automation_id, pending.ticket_id, 'rejected', 'Human rejected the pending action.');
    return { ...pending, status: 'rejected' };
  }

  const action = JSON.parse(pending.action);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(pending.ticket_id);
  try {
    const result = ticket ? await runAction(action, ticket) : 'ticket no longer exists';
    db.prepare("UPDATE automation_pending_actions SET status = 'approved', decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(decidedByUserId, pendingId);
    logRun(pending.automation_id, pending.ticket_id, 'success', `Approved by human — ${result}`);
    return { ...pending, status: 'approved' };
  } catch (e) {
    logRun(pending.automation_id, pending.ticket_id, 'error', `Approved but failed to run: ${e.message}`);
    throw e;
  }
}
