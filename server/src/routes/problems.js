import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireStaff } from '../middleware/auth.js';
import {
  ProblemError, meta, get, setState, updateProblem,
  declareKnownError, revokeKnownError,
  linkIncident, unlinkIncident, listIncidents,
  addRcaStep, updateRcaStep, deleteRcaStep,
  addAction, updateAction, deleteAction,
  knownErrors,
} from '../services/problemManagement.js';
import {
  refreshCandidates, listCandidates, dismissCandidate, markPromoted, problemTrends,
} from '../services/problemDetection.js';
import { nextTicketNumber } from '../services/ticketNumbering.js';

const router = Router();
router.use(requireAuth, requireWorkspace, requireStaff('problem.manage'));

const handle = (res, fn) => {
  try {
    return res.json(fn());
  } catch (e) {
    if (e instanceof ProblemError) {
      const body = { error: e.message };
      if (e.field_errors) body.field_errors = e.field_errors;
      return res.status(e.status).json(body);
    }
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
};

router.get('/meta', (req, res) => handle(res, () => meta()));

// The management view of the practice: is it finding causes, and is anything
// being done about them.
router.get('/trends', (req, res) => handle(res, () => problemTrends(req.workspaceId, {
  days: Math.min(365, Math.max(7, Number(req.query.days) || 90)),
})));

// The known-error register — what the desk reaches for mid-call.
router.get('/known-errors', (req, res) => handle(res, () => ({ known_errors: knownErrors(req.workspaceId, { q: req.query.q }) })));

// ---- candidates ----------------------------------------------------------

router.get('/candidates', (req, res) => handle(res, () => ({
  candidates: listCandidates(req.workspaceId, { status: req.query.status || 'open' }),
})));

router.post('/candidates/refresh', (req, res) => handle(res, () => ({
  candidates: refreshCandidates(req.workspaceId, {
    withinDays: Number(req.body?.within_days) || undefined,
    minIncidents: Number(req.body?.min_incidents) || undefined,
  }),
})));

router.post('/candidates/:id/dismiss', (req, res) => handle(res, () => ({
  candidates: dismissCandidate(req.workspaceId, req.params.id, req.user),
})));

// Turn a suggested cluster into a real problem, carrying its incidents across
// so the investigation starts with its evidence already attached.
router.post('/candidates/:id/promote', (req, res) => handle(res, () => {
  const candidate = db.prepare('SELECT * FROM problem_candidates WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!candidate) throw new ProblemError('That suggestion no longer exists.', 404);
  if (candidate.status === 'promoted') throw new ProblemError('A problem has already been raised for this.', 409);

  const id = uid('tkt');
  const number = nextTicketNumber(req.workspaceId, 'problem');
  const title = String(req.body?.title || '').trim()
    || `Recurring: ${candidate.label}`;

  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, description, status, priority, requester_id, problem_state, problem_frequency, source)
     VALUES (?,?,?,?,?,?,'open',?,?,'logged',?,'system')`
  ).run(
    id, req.workspaceId, number, 'problem', title,
    `Raised from a recurring pattern: ${candidate.incident_count} incidents matching "${candidate.label}" between ${String(candidate.first_seen || '').slice(0, 10)} and ${String(candidate.last_seen || '').slice(0, 10)}.`,
    req.body?.priority || 'medium', req.user.id,
    `${candidate.incident_count} in the detection window`
  );
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)')
    .run(uid('h'), id, 'created', `Raised from a detected recurring pattern (${candidate.label})`);

  const ids = candidate.sample_incident_ids ? JSON.parse(candidate.sample_incident_ids) : [];
  for (const incidentId of ids) {
    try { linkIncident(req.workspaceId, id, req.user, incidentId, 'Linked when the problem was raised from a detected pattern'); }
    catch { /* an incident that has since been merged or deleted is skipped */ }
  }
  markPromoted(req.workspaceId, req.params.id, req.user, id);
  return { problem: get(req.workspaceId, id) };
}));

// ---- one problem ---------------------------------------------------------

router.get('/:id', (req, res) => handle(res, () => ({ problem: get(req.workspaceId, req.params.id) })));

router.patch('/:id', (req, res) => handle(res, () => ({ problem: updateProblem(req.workspaceId, req.params.id, req.user, req.body) })));

router.post('/:id/state', (req, res) => handle(res, () => ({
  problem: setState(req.workspaceId, req.params.id, req.user, req.body.state, { force: !!req.body.force }),
})));

router.post('/:id/known-error', (req, res) => handle(res, () => ({
  problem: declareKnownError(req.workspaceId, req.params.id, req.user, req.body),
})));

router.delete('/:id/known-error', (req, res) => handle(res, () => ({
  problem: revokeKnownError(req.workspaceId, req.params.id, req.user),
})));

router.get('/:id/incidents', (req, res) => handle(res, () => ({ incidents: listIncidents(req.workspaceId, req.params.id) })));

router.post('/:id/incidents', (req, res) => handle(res, () => ({
  incidents: linkIncident(req.workspaceId, req.params.id, req.user, req.body.incident_id, req.body.note),
})));

router.delete('/:id/incidents/:incidentId', (req, res) => handle(res, () => ({
  incidents: unlinkIncident(req.workspaceId, req.params.id, req.user, req.params.incidentId),
})));

router.post('/:id/rca', (req, res) => handle(res, () => ({ steps: addRcaStep(req.workspaceId, req.params.id, req.user, req.body) })));
router.patch('/rca/:stepId', (req, res) => handle(res, () => ({ steps: updateRcaStep(req.workspaceId, req.params.stepId, req.user, req.body) })));
router.delete('/rca/:stepId', (req, res) => handle(res, () => ({ steps: deleteRcaStep(req.workspaceId, req.params.stepId) })));

router.post('/:id/actions', (req, res) => handle(res, () => ({ actions: addAction(req.workspaceId, req.params.id, req.user, req.body) })));
router.patch('/actions/:actionId', (req, res) => handle(res, () => ({ actions: updateAction(req.workspaceId, req.params.actionId, req.user, req.body) })));
router.delete('/actions/:actionId', (req, res) => handle(res, () => ({ actions: deleteAction(req.workspaceId, req.params.actionId) })));

export default router;
