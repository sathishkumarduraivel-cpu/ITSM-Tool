import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { logAudit } from '../services/auditLog.js';
import { ensureDefaultTemplates, sendMail, fillVars } from '../services/emailService.js';
import { SAMPLE_VARS, findTemplateDefault } from '../services/emailTemplateCatalog.js';

const router = Router();
router.use(requireAuth, requireWorkspace, requirePermission('notifications.manage'));

// `variables` (the list that drives the editor's "Insert" palette) only ever
// lived in the static DEFAULT_EMAIL_TEMPLATES catalog, never as a real
// column on the email_templates table -- `SELECT *` alone left every row's
// `variables` undefined, and the editor unconditionally called
// `tpl.variables.map(...)` to render that palette. With no error boundary
// anywhere above it, that TypeError took down the whole admin shell the
// instant a template was opened -- a blank, frozen screen with no visible
// error. Every response that returns a template row goes through this so
// the fix can't be reintroduced by a future route forgetting to attach it.
function withVariables(row) {
  if (!row) return row;
  return { ...row, variables: findTemplateDefault(row.key)?.variables || [] };
}

function getOwned(id, workspaceId) {
  return db.prepare('SELECT * FROM email_templates WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
}

router.get('/', (req, res) => {
  ensureDefaultTemplates(req.workspaceId);
  const rows = db.prepare('SELECT * FROM email_templates WHERE workspace_id = ? ORDER BY category, name').all(req.workspaceId);
  res.json({ templates: rows.map(withVariables) });
});

router.get('/:id', (req, res) => {
  const tpl = getOwned(req.params.id, req.workspaceId);
  if (!tpl) return res.status(404).json({ error: 'Not found' });
  res.json({ template: withVariables(tpl) });
});

// Only content is editable -- key/audience/category/name identify WHICH
// lifecycle event this is and stay fixed, the same "system fields immutable,
// content fields editable" split used for e.g. lifecycle stage keys.
router.patch('/:id', (req, res) => {
  const tpl = getOwned(req.params.id, req.workspaceId);
  if (!tpl) return res.status(404).json({ error: 'Not found' });
  const { subject, body_html, enabled } = req.body;
  const fields = []; const params = [];
  if (subject !== undefined) { fields.push('subject = ?'); params.push(subject); }
  if (body_html !== undefined) { fields.push('body_html = ?'); params.push(body_html); }
  if (enabled !== undefined) { fields.push('enabled = ?'); params.push(enabled ? 1 : 0); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields to update' });
  fields.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE email_templates SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'email_template.updated', entityType: 'email_template', entityId: req.params.id, entityLabel: tpl.name, details: { enabled } });
  res.json({ template: withVariables(getOwned(req.params.id, req.workspaceId)) });
});

// Renders with sample data -- no send, no log entry -- so an admin can see
// exactly what a real recipient would see while still editing.
router.post('/:id/preview', (req, res) => {
  const tpl = getOwned(req.params.id, req.workspaceId);
  if (!tpl) return res.status(404).json({ error: 'Not found' });
  const subject = req.body.subject !== undefined ? req.body.subject : tpl.subject;
  const body = req.body.body_html !== undefined ? req.body.body_html : tpl.body_html;
  res.json({ subject: fillVars(subject, SAMPLE_VARS), html: fillVars(body, SAMPLE_VARS) });
});

router.post('/:id/send-test', async (req, res) => {
  const tpl = getOwned(req.params.id, req.workspaceId);
  if (!tpl) return res.status(404).json({ error: 'Not found' });
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to address required' });
  const subject = fillVars(tpl.subject, SAMPLE_VARS);
  const html = fillVars(tpl.body_html, SAMPLE_VARS);
  const result = await sendMail(req.workspaceId, { to, subject: `[TEST] ${subject}`, html, templateKey: tpl.key });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(result);
});

router.get('/logs/recent', (req, res) => {
  const rows = db.prepare('SELECT * FROM email_log WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100').all(req.workspaceId);
  res.json({ logs: rows });
});

export default router;
