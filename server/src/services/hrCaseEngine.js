// Employee Onboarding / Offboarding engine. A dedicated module (see db.js
// for the schema rationale) rather than a ticket type -- stages are
// hardcoded per case_type (mirroring lifecycleEngine.js's LIFECYCLE_TEMPLATES
// pattern) so the progress stepper has a consistent, predictable shape
// across every case instead of drifting per admin.
import { db, uid } from '../db.js';

export const ONBOARDING_STAGES = [
  { key: 'pre_boarding', label: 'Pre-boarding' },
  { key: 'day_one', label: 'Day One' },
  { key: 'week_one', label: 'Week One' },
  { key: 'thirty_sixty_ninety', label: '30/60/90 Days' },
  { key: 'complete', label: 'Complete' },
];

export const OFFBOARDING_STAGES = [
  { key: 'initiated', label: 'Initiated' },
  { key: 'access_revocation', label: 'Access Revocation' },
  { key: 'asset_return', label: 'Asset Return' },
  { key: 'exit_interview', label: 'Exit Interview' },
  { key: 'complete', label: 'Complete' },
];

export function stagesFor(caseType) {
  return caseType === 'offboarding' ? OFFBOARDING_STAGES : ONBOARDING_STAGES;
}

// hr_cases.stage is never written directly by a route -- it's always
// derived here, from the tasks, after any task mutation. A case sits at the
// earliest stage that still has an incomplete task; once every task is
// done/skipped it moves to "complete" and the case itself is marked
// completed. This is what makes the progress stepper advance automatically
// instead of requiring someone to manually move the case forward.
export function recomputeCaseStage(caseId) {
  const kase = db.prepare('SELECT * FROM hr_cases WHERE id = ?').get(caseId);
  if (!kase || kase.status === 'cancelled') return;

  const stages = stagesFor(kase.case_type);
  const tasks = db.prepare('SELECT * FROM hr_case_tasks WHERE case_id = ?').all(caseId);

  let stageKey = stages[0].key;
  if (tasks.length > 0) {
    const openStages = stages.filter((s) => s.key !== 'complete');
    const next = openStages.find((s) => tasks.some((t) => t.stage_key === s.key && t.status !== 'done' && t.status !== 'skipped'));
    stageKey = next ? next.key : 'complete';
  }

  const isComplete = stageKey === 'complete';
  db.prepare(
    `UPDATE hr_cases SET stage = ?, status = ?,
       completed_at = CASE WHEN ? THEN COALESCE(completed_at, datetime('now')) ELSE NULL END,
       updated_at = datetime('now')
     WHERE id = ?`
  ).run(stageKey, isComplete ? 'completed' : 'in_progress', isComplete ? 1 : 0, caseId);
}

// Read-time only -- a blocked task can still always be marked done by an
// agent. This is advisory display ("blocked by X"), never a hard gate, and
// only looks one level up (single parent, not a full dependency graph).
export function isTaskBlocked(task, tasksById) {
  if (!task.depends_on_task_id) return false;
  const parent = tasksById[task.depends_on_task_id];
  if (!parent) return false;
  return parent.status !== 'done' && parent.status !== 'skipped';
}

// Materializes a blueprint task array (from a template or an AI draft) into
// real hr_case_tasks rows. due_offset_days is resolved against the case's
// start_date (onboarding) or last_working_day (offboarding); depends_on_index
// (a 0-based index into the SAME blueprint array) is resolved into a real
// depends_on_task_id in a second pass, once every row has a real id.
export function materializeTasks(kase, blueprintTasks, source) {
  const baseDate = kase.case_type === 'offboarding' ? kase.last_working_day : kase.start_date;
  const defaultStage = stagesFor(kase.case_type)[0].key;
  const existingCount = db.prepare('SELECT COUNT(*) c FROM hr_case_tasks WHERE case_id = ?').get(kase.id).c;

  const insert = db.prepare(
    `INSERT INTO hr_case_tasks (id, case_id, title, description, track, stage_key, group_id, requires_decision, due_at, sort_order, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertedIds = blueprintTasks.map((t, i) => {
    const id = uid('hct');
    const dueAt = baseDate && Number.isFinite(t.due_offset_days)
      ? new Date(new Date(baseDate + 'T00:00:00').getTime() + t.due_offset_days * 86400000).toISOString().slice(0, 10)
      : null;
    insert.run(
      id, kase.id, t.title, t.description || null, t.track || 'other', t.stage_key || defaultStage,
      t.group_id || null, t.requires_decision ? 1 : 0, dueAt, existingCount + i, source
    );
    return id;
  });

  blueprintTasks.forEach((t, i) => {
    if (Number.isInteger(t.depends_on_index) && insertedIds[t.depends_on_index]) {
      db.prepare('UPDATE hr_case_tasks SET depends_on_task_id = ? WHERE id = ?').run(insertedIds[t.depends_on_index], insertedIds[i]);
    }
  });

  recomputeCaseStage(kase.id);
  return insertedIds;
}
