import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requireRole, requirePermission } from '../middleware/auth.js';
import { listChangeTypes, effectiveChangeType, mandatoryFieldsFor } from '../services/changeTypes.js';
import { scoreChange, assessPlanQuality, saveAssessment, getAssessment, listRiskRules, listRiskBands } from '../services/changeRisk.js';
import { matchTemplate, applyTemplate, listTemplates } from '../services/changeTemplates.js';
import { evaluateWindow, suggestAlternateSlots, reserveSlot, releaseSlot, calendarView, activeFreezes } from '../services/changeCalendar.js';
import { createApprovalQueue, listApprovals, recordDecision, currentStep } from '../services/changeApproval.js';
import { CHANGE_STATES, availableTransitions, transition, transitionHistory, currentState } from '../services/changeWorkflow.js';
import { openPir, updatePir, completePir, getPir, isPirRequired, outstandingPirs, OUTCOMES } from '../services/changePir.js';
import { computeMetrics, stateCounts, monthlyTrend } from '../services/changeMetrics.js';
import { logAudit } from '../services/auditLog.js';
import { policyForState } from '../services/changeFieldPolicy.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

// ---- idempotency ---------------------------------------------------------
// The flow diagram's developer notes ask for it explicitly, and it matters
// most on the destructive steps: a retried "execute backout" must not run
// the backout twice. Applied only to mutating routes that opt in via
// idempotent(), keyed per workspace + route + key.
function idempotent(routeName) {
  return (req, res, next) => {
    const key = req.headers['idempotency-key'];
    if (!key) return next();

    const existing = db.prepare(
      'SELECT status_code, response_json FROM request_keys WHERE workspace_id = ? AND route = ? AND idempotency_key = ?'
    ).get(req.workspaceId, routeName, String(key));
    if (existing) {
      let body = null;
      try { body = existing.response_json ? JSON.parse(existing.response_json) : null; } catch { body = null; }
      return res.status(existing.status_code || 200).json({ ...body, idempotent_replay: true });
    }

    // Capture the response so a retry can replay it verbatim.
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      try {
        db.prepare(
          'INSERT OR IGNORE INTO request_keys (id, workspace_id, idempotency_key, route, status_code, response_json) VALUES (?,?,?,?,?,?)'
        ).run(uid('rk'), req.workspaceId, String(key), routeName, res.statusCode, JSON.stringify(body ?? null));
      } catch (e) {
        console.error('[changes] could not record idempotency key', e.message);
      }
      return originalJson(body);
    };
    next();
  };
}

const agentOnly = requireRole('agent', 'admin');

function getChange(id, workspaceId) {
  return db.prepare("SELECT * FROM tickets WHERE id = ? AND workspace_id = ? AND type = 'change'").get(id, workspaceId);
}

// The full change record: state, legal transitions with their blockers, risk
// breakdown, approvals, schedule verdict, tasks, evidence, PIR and audit.
// One call, because the workflow panel needs all of it at once and six
// round trips to render one panel is its own kind of bug.
function hydrate(workspaceId, ticket) {
  const type = effectiveChangeType(workspaceId, ticket.change_type);
  const schedule = ticket.scheduled_start && ticket.scheduled_end
    ? evaluateWindow(workspaceId, ticket, { start: ticket.scheduled_start, end: ticket.scheduled_end })
    : null;

  return {
    ticket,
    state: currentState(ticket),
    state_meta: CHANGE_STATES[currentState(ticket)],
    // Which fields this change's current state still allows to be edited.
    // The UI disables the rest; the ticket PATCH route refuses them outright.
    field_policy: policyForState(workspaceId, currentState(ticket)),
    states: CHANGE_STATES,
    change_type: type,
    transitions: availableTransitions(workspaceId, ticket),
    risk: getAssessment(ticket.id),
    approvals: listApprovals(ticket.id),
    current_approval_step: currentStep(ticket.id),
    schedule,
    freezes: ticket.scheduled_start
      ? activeFreezes(workspaceId, { start: ticket.scheduled_start, end: ticket.scheduled_end, ticket })
      : [],
    tasks: db.prepare('SELECT * FROM ticket_tasks WHERE ticket_id = ? ORDER BY sort_order ASC, created_at ASC').all(ticket.id),
    evidence: db.prepare("SELECT id, filename, mime, size, created_at FROM attachments WHERE ticket_id = ? AND kind = 'evidence' ORDER BY created_at DESC").all(ticket.id),
    pir: getPir(ticket.id),
    pir_required: isPirRequired(workspaceId, ticket),
    history: transitionHistory(ticket.id),
    template: ticket.standard_template_id
      ? db.prepare('SELECT id, name FROM standard_change_templates WHERE id = ?').get(ticket.standard_template_id)
      : null,
  };
}

// ---- reads ---------------------------------------------------------------

router.get('/meta', (req, res) => {
  res.json({
    states: CHANGE_STATES,
    change_types: listChangeTypes(req.workspaceId),
    risk_bands: listRiskBands(req.workspaceId),
    pir_outcomes: OUTCOMES,
  });
});

router.get('/', (req, res) => {
  const { state, change_type, risk_band, q } = req.query;
  const clauses = ["t.workspace_id = ?", "t.type = 'change'", 'COALESCE(t.is_spam,0) = 0'];
  const params = [req.workspaceId];
  if (state) { clauses.push("COALESCE(t.change_state,'new') = ?"); params.push(state); }
  if (change_type) { clauses.push('t.change_type = ?'); params.push(change_type); }
  if (risk_band) { clauses.push('t.risk_band = ?'); params.push(risk_band); }
  if (q) { clauses.push('(t.title LIKE ? OR t.number LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }

  const changes = db.prepare(
    `SELECT t.*, u.name AS assignee_name, r.name AS requester_name,
            (SELECT COUNT(*) FROM approvals a WHERE a.ticket_id = t.id AND a.status = 'pending') pending_approvals
     FROM tickets t
     LEFT JOIN users u ON u.id = t.assignee_id
     LEFT JOIN users r ON r.id = t.requester_id
     WHERE ${clauses.join(' AND ')}
     ORDER BY
       CASE t.risk_band WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       datetime(t.created_at) DESC
     LIMIT 500`
  ).all(...params);

  res.json({ changes, counts: stateCounts(req.workspaceId) });
});

router.get('/metrics', (req, res) => {
  res.json({
    metrics: computeMetrics(req.workspaceId, { days: Number(req.query.days) || 90 }),
    trend: monthlyTrend(req.workspaceId, { months: Number(req.query.months) || 6 }),
    outstanding_pirs: outstandingPirs(req.workspaceId),
  });
});

router.get('/calendar', (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : new Date();
  const days = Math.min(120, Math.max(1, Number(req.query.days) || 30));
  if (Number.isNaN(from.getTime())) return res.status(400).json({ error: 'Invalid from date' });
  const to = new Date(from.getTime() + days * 24 * 3600 * 1000);
  res.json({ ...calendarView(req.workspaceId, { from, to }), from: from.toISOString(), to: to.toISOString() });
});

router.get('/:id', (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  res.json(hydrate(req.workspaceId, ticket));
});

// Just the field-access policy for this change's current state. A separate,
// cheap read so the ticket form can grey out locked inputs without pulling
// the whole workflow payload (approvals, tasks, history, evidence...).
router.get('/:id/field-policy', (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  res.json(policyForState(req.workspaceId, currentState(ticket)));
});

// ---- stage 2 & 3: validation, classification, risk -----------------------

// The diagram's "Validate Data" step, as a dry run: reports what is missing
// without changing anything, so the UI can show the requester their gaps.
router.get('/:id/validate', (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });

  const required = mandatoryFieldsFor(req.workspaceId, ticket.change_type);
  const missing = required.filter((f) => f !== 'justification' && !String(ticket[f] ?? '').trim());

  // CI existence, per the diagram's "CI existence (from CMDB)" check.
  const linkedCis = db.prepare(
    'SELECT ta.asset_id, a.id AS exists_id, a.name FROM ticket_assets ta LEFT JOIN assets a ON a.id = ta.asset_id AND a.workspace_id = ? WHERE ta.ticket_id = ?'
  ).all(req.workspaceId, ticket.id);
  const unknownCis = linkedCis.filter((c) => !c.exists_id).map((c) => c.asset_id);

  // Duplicate check: another open change with the same title.
  const duplicate = db.prepare(
    `SELECT id, number FROM tickets WHERE workspace_id = ? AND type = 'change' AND id != ?
       AND LOWER(title) = LOWER(?) AND COALESCE(change_state,'new') NOT IN ('closed','rolled_back') LIMIT 1`
  ).get(req.workspaceId, ticket.id, ticket.title);

  res.json({
    valid: missing.length === 0 && unknownCis.length === 0,
    missing_fields: missing,
    unknown_cis: unknownCis,
    linked_ci_count: linkedCis.length,
    possible_duplicate: duplicate || null,
  });
});

// Stage 2 -> 3: accept the change for review. A named step at agent level,
// rather than routing through POST /:id/transition, which is the change
// manager's force/override endpoint and needs change.manage -- an agent
// could not otherwise submit their own change for review.
router.post('/:id/review', agentOnly, idempotent('review'), (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  const result = transition(req.workspaceId, ticket.id, 'in_review', { actor: req.user, reason: req.body?.reason || 'Submitted for review' });
  if (!result.ok) return res.status(400).json({ error: result.error, blockers: result.blockers });
  logAudit(req, { action: 'change.review', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number });
  res.json(hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)));
});

// Return a change to its requester -- the CAB-rejection and "needs more
// detail" path. Also agent level for the same reason as review above.
router.post('/:id/return', agentOnly, (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  const result = transition(req.workspaceId, ticket.id, 'new', { actor: req.user, reason: req.body?.reason || 'Returned to the requester' });
  if (!result.ok) return res.status(400).json({ error: result.error, blockers: result.blockers });
  res.json(hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)));
});

// Classification & routing: set the type, match a standard template, score
// risk, and (optionally) ask Sona to review the plans. This is the diagram's
// stage 3 in one call, because the steps are meaningless apart.
router.post('/:id/classify', agentOnly, idempotent('classify'), async (req, res) => {
  let ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });

  const requestedType = req.body?.change_type;
  if (requestedType && !listChangeTypes(req.workspaceId).some((t) => t.key === requestedType)) {
    return res.status(400).json({ error: `Unknown change type "${requestedType}"` });
  }
  let changeType = requestedType || ticket.change_type || 'normal';

  // The Standard lane's "Match?" decision. No match means the diagram's
  // explicit fallback: route it as Normal.
  let template = null;
  let routedAsNormal = false;
  if (changeType === 'standard') {
    template = matchTemplate(req.workspaceId, ticket);
    if (!template) {
      changeType = 'normal';
      routedAsNormal = true;
    }
  }

  db.prepare("UPDATE tickets SET change_type = ?, updated_at = datetime('now') WHERE id = ?").run(changeType, ticket.id);
  ticket = getChange(ticket.id, req.workspaceId);

  if (template) ticket = applyTemplate(req.workspaceId, ticket, template);

  const inFreeze = ticket.planned_start && ticket.planned_end
    ? activeFreezes(req.workspaceId, { start: ticket.planned_start, end: ticket.planned_end, ticket }).length > 0
    : false;
  const assessment = scoreChange(req.workspaceId, ticket, { inFreezeWindow: inFreeze });

  // Sona reviews plan quality as advice. Opt-in per call, because it costs a
  // provider call and admins re-classify while tuning.
  let advisory = { findings: [], aiUsed: false };
  if (req.body?.ai_review) {
    advisory = await assessPlanQuality(req.workspaceId, ticket);
  }
  saveAssessment(req.workspaceId, ticket.id, assessment, advisory);

  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticket.id, 'updated',
    `Classified as ${changeType}${routedAsNormal ? ' (no standard template matched)' : ''} — risk ${assessment.band} (${assessment.score})`
  );
  logAudit(req, { action: 'change.classify', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, details: { changeType, band: assessment.band } });

  res.json({
    ...hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)),
    matched_template: template ? { id: template.id, name: template.name } : null,
    routed_as_normal: routedAsNormal,
  });
});

// ---- stage 4: approvals --------------------------------------------------

router.post('/:id/submit-for-approval', agentOnly, idempotent('submit'), (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });

  const type = effectiveChangeType(req.workspaceId, ticket.change_type);

  // The Standard lane auto-approves off its template rather than routing.
  if (type?.approval_mode === 'auto_template' && ticket.standard_template_id) {
    const template = db.prepare('SELECT * FROM standard_change_templates WHERE id = ?').get(ticket.standard_template_id);
    if (template?.auto_approve) {
      db.prepare(
        `INSERT INTO approvals (id, ticket_id, approver_role, approver_type, step_order, status, comments, decided_at)
         VALUES (?,?,?,?,1,'approved',?,datetime('now'))`
      ).run(uid('apr'), ticket.id, 'system', 'user', `Auto-approved: matched standard change template "${template.name}"`);

      const toReview = transition(req.workspaceId, ticket.id, 'in_review', { actor: req.user, reason: 'Standard change validated' });
      if (!toReview.ok && !toReview.unchanged) return res.status(400).json({ error: toReview.error, blockers: toReview.blockers });
      const approved = transition(req.workspaceId, ticket.id, 'approved', { actor: req.user, reason: `Auto-approved from template "${template.name}"` });
      if (!approved.ok) return res.status(400).json({ error: approved.error, blockers: approved.blockers });

      return res.json({ ...hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)), auto_approved: true });
    }
  }

  const queue = createApprovalQueue(req.workspaceId, ticket, { actorId: req.user.id });
  if (!queue.ok) return res.status(400).json({ error: queue.error, unsatisfiable: queue.unsatisfiable });

  // Move through In Review if the change has not been there yet.
  if (currentState(ticket) === 'new') {
    const toReview = transition(req.workspaceId, ticket.id, 'in_review', { actor: req.user, reason: 'Submitted for approval' });
    if (!toReview.ok) return res.status(400).json({ error: toReview.error, blockers: toReview.blockers });
  }
  const pending = transition(req.workspaceId, ticket.id, 'pending_approval', { actor: req.user, reason: `Routed via "${queue.route.name}"` });
  if (!pending.ok) return res.status(400).json({ error: pending.error, blockers: pending.blockers });

  logAudit(req, { action: 'change.submit_for_approval', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, details: { route: queue.route.name } });
  res.json({ ...hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)), route: queue.route, unsatisfiable: queue.unsatisfiable });
});

// An individual approver's decision (the async path). The CAB-meeting path
// lives in routes/cab.js.
router.post('/:id/approvals/:approvalId/decide', idempotent('decide'), (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });

  const approval = db.prepare('SELECT * FROM approvals WHERE id = ? AND ticket_id = ?').get(req.params.approvalId, ticket.id);
  if (!approval) return res.status(404).json({ error: 'Approval not found' });
  // Only the named approver, or an admin acting for the board, may decide.
  if (approval.approver_id && approval.approver_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'That approval is assigned to someone else' });
  }

  const result = recordDecision(req.workspaceId, ticket.id, approval.id, {
    decision: req.body?.decision,
    comments: req.body?.comments,
    conditions: req.body?.conditions,
    actor: req.user,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });

  if (result.rejected) {
    transition(req.workspaceId, ticket.id, 'new', { actor: req.user, reason: `Rejected: ${req.body?.comments || 'no reason given'}` });
  } else if (result.fullyApproved) {
    transition(req.workspaceId, ticket.id, 'approved', { actor: req.user, reason: 'All approvals granted' });
  }

  logAudit(req, { action: 'change.approval_decision', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, details: { decision: req.body?.decision } });
  res.json({ ...hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)), decision: result });
});

// ---- stage 5: scheduling -------------------------------------------------

// Dry run against a proposed window: conflicts, freezes, and alternates.
router.post('/:id/check-window', agentOnly, (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });

  const { start, end } = req.body || {};
  const verdict = evaluateWindow(req.workspaceId, ticket, { start, end });
  res.json({
    ...verdict,
    alternates: verdict.ok && !verdict.requiresOverride ? [] : suggestAlternateSlots(req.workspaceId, ticket, { start, end }),
  });
});

router.post('/:id/schedule', agentOnly, idempotent('schedule'), (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });

  const result = reserveSlot(req.workspaceId, ticket, {
    start: req.body?.start,
    end: req.body?.end,
    actorId: req.user.id,
    overrideReason: req.body?.override_reason,
  });
  if (!result.ok) {
    return res.status(400).json({
      error: result.error,
      requiresOverride: !!result.requiresOverride,
      verdict: result.verdict,
      alternates: result.alternates || [],
    });
  }

  const moved = transition(req.workspaceId, ticket.id, 'scheduled', { actor: req.user, reason: 'Implementation window reserved' });
  logAudit(req, { action: 'change.schedule', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, details: { start: req.body?.start, override: !!req.body?.override_reason } });

  res.json({
    ...hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)),
    scheduled: true,
    transition: moved,
    advisory_conflicts: result.advisoryConflicts,
  });
});

router.post('/:id/release-schedule', agentOnly, (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  releaseSlot(req.workspaceId, ticket.id);
  transition(req.workspaceId, ticket.id, 'approved', { actor: req.user, reason: 'Scheduled slot released' });
  res.json(hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)));
});

// ---- stage 6: implementation --------------------------------------------

router.post('/:id/start', agentOnly, idempotent('start'), (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  const result = transition(req.workspaceId, ticket.id, 'in_progress', { actor: req.user, reason: req.body?.reason || 'Implementation started' });
  if (!result.ok) return res.status(400).json({ error: result.error, blockers: result.blockers });
  logAudit(req, { action: 'change.start', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number });
  res.json(hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)));
});

router.post('/:id/complete', agentOnly, idempotent('complete'), (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });

  const result = transition(req.workspaceId, ticket.id, 'implemented', { actor: req.user, reason: req.body?.reason || 'Implementation complete' });
  if (!result.ok) return res.status(400).json({ error: result.error, blockers: result.blockers });

  // The diagram triggers the PIR from here.
  openPir(req.workspaceId, getChange(ticket.id, req.workspaceId), { actorId: req.user.id });
  logAudit(req, { action: 'change.complete', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number });
  res.json(hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)));
});

// The diagram's "Execute Backout Plan". Idempotency matters most here: a
// retried request must not be read as a second backout.
router.post('/:id/rollback', agentOnly, idempotent('rollback'), (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  if (!String(req.body?.reason || '').trim()) {
    return res.status(400).json({ error: 'Record why the backout was executed' });
  }

  const result = transition(req.workspaceId, ticket.id, 'rolled_back', { actor: req.user, reason: req.body.reason });
  if (!result.ok) return res.status(400).json({ error: result.error, blockers: result.blockers });

  openPir(req.workspaceId, getChange(ticket.id, req.workspaceId), { actorId: req.user.id });
  logAudit(req, { action: 'change.rollback', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, details: { reason: req.body.reason } });
  res.json(hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)));
});

router.post('/:id/reopen', agentOnly, (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  const result = transition(req.workspaceId, ticket.id, 'reopened', { actor: req.user, reason: req.body?.reason || 'Validation failed' });
  if (!result.ok) return res.status(400).json({ error: result.error, blockers: result.blockers });
  res.json(hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)));
});

// ---- stage 6/7: PIR and closure -----------------------------------------

router.post('/:id/pir', agentOnly, (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  res.json(openPir(req.workspaceId, ticket, { actorId: req.user.id }));
});

router.patch('/:id/pir', agentOnly, (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  const result = updatePir(req.workspaceId, ticket.id, req.body || {});
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.post('/:id/pir/complete', agentOnly, (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  const result = completePir(req.workspaceId, ticket.id, { actor: req.user });
  if (!result.ok) return res.status(400).json({ error: result.error });
  logAudit(req, { action: 'change.pir_complete', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number });
  res.json({ ...hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)), pir: result.pir });
});

// The diagram's "Change Closure Approval", gated on change.manage so a
// requester cannot sign off their own change.
router.post('/:id/approve-closure', requirePermission('change.manage'), (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  db.prepare("UPDATE tickets SET closure_approved_by = ?, closure_approved_at = datetime('now') WHERE id = ?").run(req.user.id, ticket.id);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticket.id, 'updated', `Closure approved by ${req.user.name}`
  );
  logAudit(req, { action: 'change.approve_closure', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number });
  res.json(hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)));
});

router.post('/:id/close', agentOnly, idempotent('close'), (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  const result = transition(req.workspaceId, ticket.id, 'closed', { actor: req.user, reason: req.body?.reason || 'Change closed' });
  if (!result.ok) return res.status(400).json({ error: result.error, blockers: result.blockers });
  logAudit(req, { action: 'change.close', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number });
  res.json(hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)));
});

// Generic escape hatch for a change manager correcting a stuck record. Still
// fully audited -- see transition()'s `force` handling.
router.post('/:id/transition', requirePermission('change.manage'), (req, res) => {
  const ticket = getChange(req.params.id, req.workspaceId);
  if (!ticket) return res.status(404).json({ error: 'Change not found' });
  const result = transition(req.workspaceId, ticket.id, req.body?.to, {
    actor: req.user, reason: req.body?.reason, force: !!req.body?.force,
  });
  if (!result.ok) return res.status(400).json({ error: result.error, blockers: result.blockers });
  logAudit(req, { action: 'change.force_transition', entityType: 'ticket', entityId: ticket.id, entityLabel: ticket.number, details: { to: req.body?.to, forced: result.forced } });
  res.json(hydrate(req.workspaceId, getChange(ticket.id, req.workspaceId)));
});

export default router;
