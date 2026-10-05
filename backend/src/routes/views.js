import { Router } from 'express';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import {
  ViewError, listViews, getView, createView, updateView, deleteView,
  duplicateView, setPreference, runFilter, viewCounts,
} from '../services/savedViews.js';
import { filterMeta } from '../services/ticketFilters.js';

const router = Router();
// Authenticated but not staff-only: a requester has their own queue too, and
// runFilter forces the ownership restriction regardless of what a view says.
router.use(requireAuth, requireWorkspace);

const handle = (res, fn) => {
  try {
    return res.json(fn());
  } catch (e) {
    if (e instanceof ViewError) {
      const body = { error: e.message };
      if (e.field_errors) body.field_errors = e.field_errors;
      return res.status(e.status).json(body);
    }
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  }
};

// Everything the filter builder needs to render itself: which fields can be
// filtered, which operators each accepts, and the limits.
router.get('/meta', (req, res) => res.json(filterMeta()));

router.get('/', (req, res) => handle(res, () => ({
  views: listViews(req.workspaceId, req.user, { module: req.query.module || 'tickets' }),
})));

router.get('/counts', (req, res) => handle(res, () => ({
  counts: viewCounts(req.workspaceId, req.user, req.query.module || 'tickets'),
})));

// Running a filter is a POST because a condition tree does not belong in a
// query string -- it nests, and it would be truncated and unreadable in logs.
router.post('/run', (req, res) => handle(res, () => runFilter(req.workspaceId, req.user, req.body)));

router.get('/:id', (req, res) => handle(res, () => ({ view: getView(req.workspaceId, req.params.id, req.user) })));

router.get('/:id/run', (req, res) => handle(res, () => {
  const view = getView(req.workspaceId, req.params.id, req.user);
  return {
    view,
    ...runFilter(req.workspaceId, req.user, {
      filters: view.filters, sort_by: view.sort_by, sort_dir: view.sort_dir, limit: req.query.limit,
    }),
  };
}));

router.post('/', (req, res) => {
  try { res.status(201).json({ view: createView(req.workspaceId, req.user, req.body) }); }
  catch (e) {
    if (e instanceof ViewError) return res.status(e.status).json({ error: e.message, field_errors: e.field_errors });
    throw e;
  }
});

router.patch('/:id', (req, res) => handle(res, () => ({ view: updateView(req.workspaceId, req.params.id, req.user, req.body) })));
router.delete('/:id', (req, res) => handle(res, () => deleteView(req.workspaceId, req.params.id, req.user)));

router.post('/:id/duplicate', (req, res) => {
  try { res.status(201).json({ view: duplicateView(req.workspaceId, req.params.id, req.user, req.body?.name) }); }
  catch (e) {
    if (e instanceof ViewError) return res.status(e.status).json({ error: e.message, field_errors: e.field_errors });
    throw e;
  }
});

router.put('/:id/preference', (req, res) => handle(res, () => ({
  views: setPreference(req.workspaceId, req.params.id, req.user, req.body),
})));

export default router;
