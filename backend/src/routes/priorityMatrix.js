import { Router } from 'express';
import { requireAuth, requireWorkspace, requireStaff, requirePermission } from '../middleware/auth.js';
import {
  PriorityError, getMatrix, setCell, setMatrix, resetMatrix, derivePriority, overrideReport,
} from '../services/priorityMatrix.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
// Authenticated, but not staff-only: the grid is a grading rubric, not
// information. A requester raising a ticket is shown the priority their
// impact and urgency produce, which is honest about how their report will be
// treated -- and they could pick those two values regardless, since the
// server derives from them either way. Writes, and the management view of how
// often agents overrule the grid, stay staff-only below.
router.use(requireAuth, requireWorkspace);

const handle = (res, fn) => {
  try {
    return res.json(fn());
  } catch (e) {
    if (e instanceof PriorityError) {
      const body = { error: e.message };
      if (e.field_errors) body.field_errors = e.field_errors;
      return res.status(e.status).json(body);
    }
    throw e;
  }
};

// Readable by any agent: the grid explains why their ticket is the priority
// it is, and hiding it would make the derivation feel arbitrary.
router.get('/', (req, res) => handle(res, () => getMatrix(req.workspaceId)));

// What the grid would say for a combination, used by the ticket form to show
// the priority before the ticket is saved.
router.get('/derive', (req, res) => handle(res, () => ({
  priority: derivePriority(req.workspaceId, req.query.impact, req.query.urgency),
})));

router.get('/overrides', requireStaff('custom_fields.manage'), (req, res) => handle(res, () => overrideReport(req.workspaceId, {
  days: Math.min(365, Math.max(7, Number(req.query.days) || 90)),
})));

// Changing the grid re-grades every ticket raised from here on, so it is an
// administrative act and audited as one.
router.put('/cell', requireStaff('custom_fields.manage'), requirePermission('custom_fields.manage'), (req, res) => handle(res, () => {
  const { impact, urgency, priority } = req.body;
  const out = setCell(req.workspaceId, impact, urgency, priority);
  logAudit(req, {
    action: 'priority_matrix.updated', entityType: 'priority_matrix', entityId: `${impact}|${urgency}`,
    entityLabel: `${impact} + ${urgency}`, details: `Now grades as ${priority}`,
  });
  return out;
}));

router.put('/', requireStaff('custom_fields.manage'), requirePermission('custom_fields.manage'), (req, res) => handle(res, () => {
  const out = setMatrix(req.workspaceId, req.body.cells);
  logAudit(req, {
    action: 'priority_matrix.updated', entityType: 'priority_matrix', entityId: 'bulk',
    entityLabel: 'Priority grid', details: `${req.body.cells.length} combination(s) changed`,
  });
  return out;
}));

router.post('/reset', requireStaff('custom_fields.manage'), requirePermission('custom_fields.manage'), (req, res) => handle(res, () => {
  const out = resetMatrix(req.workspaceId);
  logAudit(req, {
    action: 'priority_matrix.reset', entityType: 'priority_matrix', entityId: 'all',
    entityLabel: 'Priority grid', details: 'Returned to the baseline',
  });
  return out;
}));

export default router;
