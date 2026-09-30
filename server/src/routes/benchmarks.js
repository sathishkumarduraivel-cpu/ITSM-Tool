import { Router } from 'express';
import { requireAuth, requireWorkspace, requireStaff, requireRole } from '../middleware/auth.js';
import {
  BenchmarkError, benchmarkMeta, scorecard, measure,
  listTargets, setTarget, deleteTarget, targetFor,
} from '../services/benchmarks.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace, requireStaff());

const handle = (res, fn) => {
  try {
    return res.json(fn());
  } catch (e) {
    if (e instanceof BenchmarkError) {
      const body = { error: e.message };
      if (e.field_errors) body.field_errors = e.field_errors;
      return res.status(e.status).json(body);
    }
    throw e;
  }
};

// The catalogue, including each KPI's calculation and what its denominator
// actually is -- §19 asks for benchmarks to be reported with their
// denominator definitions, and most arguments about a number are really
// arguments about what was counted.
router.get('/meta', (req, res) => handle(res, () => benchmarkMeta()));

router.get('/', (req, res) => handle(res, () => ({
  scorecard: scorecard(req.workspaceId, { from: req.query.from, to: req.query.to }),
})));

router.get('/targets', (req, res) => handle(res, () => ({ targets: listTargets(req.workspaceId, req.query.kpi) })));

router.get('/:kpi', (req, res) => handle(res, () => ({
  measure: measure(req.workspaceId, req.params.kpi, { from: req.query.from, to: req.query.to }),
  history: listTargets(req.workspaceId, req.params.kpi),
})));

// What were we aiming at on this date? The question versioning exists to
// answer.
router.get('/:kpi/target', (req, res) => handle(res, () => ({
  target: targetFor(req.workspaceId, req.params.kpi, req.query.on),
})));

// Setting a target changes how every past and future report reads, so it is
// an administrative act and audited as one.
router.post('/targets', requireRole('admin'), (req, res) => {
  try {
    const out = setTarget(req.workspaceId, req.user, req.body);
    logAudit(req, {
      action: 'benchmark_target.set', entityType: 'benchmark_target', entityId: req.body.kpi,
      entityLabel: req.body.kpi,
      details: `Target ${req.body.comparator === 'lte' ? 'at most' : 'at least'} ${req.body.target_value} from ${req.body.effective_from || 'today'}`,
    });
    res.status(201).json({ targets: out });
  } catch (e) {
    if (e instanceof BenchmarkError) return res.status(e.status).json({ error: e.message, field_errors: e.field_errors });
    throw e;
  }
});

router.delete('/targets/:id', requireRole('admin'), (req, res) => handle(res, () => {
  const out = deleteTarget(req.workspaceId, req.params.id);
  logAudit(req, {
    action: 'benchmark_target.removed', entityType: 'benchmark_target', entityId: req.params.id,
    entityLabel: 'Benchmark target', details: 'Removed; the previous target came back into force',
  });
  return { targets: out };
}));

export default router;
