// Shared option lists for the workflow graph editor and the automations
// list page — single source of truth so both stay in sync.
import { Flag, RefreshCcw, Users, UserCheck, Tag, MessageSquare, Send, Bot, Sparkles, ShieldAlert, Globe2, ListChecks } from 'lucide-react';

export const EVENTS = [
  { value: 'ticket_created', label: 'Ticket created' },
  { value: 'ticket_updated', label: 'Ticket updated' },
  { value: 'task_created', label: 'Task created' },
  { value: 'task_completed', label: 'Task completed' },
];

// task_* fields only carry a real value when the trigger above is itself
// task_created/task_completed (see routes/tickets.js's task routes, which
// merge them onto the ticket context before evaluateAutomations runs) --
// wiring one into a condition on a ticket_created/ticket_updated workflow is
// harmless, it just never matches. tasks_total/open/completed/
// all_tasks_completed, by contrast, are aggregate fields computed fresh for
// EVERY trigger (services/automationEngine.js's evaluateAutomations), so
// they're meaningful regardless of which event fired.
export const FIELDS = [
  'priority', 'status', 'type', 'category', 'team', 'title', 'description',
  'tasks_total', 'tasks_open', 'tasks_completed', 'all_tasks_completed',
  'task_title', 'task_status', 'task_priority',
];
export const FIELD_LABELS = {
  team: 'group',
  tasks_total: 'Tasks — total', tasks_open: 'Tasks — open', tasks_completed: 'Tasks — completed',
  all_tasks_completed: 'All tasks completed?', task_title: 'Task title (this event)',
  task_status: 'Task status (this event)', task_priority: 'Task priority (this event)',
};
export const OPS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'in', label: 'is one of (comma list)' },
];

// Fields with a known, valid set of values get a dropdown instead of free text
// — this is what makes conditions like `type = request` reliable to author.
export const FIELD_ENUMS = {
  priority: ['low', 'medium', 'high', 'critical'],
  status: ['open', 'in_progress', 'on_hold', 'resolved', 'closed'],
  type: ['incident', 'request', 'problem', 'change'],
  all_tasks_completed: ['true', 'false'],
  task_status: ['open', 'in_progress', 'done'],
  task_priority: ['low', 'medium', 'high'],
};

export const ACTION_TYPES = [
  { value: 'set_priority', label: 'Set priority' },
  { value: 'set_status', label: 'Set status' },
  { value: 'assign_team', label: 'Assign to group' },
  { value: 'assign_agent', label: 'Assign to agent' },
  { value: 'tag_category', label: 'Set category' },
  { value: 'add_comment', label: 'Add comment' },
  { value: 'create_task', label: 'Create a task' },
  { value: 'notify_integration', label: 'Notify integration (Slack/Teams/Webhook)' },
  { value: 'api_call', label: 'Call an external API' },
  { value: 'ai_categorize', label: 'AI: auto-categorize ticket' },
  { value: 'ai_suggest_resolution', label: 'AI: post suggested resolution' },
  { value: 'auto_approve', label: 'Auto-approve pending approval' },
];

export function actionLabel(type) {
  return ACTION_TYPES.find((t) => t.value === type)?.label || type;
}

// Short one-line summary shown on an action node's card. `agentName` is
// resolved by the caller (WorkflowBuilder has the agents list; the node
// component itself shouldn't need to know about it) since assign_agent
// only stores an id.
export function summarizeAction(action, agentName) {
  switch (action?.type) {
    case 'set_priority': return action.priority ? `→ ${action.priority}` : 'no priority set';
    case 'set_status': return action.status ? `→ ${action.status.replace('_', ' ')}` : 'no status set';
    case 'assign_team': return action.team ? `→ ${action.team}` : 'no group set';
    case 'assign_agent': return agentName ? `→ ${agentName}` : (action.agent_id ? 'assigned' : 'no agent set');
    case 'tag_category': return action.category ? `→ ${action.category}` : 'no category set';
    case 'add_comment': return action.body ? `"${action.body.slice(0, 40)}${action.body.length > 40 ? '…' : ''}"` : 'empty comment';
    case 'create_task': return action.title ? `"${action.title.slice(0, 34)}${action.title.length > 34 ? '…' : ''}"${agentName ? ` → ${agentName}` : ''}` : 'no title set';
    case 'notify_integration': return action.message ? `"${action.message.slice(0, 40)}"` : 'notify';
    case 'api_call': return action.url ? `${(action.method || 'GET').toUpperCase()} ${action.url.slice(0, 34)}${action.url.length > 34 ? '…' : ''}` : 'no URL set';
    case 'ai_categorize': return 'via AI';
    case 'ai_suggest_resolution': return 'via AI';
    case 'auto_approve': return 'skips approval';
    default: return '';
  }
}

export const APPROVER_ROLES = [
  { value: 'admin', label: 'Any admin' },
  { value: 'agent', label: 'Any agent' },
];

export function summarizeApproval(data) {
  const who = data?.approver_type === 'user' ? (data.approverName || 'a specific person') : (APPROVER_ROLES.find((r) => r.value === (data?.approver_role || 'admin'))?.label || data?.approver_role);
  return `${data?.title ? `"${data.title}"` : 'Untitled'} → ${who}`;
}

export function summarizeCondition(data) {
  const rules = data?.rules || [];
  if (rules.length === 0) return 'no rules yet';
  const joiner = data.match === 'any' ? ' OR ' : ' AND ';
  return rules.map((r) => `${FIELD_LABELS[r.field] || r.field} ${r.op.replace('_', ' ')} "${r.value}"`).join(joiner);
}

export const ACTION_ICONS = {
  set_priority: Flag,
  set_status: RefreshCcw,
  assign_team: Users,
  assign_agent: UserCheck,
  tag_category: Tag,
  add_comment: MessageSquare,
  create_task: ListChecks,
  notify_integration: Send,
  api_call: Globe2,
  ai_categorize: Bot,
  ai_suggest_resolution: Sparkles,
  auto_approve: ShieldAlert,
};

export const TIER_STYLE = {
  A: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  B: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  C: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
};

// A workflow is always in exactly one of three states — no separate
// "enabled" + "test" toggles that could contradict each other:
//  off  -> not evaluated at all
//  test -> evaluated against real tickets, but only logs what it would do
//  live -> evaluated and actually executes
export const MODES = [
  { key: 'off', label: 'Off', on: 'bg-slate-400 text-white' },
  { key: 'test', label: 'Test', on: 'bg-amber-500 text-white' },
  { key: 'live', label: 'Live', on: 'bg-emerald-500 text-white' },
];

export function modeOf(wf) {
  if (!wf.enabled) return 'off';
  return wf.test_mode ? 'test' : 'live';
}
