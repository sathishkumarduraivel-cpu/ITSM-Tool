import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import { listCustomFields, slugify } from '../services/customFields.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
// Read is open to any workspace member (needed to render ticket forms);
// create/edit/delete is admin-only, same as the rest of Field Manager/config.
router.use(requireAuth, requireWorkspace);

const FIELD_TYPES = ['text', 'textarea', 'select', 'multiselect'];

router.get('/', (req, res) => {
  const { ticket_type } = req.query;
  if (!ticket_type) return res.status(400).json({ error: 'ticket_type required' });
  res.json({ fields: listCustomFields(req.workspaceId, ticket_type) });
});

router.post('/', requirePermission('custom_fields.manage'), (req, res) => {
  const { ticket_type, label, field_type = 'text', options = [], required = false, sort_order = 0 } = req.body;
  if (!ticket_type || !label) return res.status(400).json({ error: 'ticket_type and label required' });
  if (!FIELD_TYPES.includes(field_type)) return res.status(400).json({ error: 'invalid field_type' });
  if ((field_type === 'select' || field_type === 'multiselect') && (!Array.isArray(options) || options.filter(Boolean).length === 0)) {
    return res.status(400).json({ error: 'At least one option is required for a dropdown field' });
  }

  let field_key = slugify(label);
  const clash = db.prepare(
    'SELECT id FROM ticket_custom_fields WHERE workspace_id = ? AND ticket_type = ? AND field_key = ?'
  ).get(req.workspaceId, ticket_type, field_key);
  if (clash) field_key = `${field_key}_${Date.now().toString(36).slice(-4)}`;

  const id = uid('cf');
  db.prepare(
    'INSERT INTO ticket_custom_fields (id, workspace_id, ticket_type, field_key, label, field_type, options, required, sort_order) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(id, req.workspaceId, ticket_type, field_key, label, field_type, JSON.stringify((options || []).filter(Boolean)), required ? 1 : 0, sort_order);
  logAudit(req, { action: 'custom_field.created', entityType: 'custom_field', entityId: id, entityLabel: label, details: { ticket_type, field_type } });
  res.status(201).json({ id, field_key });
});

router.patch('/:id', requirePermission('custom_fields.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM ticket_custom_fields WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // field_key is intentionally not editable -- Business Rules and already-
  // stored ticket values reference it, so renaming it would silently orphan them.
  const { label, field_type, options, required, sort_order } = req.body;
  const fields = []; const params = [];
  if (label !== undefined) { fields.push('label = ?'); params.push(label); }
  if (field_type !== undefined) {
    if (!FIELD_TYPES.includes(field_type)) return res.status(400).json({ error: 'invalid field_type' });
    fields.push('field_type = ?'); params.push(field_type);
  }
  if (options !== undefined) { fields.push('options = ?'); params.push(JSON.stringify((options || []).filter(Boolean))); }
  if (required !== undefined) { fields.push('required = ?'); params.push(required ? 1 : 0); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); params.push(sort_order); }
  if (!fields.length) return res.status(400).json({ error: 'No valid fields' });
  params.push(req.params.id);
  db.prepare(`UPDATE ticket_custom_fields SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  logAudit(req, { action: 'custom_field.updated', entityType: 'custom_field', entityId: req.params.id, entityLabel: row.label, details: req.body });
  res.json({ ok: true });
});

router.delete('/:id', requirePermission('custom_fields.manage'), (req, res) => {
  const row = db.prepare('SELECT * FROM ticket_custom_fields WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM ticket_custom_fields WHERE id = ?').run(req.params.id);
  logAudit(req, { action: 'custom_field.deleted', entityType: 'custom_field', entityId: req.params.id, entityLabel: row.label });
  // Courtesy cleanup: a Business Rule that targeted or conditioned on this
  // field is dead weight once the field itself no longer exists.
  db.prepare(
    'DELETE FROM ticket_field_rules WHERE workspace_id = ? AND ticket_type = ? AND (field_name = ? OR condition_field = ?)'
  ).run(req.workspaceId, row.ticket_type, row.field_key, row.field_key);
  res.json({ ok: true });
});

export default router;
