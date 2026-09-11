import { Router } from 'express';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import { settingsForApi, upsertEmailSettings, testEmailConfig } from '../services/emailService.js';

const router = Router();
router.use(requireAuth, requireWorkspace, requirePermission('notifications.manage'));

router.get('/', (req, res) => {
  res.json({ settings: settingsForApi(req.workspaceId) });
});

router.put('/', (req, res) => {
  const { enabled, host, port, secure, username, password, from_name, from_email, reply_to, footer_html } = req.body;
  if (enabled && (!host || !from_email)) {
    return res.status(400).json({ error: 'Host and from-address are required to enable outbound email' });
  }
  const settings = upsertEmailSettings(req.workspaceId, { enabled, host, port, secure, username, password, from_name, from_email, reply_to, footer_html });
  logAudit(req, { action: 'email_settings.updated', entityType: 'email_settings', details: { enabled: !!enabled, host } });
  res.json({ settings });
});

router.post('/test', async (req, res) => {
  const { to, ...draft } = req.body;
  if (!to) return res.status(400).json({ error: 'to address required' });
  const result = await testEmailConfig(req.workspaceId, draft, to);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

export default router;
