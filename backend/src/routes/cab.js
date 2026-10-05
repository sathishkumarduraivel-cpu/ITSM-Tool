import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireWorkspace, requireRole, requirePermission } from '../middleware/auth.js';
import {
  listMeetings, createMeeting, addToAgenda, removeFromAgenda, decideAgendaItem,
  setMeetingStatus, markAttendance, awaitingCab, cabGroup, ecabGroup,
} from '../services/changeApproval.js';
import { transition } from '../services/changeWorkflow.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

const agentOnly = requireRole('agent', 'admin');

// Readable by any signed-in member -- knowing when the CAB sits and what is
// on the agenda is information the whole team needs. Running a meeting is
// gated below.
router.get('/meetings', (req, res) => {
  res.json({
    meetings: listMeetings(req.workspaceId, {
      from: req.query.from || new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
      status: req.query.status || null,
      limit: Number(req.query.limit) || 50,
    }),
  });
});

// The chair's backlog: changes waiting on the CAB and not yet on an open
// agenda, riskiest first.
router.get('/backlog', (req, res) => {
  res.json({ backlog: awaitingCab(req.workspaceId) });
});

router.get('/boards', (req, res) => {
  const withMembers = (group) => ({
    ...group,
    members: db.prepare(
      `SELECT u.id, u.name, u.email FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY u.name`
    ).all(group.id),
  });
  res.json({ cab: withMembers(cabGroup(req.workspaceId)), ecab: withMembers(ecabGroup(req.workspaceId)) });
});

router.use(agentOnly);

router.post('/meetings', (req, res) => {
  const result = createMeeting(req.workspaceId, { ...req.body, actorId: req.user.id });
  if (!result.ok) return res.status(400).json({ error: result.error });
  logAudit(req, { action: 'cab_meeting.create', entityType: 'cab_meeting', entityId: result.meetingId, entityLabel: req.body?.title });
  res.status(201).json({ meetings: listMeetings(req.workspaceId, { from: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString() }), meetingId: result.meetingId });
});

router.post('/meetings/:id/agenda', (req, res) => {
  const result = addToAgenda(req.workspaceId, req.params.id, req.body?.ticket_id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});

router.delete('/agenda/:itemId', (req, res) => {
  const result = removeFromAgenda(req.workspaceId, req.params.itemId);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

// The board's collective decision on one change. Applies straight through to
// that change's approval queue and moves its state, so the meeting record
// and the change can never disagree.
router.post('/agenda/:itemId/decide', (req, res) => {
  const item = db.prepare(
    'SELECT ai.*, m.workspace_id FROM cab_agenda_items ai JOIN cab_meetings m ON m.id = ai.meeting_id WHERE ai.id = ? AND m.workspace_id = ?'
  ).get(req.params.itemId, req.workspaceId);
  if (!item) return res.status(404).json({ error: 'Agenda item not found' });

  const result = decideAgendaItem(req.workspaceId, req.params.itemId, {
    decision: req.body?.decision,
    conditions: req.body?.conditions,
    notes: req.body?.notes,
    actor: req.user,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });

  if (result.rejected) {
    transition(req.workspaceId, item.ticket_id, 'new', { actor: req.user, reason: `Rejected by the CAB${req.body?.notes ? `: ${req.body.notes}` : ''}` });
  } else if (result.fullyApproved) {
    transition(req.workspaceId, item.ticket_id, 'approved', { actor: req.user, reason: 'Approved by the CAB' });
  }

  logAudit(req, { action: 'cab.decision', entityType: 'ticket', entityId: item.ticket_id, details: { decision: req.body?.decision } });
  res.json(result);
});

router.patch('/meetings/:id/status', (req, res) => {
  const result = setMeetingStatus(req.workspaceId, req.params.id, req.body?.status, { minutes: req.body?.minutes ?? null });
  if (!result.ok) return res.status(400).json({ error: result.error });
  logAudit(req, { action: 'cab_meeting.status', entityType: 'cab_meeting', entityId: req.params.id, details: { status: req.body?.status } });
  res.json(result);
});

router.post('/meetings/:id/attendance', (req, res) => {
  const result = markAttendance(req.workspaceId, req.params.id, req.body?.user_id, !!req.body?.present);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

// Board membership is real group membership, so it is managed through the
// same Groups mechanism rather than a second roster to keep in step.
router.post('/boards/:kind/members', requirePermission('change.manage'), (req, res) => {
  const { kind } = req.params;
  if (!['cab', 'ecab'].includes(kind)) return res.status(400).json({ error: 'kind must be cab or ecab' });
  const group = kind === 'ecab' ? ecabGroup(req.workspaceId) : cabGroup(req.workspaceId);

  const userIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids : null;
  if (!userIds) return res.status(400).json({ error: 'user_ids array is required' });

  const eligible = new Set(db.prepare(
    `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND role IN ('admin','agent') AND active = 1`
  ).all(req.workspaceId).map((r) => r.user_id));
  const rejected = userIds.filter((id) => !eligible.has(id));
  if (rejected.length) return res.status(400).json({ error: `${rejected.length} user(s) cannot sit on a board in this workspace` });

  db.prepare('DELETE FROM group_members WHERE group_id = ?').run(group.id);
  for (const userId of userIds) {
    db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(
      `gm_${group.id.slice(-6)}_${userId.slice(-8)}`, group.id, userId
    );
  }
  logAudit(req, { action: 'cab.board_membership', entityType: 'group', entityId: group.id, entityLabel: group.name, details: { count: userIds.length } });
  res.json({ ok: true, group: group.name, members: userIds.length });
});

export default router;
