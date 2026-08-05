import { db, uid } from './../db.js';
import { getProvider, categorizeTicket, suggestResolution } from './aiClient.js';
import { sendIntegrationMessage, getEnabledIntegrations } from './notify.js';
import { autoApprovePending } from './approvalEngine.js';

// Workflow shape stored in DB:
// trigger:    { event: 'ticket_created'|'ticket_updated'|'sla_at_risk', filters?: {...} }
// conditions: [{ field, op, value }]   op in: equals, not_equals, contains, in
// actions:    [{ type, ...params }]
//   types: set_priority, set_status, assign_team, assign_agent, add_comment,
//          notify_integration, ai_categorize, ai_suggest_resolution, tag_category, auto_approve

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

async function runAction(action, ticket) {
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
    try {
      const results = [];
      for (const action of actions) {
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
