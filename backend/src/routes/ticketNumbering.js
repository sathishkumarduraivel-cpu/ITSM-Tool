import { Router } from 'express';
import { requireAuth, requireWorkspace, requirePermission, requireStaff } from '../middleware/auth.js';
import { getTicketNumberPrefixes, setTicketNumberPrefix } from '../services/ticketNumbering.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

// Only Admin Settings reads this; the numbering scheme is configuration.
router.get('/', requireStaff(), (req, res) => {
  res.json({ prefixes: getTicketNumberPrefixes(req.workspaceId) });
});

// Admin-only -- changing a prefix only affects tickets created from this
// point forward; existing ticket numbers are never rewritten (see
// services/ticketNumbering.js).
router.patch('/', requirePermission('ticket_numbering.manage'), (req, res) => {
  const { type, prefix } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });
  try {
    const prefixes = setTicketNumberPrefix(req.workspaceId, type, prefix);
    logAudit(req, { action: 'ticket_numbering.updated', entityType: 'ticket_numbering', entityId: type, entityLabel: type, details: { prefix: prefixes[type] } });
    res.json({ prefixes });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
