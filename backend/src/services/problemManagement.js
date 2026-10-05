import { db, uid } from '../db.js';

export class ProblemError extends Error {
  constructor(message, status = 400, field_errors) {
    super(message);
    this.status = status;
    if (field_errors) this.field_errors = field_errors;
  }
}

// The lifecycle from the specification (§9.2). Each state says what must be
// true to leave it, which is what stops a problem being "closed" with no root
// cause recorded -- the failure mode that makes problem management a filing
// exercise instead of a practice.
export const PROBLEM_STATES = {
  identified: {
    label: 'Identified',
    description: 'Something recurring has been noticed but not yet written up.',
    next: ['logged', 'closed'],
  },
  logged: {
    label: 'Logged',
    description: 'Written up with its impact and the incidents it explains.',
    next: ['investigation', 'closed'],
  },
  investigation: {
    label: 'Investigation',
    description: 'Being worked on: evidence gathered, hypotheses tested.',
    next: ['rca', 'known_error', 'closed'],
  },
  rca: {
    label: 'Root cause analysis',
    description: 'The analysis itself, recorded step by step.',
    next: ['known_error', 'fix_planned', 'closed'],
  },
  known_error: {
    label: 'Known error',
    description: 'Cause understood and a workaround published, fix still to come.',
    next: ['fix_planned', 'resolved', 'closed'],
  },
  fix_planned: {
    label: 'Fix planned',
    description: 'A permanent fix is agreed and owned.',
    next: ['change_required', 'resolved', 'closed'],
  },
  change_required: {
    label: 'Change required',
    description: 'The fix needs a change to go through governance.',
    next: ['resolved', 'closed'],
  },
  resolved: {
    label: 'Resolved',
    description: 'Root cause removed, or the residual risk formally accepted.',
    next: ['closed', 'investigation'],
  },
  closed: {
    label: 'Closed',
    description: 'Finished and on the record.',
    next: [],
  },
};

export const RCA_METHODS = {
  five_whys: { label: 'Five Whys', step_label: 'Why', hint: 'Ask why the previous answer happened, until the answer is something you can change.' },
  fishbone: { label: 'Fishbone (Ishikawa)', step_label: 'Cause', hint: 'Group contributing causes — people, process, technology, environment.' },
  fault_tree: { label: 'Fault tree', step_label: 'Condition', hint: 'Work down from the failure through the conditions that had to hold.' },
  timeline: { label: 'Timeline', step_label: 'Event', hint: 'Reconstruct what happened in order, and where it first went wrong.' },
  kepner_tregoe: { label: 'Kepner-Tregoe', step_label: 'Distinction', hint: 'What is affected versus what could be but is not.' },
  other: { label: 'Other', step_label: 'Note', hint: 'Free-form analysis.' },
};

export const ROOT_CAUSE_CATEGORIES = [
  { value: 'change_related', label: 'Change related' },
  { value: 'software_defect', label: 'Software defect' },
  { value: 'hardware_failure', label: 'Hardware failure' },
  { value: 'capacity', label: 'Capacity or performance' },
  { value: 'configuration', label: 'Configuration error' },
  { value: 'human_error', label: 'Human error' },
  { value: 'process_gap', label: 'Process gap' },
  { value: 'third_party', label: 'Third party or supplier' },
  { value: 'security', label: 'Security' },
  { value: 'environmental', label: 'Environmental or facilities' },
  { value: 'unknown', label: 'Not determined' },
];

const ACTION_STATES = ['open', 'in_progress', 'done', 'cancelled'];

const getProblem = (workspaceId, id) => db.prepare(
  "SELECT * FROM tickets WHERE id = ? AND workspace_id = ? AND type = 'problem' AND deleted_at IS NULL"
).get(id, workspaceId);

function mustGet(workspaceId, id) {
  const row = getProblem(workspaceId, id);
  if (!row) throw new ProblemError('That problem no longer exists.', 404);
  return row;
}

const history = (ticketId, event, detail) =>
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), ticketId, event, detail);

// ---- state ---------------------------------------------------------------

/**
 * What a problem must have before it may leave its current state.
 *
 * These are the guards that make the lifecycle mean something. Without them a
 * problem can be marked "known error" with no workaround for anyone to use,
 * or closed with no cause recorded -- at which point the state is decoration.
 */
export function transitionGuards(problem, target) {
  const blockers = [];
  if (target === 'known_error' && !String(problem.workaround || '').trim()) {
    blockers.push({ field: 'workaround', message: 'A known error has to give people something to do meanwhile.' });
  }
  if (['fix_planned', 'change_required'].includes(target) && !String(problem.root_cause_detail || '').trim()) {
    blockers.push({ field: 'root_cause_detail', message: 'Plan the fix once the cause is written down.' });
  }
  if (target === 'resolved') {
    const hasCause = String(problem.root_cause_detail || '').trim();
    const accepted = !!problem.residual_risk_accepted;
    if (!hasCause && !accepted) {
      blockers.push({ field: 'root_cause_detail', message: 'Record the root cause, or formally accept the residual risk instead.' });
    }
    if (accepted && !String(problem.residual_risk_reason || '').trim()) {
      blockers.push({ field: 'residual_risk_reason', message: 'Accepting the risk needs a reason on the record.' });
    }
    const openActions = db.prepare("SELECT COUNT(*) c FROM problem_actions WHERE problem_id = ? AND status IN ('open','in_progress')").get(problem.id).c;
    if (openActions > 0) {
      blockers.push({ field: 'actions', message: `${openActions} corrective action${openActions === 1 ? ' is' : 's are'} still open.` });
    }
  }
  return blockers;
}

export function setState(workspaceId, id, user, target, { force = false } = {}) {
  const problem = mustGet(workspaceId, id);
  const current = problem.problem_state || 'identified';
  if (!PROBLEM_STATES[target]) throw new ProblemError(`Unknown state: ${target}`, 400);
  if (target === current) throw new ProblemError(`This problem is already ${PROBLEM_STATES[target].label.toLowerCase()}.`, 400);

  const allowed = PROBLEM_STATES[current].next;
  if (!allowed.includes(target)) {
    throw new ProblemError(
      `A problem in "${PROBLEM_STATES[current].label}" can move to: ${allowed.map((s) => PROBLEM_STATES[s].label).join(', ') || 'nothing — it is finished'}.`,
      409
    );
  }

  const blockers = transitionGuards(problem, target);
  // An override exists because reality sometimes disagrees with process, but
  // it is recorded as an override rather than pretending the guard passed.
  if (blockers.length && !force) {
    throw new ProblemError(`This problem is not ready to be ${PROBLEM_STATES[target].label.toLowerCase()}.`, 409, blockers);
  }

  const fields = ['problem_state = ?'];
  const params = [target];
  // The generic status every other part of the app queries is kept in step,
  // so a resolved problem leaves the open queues without anyone doing it by
  // hand -- and without the rest of the app having to learn problem states.
  if (target === 'resolved') { fields.push('status = ?', "resolved_at = datetime('now')"); params.push('resolved'); }
  else if (target === 'closed') { fields.push('status = ?', "closed_at = datetime('now')"); params.push('closed'); }
  else if (['resolved', 'closed'].includes(problem.status)) { fields.push('status = ?', 'resolved_at = NULL'); params.push('in_progress'); }
  else if (problem.status === 'open' && target !== 'identified') { fields.push('status = ?'); params.push('in_progress'); }
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...params);

  history(id, 'problem_state', `${PROBLEM_STATES[current].label} → ${PROBLEM_STATES[target].label}`
    + (blockers.length ? ` (forced past: ${blockers.map((b) => b.message).join(' ')})` : ''));
  return get(workspaceId, id);
}

// ---- fields --------------------------------------------------------------

const EDITABLE = [
  'rca_method', 'root_cause_category', 'root_cause_detail', 'workaround',
  'problem_frequency', 'business_impact', 'lessons_learned', 'closure_code',
  'residual_risk_accepted', 'residual_risk_reason',
];

export function updateProblem(workspaceId, id, user, body) {
  mustGet(workspaceId, id);
  const fields = []; const params = [];
  for (const key of EDITABLE) {
    if (body[key] === undefined) continue;
    if (key === 'rca_method' && body[key] && !RCA_METHODS[body[key]]) {
      throw new ProblemError(`Unknown analysis method: ${body[key]}`, 400, [{ field: 'rca_method', message: 'Not a method this app offers' }]);
    }
    if (key === 'root_cause_category' && body[key] && !ROOT_CAUSE_CATEGORIES.some((c) => c.value === body[key])) {
      throw new ProblemError(`Unknown root cause category: ${body[key]}`, 400, [{ field: 'root_cause_category', message: 'Not a category this app offers' }]);
    }
    fields.push(`${key} = ?`);
    params.push(key === 'residual_risk_accepted' ? (body[key] ? 1 : 0) : body[key]);
  }
  if (!fields.length) throw new ProblemError('Nothing to update.', 400);
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE tickets SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  history(id, 'problem_updated', Object.keys(body).filter((k) => EDITABLE.includes(k)).join(', '));
  return get(workspaceId, id);
}

// Declaring a known error is its own act, not a field edit: it publishes a
// workaround to everyone working the incidents this problem explains, so it
// is stamped and recorded.
export function declareKnownError(workspaceId, id, user, { workaround, article_id } = {}) {
  const problem = mustGet(workspaceId, id);
  const text = String(workaround ?? problem.workaround ?? '').trim();
  if (!text) {
    throw new ProblemError('A known error needs a workaround people can actually use.', 400, [{ field: 'workaround', message: 'Required' }]);
  }
  db.prepare(
    "UPDATE tickets SET is_known_error = 1, workaround = ?, known_error_at = datetime('now'), known_error_article_id = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(text, article_id || problem.known_error_article_id || null, id);
  if ((problem.problem_state || 'identified') !== 'known_error' && PROBLEM_STATES[problem.problem_state || 'identified'].next.includes('known_error')) {
    setState(workspaceId, id, user, 'known_error', { force: true });
  }
  history(id, 'known_error', 'Declared a known error and published the workaround');
  return get(workspaceId, id);
}

export function revokeKnownError(workspaceId, id, user) {
  mustGet(workspaceId, id);
  db.prepare("UPDATE tickets SET is_known_error = 0, known_error_at = NULL, updated_at = datetime('now') WHERE id = ?").run(id);
  history(id, 'known_error_revoked', 'Withdrew the known error');
  return get(workspaceId, id);
}

// ---- incidents -----------------------------------------------------------

export function linkIncident(workspaceId, problemId, user, incidentId, note) {
  mustGet(workspaceId, problemId);
  const incident = db.prepare(
    "SELECT id, type FROM tickets WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL"
  ).get(incidentId, workspaceId);
  if (!incident) throw new ProblemError('That ticket no longer exists.', 404);
  if (incident.id === problemId) throw new ProblemError('A problem cannot explain itself.', 400);
  if (incident.type === 'problem') throw new ProblemError('Link the incidents a problem explains, not other problems.', 400);

  const existing = db.prepare('SELECT id FROM problem_incidents WHERE problem_id = ? AND incident_id = ?').get(problemId, incidentId);
  if (existing) throw new ProblemError('That ticket is already linked to this problem.', 409);

  db.prepare('INSERT INTO problem_incidents (id, workspace_id, problem_id, incident_id, note, linked_by) VALUES (?,?,?,?,?,?)')
    .run(uid('pri'), workspaceId, problemId, incidentId, note || null, user.id);
  history(problemId, 'incident_linked', `Linked ${incident.id}`);
  history(incidentId, 'problem_linked', 'Linked to a problem investigation');
  return listIncidents(workspaceId, problemId);
}

export function unlinkIncident(workspaceId, problemId, user, incidentId) {
  mustGet(workspaceId, problemId);
  const row = db.prepare('SELECT id FROM problem_incidents WHERE problem_id = ? AND incident_id = ?').get(problemId, incidentId);
  if (!row) throw new ProblemError('That ticket is not linked to this problem.', 404);
  db.prepare('DELETE FROM problem_incidents WHERE id = ?').run(row.id);
  history(problemId, 'incident_unlinked', `Unlinked ${incidentId}`);
  return listIncidents(workspaceId, problemId);
}

export function listIncidents(workspaceId, problemId) {
  return db.prepare(
    `SELECT pi.id AS link_id, pi.note, pi.created_at AS linked_at,
            t.id, t.number, t.title, t.status, t.priority, t.category, t.created_at, t.resolved_at,
            u.name AS requester_name
     FROM problem_incidents pi
     JOIN tickets t ON t.id = pi.incident_id
     LEFT JOIN users u ON u.id = t.requester_id
     WHERE pi.problem_id = ? AND pi.workspace_id = ?
     ORDER BY t.created_at DESC`
  ).all(problemId, workspaceId);
}

// ---- analysis ------------------------------------------------------------

export function addRcaStep(workspaceId, problemId, user, { content, label }) {
  mustGet(workspaceId, problemId);
  const text = String(content || '').trim();
  if (!text) throw new ProblemError('Write the step before adding it.', 400, [{ field: 'content', message: 'Required' }]);
  const next = db.prepare('SELECT COALESCE(MAX(sequence), -1) + 1 AS n FROM problem_rca_steps WHERE problem_id = ?').get(problemId).n;
  db.prepare('INSERT INTO problem_rca_steps (id, workspace_id, problem_id, sequence, label, content, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(uid('rca'), workspaceId, problemId, next, label || null, text, user.id);
  return listRcaSteps(workspaceId, problemId);
}

export function updateRcaStep(workspaceId, stepId, user, { content, label }) {
  const step = db.prepare('SELECT * FROM problem_rca_steps WHERE id = ? AND workspace_id = ?').get(stepId, workspaceId);
  if (!step) throw new ProblemError('That step no longer exists.', 404);
  const text = content === undefined ? step.content : String(content).trim();
  if (!text) throw new ProblemError('A step cannot be emptied — delete it instead.', 400, [{ field: 'content', message: 'Required' }]);
  db.prepare('UPDATE problem_rca_steps SET content = ?, label = ? WHERE id = ?')
    .run(text, label === undefined ? step.label : label, stepId);
  return listRcaSteps(workspaceId, step.problem_id);
}

export function deleteRcaStep(workspaceId, stepId) {
  const step = db.prepare('SELECT * FROM problem_rca_steps WHERE id = ? AND workspace_id = ?').get(stepId, workspaceId);
  if (!step) throw new ProblemError('That step no longer exists.', 404);
  db.prepare('DELETE FROM problem_rca_steps WHERE id = ?').run(stepId);
  // Renumbered so the sequence stays contiguous; a Five Whys with a hole in
  // the middle reads as though a step was lost rather than removed.
  const rest = db.prepare('SELECT id FROM problem_rca_steps WHERE problem_id = ? ORDER BY sequence').all(step.problem_id);
  const stmt = db.prepare('UPDATE problem_rca_steps SET sequence = ? WHERE id = ?');
  rest.forEach((r, i) => stmt.run(i, r.id));
  return listRcaSteps(workspaceId, step.problem_id);
}

export const listRcaSteps = (workspaceId, problemId) => db.prepare(
  `SELECT s.*, u.name AS author_name
   FROM problem_rca_steps s LEFT JOIN users u ON u.id = s.created_by
   WHERE s.problem_id = ? AND s.workspace_id = ? ORDER BY s.sequence`
).all(problemId, workspaceId);

// ---- corrective actions --------------------------------------------------

export function addAction(workspaceId, problemId, user, body) {
  mustGet(workspaceId, problemId);
  const title = String(body.title || '').trim();
  if (!title) throw new ProblemError('Give the action a title.', 400, [{ field: 'title', message: 'Required' }]);
  if (body.owner_id) {
    const owner = db.prepare('SELECT id FROM users WHERE id = ?').get(body.owner_id);
    if (!owner) throw new ProblemError('That owner does not exist.', 400, [{ field: 'owner_id', message: 'Unknown user' }]);
  }
  const id = uid('pac');
  db.prepare(
    'INSERT INTO problem_actions (id, workspace_id, problem_id, title, description, owner_id, due_date, change_ticket_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, workspaceId, problemId, title, body.description || null, body.owner_id || null, body.due_date || null, body.change_ticket_id || null, user.id);
  history(problemId, 'action_added', `Corrective action: ${title}`);
  return listActions(workspaceId, problemId);
}

export function updateAction(workspaceId, actionId, user, body) {
  const action = db.prepare('SELECT * FROM problem_actions WHERE id = ? AND workspace_id = ?').get(actionId, workspaceId);
  if (!action) throw new ProblemError('That action no longer exists.', 404);
  const fields = []; const params = [];
  for (const key of ['title', 'description', 'owner_id', 'due_date', 'outcome', 'change_ticket_id']) {
    if (body[key] !== undefined) { fields.push(`${key} = ?`); params.push(body[key] || null); }
  }
  if (body.status !== undefined) {
    if (!ACTION_STATES.includes(body.status)) {
      throw new ProblemError(`Status must be one of: ${ACTION_STATES.join(', ')}`, 400, [{ field: 'status', message: 'Not a status' }]);
    }
    fields.push('status = ?'); params.push(body.status);
    // Finishing an action stamps when, and un-finishing clears it, so a
    // reopened action cannot keep a completion date it no longer has.
    fields.push(body.status === 'done' ? "completed_at = datetime('now')" : 'completed_at = NULL');
  }
  if (!fields.length) throw new ProblemError('Nothing to update.', 400);
  params.push(actionId);
  db.prepare(`UPDATE problem_actions SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  if (body.status === 'done') history(action.problem_id, 'action_done', `Completed: ${action.title}`);
  return listActions(workspaceId, action.problem_id);
}

export function deleteAction(workspaceId, actionId) {
  const action = db.prepare('SELECT * FROM problem_actions WHERE id = ? AND workspace_id = ?').get(actionId, workspaceId);
  if (!action) throw new ProblemError('That action no longer exists.', 404);
  db.prepare('DELETE FROM problem_actions WHERE id = ?').run(actionId);
  return listActions(workspaceId, action.problem_id);
}

export const listActions = (workspaceId, problemId) => db.prepare(
  `SELECT a.*, u.name AS owner_name, c.number AS change_number
   FROM problem_actions a
   LEFT JOIN users u ON u.id = a.owner_id
   LEFT JOIN tickets c ON c.id = a.change_ticket_id
   WHERE a.problem_id = ? AND a.workspace_id = ?
   ORDER BY CASE a.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
            COALESCE(a.due_date, '9999') ASC`
).all(problemId, workspaceId);

// ---- read ----------------------------------------------------------------

export function get(workspaceId, id) {
  const problem = mustGet(workspaceId, id);
  const state = problem.problem_state || 'identified';
  const incidents = listIncidents(workspaceId, id);
  const actions = listActions(workspaceId, id);
  return {
    ...problem,
    problem_state: state,
    state_label: PROBLEM_STATES[state].label,
    available_states: PROBLEM_STATES[state].next.map((s) => ({
      key: s, label: PROBLEM_STATES[s].label, blockers: transitionGuards(problem, s),
    })),
    incidents,
    incident_count: incidents.length,
    rca_steps: listRcaSteps(workspaceId, id),
    actions,
    open_actions: actions.filter((a) => ['open', 'in_progress'].includes(a.status)).length,
    overdue_actions: actions.filter((a) => ['open', 'in_progress'].includes(a.status) && a.due_date && a.due_date < new Date().toISOString().slice(0, 10)).length,
  };
}

export function meta() {
  return {
    states: Object.entries(PROBLEM_STATES).map(([key, s]) => ({ key, ...s })),
    rca_methods: Object.entries(RCA_METHODS).map(([key, m]) => ({ key, ...m })),
    root_cause_categories: ROOT_CAUSE_CATEGORIES,
    action_states: ACTION_STATES,
  };
}

// The known-error register: every published workaround in one place, which is
// what the service desk actually reaches for mid-call.
export function knownErrors(workspaceId, { q } = {}) {
  const rows = db.prepare(
    `SELECT t.id, t.number, t.title, t.workaround, t.root_cause_category, t.root_cause_detail,
            t.known_error_at, t.problem_state, t.category,
            (SELECT COUNT(*) FROM problem_incidents pi WHERE pi.problem_id = t.id) AS incident_count
     FROM tickets t
     WHERE t.workspace_id = ? AND t.type = 'problem' AND t.is_known_error = 1 AND t.deleted_at IS NULL
     ORDER BY t.known_error_at DESC`
  ).all(workspaceId);
  if (!q) return rows;
  const needle = String(q).toLowerCase();
  return rows.filter((r) => `${r.title} ${r.workaround} ${r.root_cause_detail}`.toLowerCase().includes(needle));
}
