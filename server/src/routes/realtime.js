import { Router } from 'express';
import { requireAuth, requireWorkspace } from '../middleware/auth.js';
import { subscribe } from '../services/realtime.js';

const router = Router();

// GET, not router.use(requireAuth, requireWorkspace) at the top, so the
// query-param token path in requireAuth (see middleware/auth.js) only ever
// applies to this exact route.
router.get('/stream', requireAuth, requireWorkspace, (req, res) => {
  subscribe(req.workspaceId, req.user.id, res);
  // subscribe() takes ownership of `res` from here -- it writes the SSE
  // headers itself and keeps the connection open until the client
  // disconnects, so there's nothing left to send from this handler.
});

export default router;
