import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole } from '../middleware/auth.js';
import { getProvider, draftHrCaseTasks } from '../services/aiClient.js';
import { notifyUser } from '../services/notifications.js';
import {
  ONBOARDING_STAGES, OFFBOARDING_STAGES, stagesFor,
  recomputeCaseStage, isTaskBlocked, materializeTasks,
} from '../services/hrCaseEngine.js';

const router = Router();

function withTasks(kase) {
  const tasks = db.prepare('SELECT * FROM hr_case_tasks WHERE case_id = ? ORDER BY sort_order ASC, created_at ASC').all(kase.id);
  const tasksById = Object.fromEntries(tasks.map((t) => [t.id, t]));
  const enriched = tasks.map((t) => ({
    ...t,
    blocked: isTaskBlocked(t, tasksById),
    overdue: !!t.due_at && t.status !== 'done' && t.status !== 'skipped' && new Date(t.due_at) < new Date(),
  }));
  return { case: kase, tasks: enriched, stages: stagesFor(kase.case_type) };
}

// ---- Case list & creation ----

// Elevated-risk offboarding cases sort first -- the closest thing this
// module has to a "needs attention" view without a dedicated dashboard.
router.get('/', requireAuth, requireWorkspace, requireRole('admin', 'agent'), (req, res) => {
  const { case_type, status } = req.query;
  let sql = 'SELECT * FROM hr_cases WHERE workspace_id = ?';
  const params = [req.workspaceId];
  if (case_type) { sql += ' AND case_type = ?'; params.push(case_type); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += " ORDER BY (risk_level = 'elevated') DESC, created_at DESC";
  const cases = db.prepare(sql).all(...params);
  const counts = db.prepare(
    `SELECT case_id, COUNT(*) total, SUM(CASE WHEN status IN ('done','skipped') THEN 1 ELSE 0 END) done
     FROM hr_case_tasks WHERE case_id IN (${cases.map(() => '?').join(',') || "''"}) GROUP BY case_id`
  ).all(...cases.map((c) => c.id));
  const countsById = Object.fromEntries(counts.map((c) => [c.case_id, c]));
  res.json({ cases: cases.map((c) => ({ ...c, taskCount: countsById[c.id]?.total || 0, taskDone: countsById[c.id]?.done || 0 })) });
});

router.get('/stages', requireAuth, requireWorkspace, (req, res) => {
  res.json({ onboarding: ONBOARDING_STAGES, offboarding: OFFBOARDING_STAGES });
});

// ---- Templates (admin config, like Automations) ----

router.get('/templates', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const rows = db.prepare('SELECT * FROM hr_case_templates WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);
  res.json({ templates: rows.map((r) => ({ ...r, tasks: JSON.parse(r.tasks || '[]') })) });
});

router.post('/templates', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const { name, case_type, role_match, description, tasks } = req.body;
  if (!name || !case_type) return res.status(400).json({ error: 'name and case_type required' });
  const id = uid('hrt');
  db.prepare(
    'INSERT INTO hr_case_templates (id, workspace_id, name, case_type, role_match, description, tasks) VALUES (?,?,?,?,?,?,?)'
  ).run(id, req.workspaceId, name, case_type, role_match || null, description || '', JSON.stringify(tasks || []));
  res.status(201).json({ id });
});

router.patch('/templates/:id', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM hr_case_templates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const { name, role_match, description, tasks, enabled } = req.body;
  const fields = []; const params = [];
  if (name !== undefined) { fields.push('name = ?'); params.push(name); }
  if (role_match !== undefined) { fields.push('role_match = ?'); params.push(role_match); }
  if (description !== undefined) { fields.push('description = ?'); params.push(description); }
  if (tasks !== undefined) { fields.push('tasks = ?'); params.push(JSON.stringify(tasks)); }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE hr_case_templates SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

router.delete('/templates/:id', requireAuth, requireWorkspace, requireRole('admin'), (req, res) => {
  const row = db.prepare('SELECT id FROM hr_case_templates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM hr_case_templates WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---- Sona: draft a checklist from plain English ----
// Grounded in this workspace's real groups (never invents one) and its own
// existing templates for that case_type as few-shot vocabulary reference.
// Never saves anything -- the frontend resolves group_name -> a real
// group_id itself (same trust boundary as the workflow builder's AI draft:
// the model is trusted to pick from real names it was given, not trusted to
// invent an id).
router.post('/draft', requireAuth, requireWorkspace, requireRole('admin', 'agent'), async (req, res) => {
  try {
    const { case_type, description, department, job_title, employment_type } = req.body;
    if (!case_type || !['onboarding', 'offboarding'].includes(case_type)) {
      return res.status(400).json({ error: 'case_type must be onboarding or offboarding' });
    }
    if (!description || !description.trim()) return res.status(400).json({ error: 'description required' });
    const groups = db.prepare('SELECT id, name FROM groups WHERE workspace_id = ?').all(req.workspaceId);
    const templates = db.prepare(
      'SELECT name, tasks FROM hr_case_templates WHERE workspace_id = ? AND case_type = ? AND enabled = 1'
    ).all(req.workspaceId, case_type);
    const provider = getProvider(req.workspaceId, req.body.provider_id);
    const draft = await draftHrCaseTasks(provider, description.trim(), {
      caseType: case_type, groups, templates, department, jobTitle: job_title, employmentType: employment_type,
    });
    res.json({ draft, groups });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Creates a case and, optionally, its initial checklist in one call --
// either materialized from a template (template_id) or from a caller-
// supplied blueprint array (an AI draft the frontend already resolved
// group names on, or a hand-built list). Blank cases (neither) start with
// zero tasks; tasks are added afterward via POST /:id/tasks.
router.post('/', requireAuth, requireWorkspace, requireRole('admin', 'agent'), (req, res) => {
  const {
    case_type, employee_name, employee_email, job_title, department, employment_type, location,
    manager_id, buddy_id, start_date, last_working_day, risk_level, notes, template_id, tasks, tasks_source,
  } = req.body;
  if (!case_type || !['onboarding', 'offboarding'].includes(case_type)) {
    return res.status(400).json({ error: 'case_type must be onboarding or offboarding' });
  }
  if (!employee_name || !employee_name.trim()) return res.status(400).json({ error: 'employee_name required' });

  const id = uid('hrc');
  db.prepare(
    `INSERT INTO hr_cases (id, workspace_id, case_type, employee_name, employee_email, job_title, department,
       employment_type, location, manager_id, buddy_id, start_date, last_working_day, risk_level, template_id, notes, created_by, stage)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, req.workspaceId, case_type, employee_name.trim(), employee_email || null, job_title || null, department || null,
    employment_type || 'full_time', location || null, manager_id || null, buddy_id || null,
    start_date || null, last_working_day || null, risk_level || 'standard', template_id || null, notes || null,
    req.user.id, stagesFor(case_type)[0].key
  );

  const kase = db.prepare('SELECT * FROM hr_cases WHERE id = ?').get(id);

  let blueprintTasks = Array.isArray(tasks) && tasks.length ? tasks : null;
  let source = tasks_source === 'ai' ? 'ai' : 'manual';
  if (!blueprintTasks && template_id) {
    const tmpl = db.prepare('SELECT tasks FROM hr_case_templates WHERE id = ? AND workspace_id = ?').get(template_id, req.workspaceId);
    if (tmpl) {
      blueprintTasks = JSON.parse(tmpl.tasks || '[]');
      source = 'template';
    }
  }
  if (blueprintTasks && blueprintTasks.length) materializeTasks(kase, blueprintTasks, source);

  if (manager_id) {
    notifyUser(
      manager_id, `New ${case_type} case: ${employee_name}`,
      `You're listed as the manager for ${employee_name}'s ${case_type} checklist.`,
      `/hr-cases/${id}`, req.workspaceId
    );
  }

  res.status(201).json({ id });
});

// ---- Single case ----

router.get('/:id', requireAuth, requireWorkspace, requireRole('admin', 'agent'), (req, res) => {
  const kase = db.prepare('SELECT * FROM hr_cases WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!kase) return res.status(404).json({ error: 'Not found' });
  res.json(withTasks(kase));
});

router.patch('/:id', requireAuth, requireWorkspace, requireRole('admin', 'agent'), (req, res) => {
  const kase = db.prepare('SELECT * FROM hr_cases WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!kase) return res.status(404).json({ error: 'Not found' });
  const allowed = [
    'employee_name', 'employee_email', 'job_title', 'department', 'employment_type', 'location',
    'manager_id', 'buddy_id', 'start_date', 'last_working_day', 'risk_level', 'notes', 'status',
  ];
  const fields = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE hr_cases SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  res.json({ ok: true });
});

// ---- Tasks within a case ----

router.post('/:id/tasks', requireAuth, requireWorkspace, requireRole('admin', 'agent'), (req, res) => {
  const kase = db.prepare('SELECT * FROM hr_cases WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!kase) return res.status(404).json({ error: 'Not found' });
  const { title, description, track, stage_key, group_id, assignee_id, due_at, requires_decision, depends_on_task_id } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: 'title required' });

  const stages = stagesFor(kase.case_type);
  const validStage = stages.some((s) => s.key === stage_key) ? stage_key : stages[0].key;
  const sortOrder = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 n FROM hr_case_tasks WHERE case_id = ?').get(kase.id).n;

  const id = uid('hct');
  db.prepare(
    `INSERT INTO hr_case_tasks (id, case_id, title, description, track, stage_key, group_id, assignee_id, due_at, requires_decision, depends_on_task_id, sort_order, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id, kase.id, title.trim(), description || null, track || 'other', validStage,
    group_id || null, assignee_id || null, due_at || null, requires_decision ? 1 : 0,
    depends_on_task_id || null, sortOrder, 'manual'
  );
  recomputeCaseStage(kase.id);

  if (assignee_id) {
    notifyUser(assignee_id, `New task: ${title.trim()}`, `Assigned on ${kase.employee_name}'s ${kase.case_type} checklist.`, `/hr-cases/${kase.id}`, req.workspaceId);
  }

  res.status(201).json({ id });
});

router.patch('/:id/tasks/:taskId', requireAuth, requireWorkspace, requireRole('admin', 'agent'), (req, res) => {
  const kase = db.prepare('SELECT * FROM hr_cases WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!kase) return res.status(404).json({ error: 'Not found' });
  const task = db.prepare('SELECT id FROM hr_case_tasks WHERE id = ? AND case_id = ?').get(req.params.taskId, kase.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const allowed = ['title', 'description', 'track', 'stage_key', 'group_id', 'assignee_id', 'status', 'due_at', 'depends_on_task_id'];
  const fields = []; const params = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  }
  if (req.body.status === 'done') {
    fields.push('completed_at = ?'); params.push(new Date().toISOString());
    fields.push('completed_by = ?'); params.push(req.user.id);
  } else if (req.body.status !== undefined) {
    fields.push('completed_at = NULL');
    fields.push('completed_by = NULL');
  }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.taskId);
  db.prepare(`UPDATE hr_case_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  recomputeCaseStage(kase.id);
  res.json({ ok: true });
});

router.delete('/:id/tasks/:taskId', requireAuth, requireWorkspace, requireRole('admin', 'agent'), (req, res) => {
  const kase = db.prepare('SELECT * FROM hr_cases WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!kase) return res.status(404).json({ error: 'Not found' });
  const task = db.prepare('SELECT id FROM hr_case_tasks WHERE id = ? AND case_id = ?').get(req.params.taskId, kase.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  db.prepare('UPDATE hr_case_tasks SET depends_on_task_id = NULL WHERE depends_on_task_id = ?').run(req.params.taskId);
  db.prepare('DELETE FROM hr_case_tasks WHERE id = ?').run(req.params.taskId);
  recomputeCaseStage(kase.id);
  res.json({ ok: true });
});

// Approve/reject a task with requires_decision=1. Rejection has NO automatic
// downstream effect (no access revocation, no case cancellation) -- this
// module coordinates humans, it doesn't enforce IAM. A rejected sign-off is
// recorded and marked 'skipped' so it doesn't block the checklist forever;
// the rejection stays visible via `decision`.
router.post('/:id/tasks/:taskId/decide', requireAuth, requireWorkspace, requireRole('admin', 'agent'), (req, res) => {
  const kase = db.prepare('SELECT * FROM hr_cases WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!kase) return res.status(404).json({ error: 'Not found' });
  const task = db.prepare('SELECT * FROM hr_case_tasks WHERE id = ? AND case_id = ?').get(req.params.taskId, kase.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  if (!task.requires_decision) return res.status(400).json({ error: 'This task does not require a decision' });

  const decision = req.body.approve ? 'approved' : 'rejected';
  const status = req.body.approve ? 'done' : 'skipped';
  db.prepare(
    "UPDATE hr_case_tasks SET decision = ?, status = ?, completed_at = datetime('now'), completed_by = ? WHERE id = ?"
  ).run(decision, status, req.user.id, req.params.taskId);
  recomputeCaseStage(kase.id);
  res.json({ ok: true, decision });
});

export default router;
