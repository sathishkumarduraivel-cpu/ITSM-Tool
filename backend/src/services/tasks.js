// Ticket Tasks: the checklist/sub-item work engine behind a ticket's "Tasks"
// panel (TicketDetail.jsx) AND the Workflow Automation `create_task` action
// (services/automationEngine.js) -- both funnel through createTask/updateTask
// here rather than writing ticket_tasks directly, so notification/email/
// history behavior can't drift between "an agent added a task" and "a
// workflow added a task" the same way approvalEngine.js centralizes what
// happens when an approval queue clears for both the manual decide route and
// the auto_approve automation action.
import { db, uid } from '../db.js';
import { notifyUser } from './notifications.js';
import { sendTemplatedEmail, absoluteUrl } from './emailService.js';

// Exposed as flat, boolean-as-string condition fields (matching this app's
// existing convention -- e.g. SLA's business_hours_only-style checks --
// rather than a real boolean type, since every condition engine in this app
// compares values as strings) so Business Rules and Workflow Automation can
// both react to "has every task on this ticket been completed" without
// either engine needing to know how tasks are stored.
export function computeTaskAggregates(ticketId) {
  const rows = db.prepare('SELECT status FROM ticket_tasks WHERE ticket_id = ?').all(ticketId);
  const total = rows.length;
  const completed = rows.filter((r) => r.status === 'done').length;
  const open = total - completed;
  return {
    tasks_total: total,
    tasks_open: open,
    tasks_completed: completed,
    // Vacuously true for a ticket with no tasks at all -- "require every
    // task done before resolving" shouldn't block a ticket that never had
    // any tasks to begin with.
    all_tasks_completed: open === 0 ? 'true' : 'false',
  };
}

export function listTasks(ticketId) {
  const rows = db.prepare(
    `SELECT t.*, u.name AS assignee_name, u.email AS assignee_email, d.title AS depends_on_title, d.status AS depends_on_status
     FROM ticket_tasks t
     LEFT JOIN users u ON u.id = t.assignee_id
     LEFT JOIN ticket_tasks d ON d.id = t.depends_on_task_id
     WHERE t.ticket_id = ? ORDER BY t.sort_order ASC, t.created_at ASC`
  ).all(ticketId);
  const today = new Date().toISOString().slice(0, 10);
  return rows.map((r) => ({
    ...r,
    blocked: !!r.depends_on_task_id && r.depends_on_status !== 'done',
    overdue: !!r.due_date && r.status !== 'done' && r.due_date < today,
  }));
}

function notifyAssignee(task, ticket) {
  if (!task.assignee_id) return;
  const agent = db.prepare('SELECT name, email FROM users WHERE id = ?').get(task.assignee_id);
  if (!agent) return;
  notifyUser(task.assignee_id, 'Task assigned to you', `${ticket.number} — ${task.title}`, `/tickets/${ticket.id}`, ticket.workspace_id);
  if (agent.email) {
    sendTemplatedEmail(ticket.workspace_id, 'task_assigned', agent.email, {
      'agent.name': agent.name, 'ticket.number': ticket.number, 'ticket.title': ticket.title,
      'task.title': task.title, 'ticket.link': absoluteUrl(`/tickets/${ticket.id}`),
    }).catch((e) => console.error('task assigned email error', e));
  }
}

// Walks the dependency chain a proposed `depends_on_task_id` would create,
// starting from itself -- if that walk ever reaches back to `taskId`, wiring
// it up would form a cycle (task A can never become unblocked because it's
// waiting on a chain that loops back through itself).
function wouldCycle(taskId, proposedDependsOn) {
  let current = proposedDependsOn;
  const seen = new Set();
  while (current) {
    if (current === taskId) return true;
    if (seen.has(current)) return true; // pre-existing bad data -- refuse rather than trust it
    seen.add(current);
    current = db.prepare('SELECT depends_on_task_id FROM ticket_tasks WHERE id = ?').get(current)?.depends_on_task_id;
  }
  return false;
}

export function createTask(ticket, { title, description, assignee_id, due_date, priority, depends_on_task_id, created_by }) {
  if (depends_on_task_id) {
    const dep = db.prepare('SELECT id FROM ticket_tasks WHERE id = ? AND ticket_id = ?').get(depends_on_task_id, ticket.id);
    if (!dep) throw new Error('The selected dependency does not belong to this ticket.');
  }
  const id = uid('tsk');
  const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM ticket_tasks WHERE ticket_id = ?').get(ticket.id).m;
  db.prepare(
    `INSERT INTO ticket_tasks (id, ticket_id, workspace_id, title, description, status, priority, assignee_id, due_date, sort_order, depends_on_task_id, created_by)
     VALUES (?,?,?,?,?,'open',?,?,?,?,?,?)`
  ).run(id, ticket.id, ticket.workspace_id, title, description || null, priority || 'medium', assignee_id || null, due_date || null, (maxOrder ?? -1) + 1, depends_on_task_id || null, created_by || null);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), ticket.id, 'task_created', `Task created: ${title}`);
  const task = db.prepare('SELECT * FROM ticket_tasks WHERE id = ?').get(id);
  notifyAssignee(task, ticket);
  return task;
}

const ALLOWED_TASK_FIELDS = ['title', 'description', 'status', 'assignee_id', 'due_date', 'priority', 'sort_order', 'depends_on_task_id'];

export function updateTask(ticket, taskId, patch, actorName) {
  const task = db.prepare('SELECT * FROM ticket_tasks WHERE id = ? AND ticket_id = ?').get(taskId, ticket.id);
  if (!task) return null;

  if (patch.status && patch.status !== task.status && ['in_progress', 'done'].includes(patch.status) && task.depends_on_task_id) {
    const dep = db.prepare('SELECT status FROM ticket_tasks WHERE id = ?').get(task.depends_on_task_id);
    if (dep && dep.status !== 'done') throw new Error('This task is blocked by an incomplete dependency.');
  }
  if (patch.depends_on_task_id) {
    if (patch.depends_on_task_id === taskId) throw new Error('A task cannot depend on itself.');
    const dep = db.prepare('SELECT id FROM ticket_tasks WHERE id = ? AND ticket_id = ?').get(patch.depends_on_task_id, ticket.id);
    if (!dep) throw new Error('The selected dependency does not belong to this ticket.');
    if (wouldCycle(taskId, patch.depends_on_task_id)) throw new Error('That dependency would create a cycle between tasks.');
  }

  const fields = []; const params = [];
  for (const key of ALLOWED_TASK_FIELDS) {
    if (patch[key] !== undefined) { fields.push(`${key} = ?`); params.push(patch[key]); }
  }
  if (!fields.length) return task;
  const completing = patch.status === 'done' && task.status !== 'done';
  if (completing) fields.push("completed_at = datetime('now')");
  else if (patch.status && patch.status !== 'done') fields.push('completed_at = NULL');
  fields.push("updated_at = datetime('now')");
  params.push(taskId);
  db.prepare(`UPDATE ticket_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare('SELECT * FROM ticket_tasks WHERE id = ?').get(taskId);
  if (completing) {
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
      uid('h'), ticket.id, 'task_completed', `Task completed: ${updated.title}${actorName ? ` by ${actorName}` : ''}`
    );
  }
  if (patch.assignee_id !== undefined && patch.assignee_id !== task.assignee_id) {
    notifyAssignee(updated, ticket);
  }
  return updated;
}

export function deleteTask(ticketId, taskId) {
  // Clear anything that pointed at this task as its dependency first --
  // otherwise a stray depends_on_task_id would reference a now-nonexistent
  // row, and every future status-change check on that task would silently
  // find no dependency row and treat it as unblocked instead of erroring.
  db.prepare('UPDATE ticket_tasks SET depends_on_task_id = NULL WHERE depends_on_task_id = ?').run(taskId);
  db.prepare('DELETE FROM ticket_tasks WHERE id = ? AND ticket_id = ?').run(taskId, ticketId);
}
